import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, REACTION_LIMITS, createIdentity, createLink, identityFromSeedB64, type PairingState, type WireReaction } from "@ghostly/core";
import { GhostlyNode, type NodeEvents } from "../src/engine/node";
import { db } from "../src/engine/db";
import { Reactions, latestReaction } from "../src/engine/reactions";
import type { AttentionEvent } from "../src/shared/rpc";
import type { StoredMessage } from "../src/shared/types";
import { FakeNativeNet } from "./helpers/fakeNative";
// covers: chat.reactions.wire, groups.protocol.reactions

/**
 * Reactions in the engine (WISP 400 § Reactions): a real node and its contact's link over a stand-in for Iroh. What the
 * node says names a message as both sides know it and waits until the contact confirms it; what it receives is kept on
 * the row, one per person, the highest number winning.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function setup(contactOptions: { reactionsSupport?: boolean; take?: boolean; onMessageChanges?: NodeEvents["onMessageChanges"]; onMessages?: NodeEvents["onMessages"] } = {}) {
  const net = new FakeNativeNet();
  const invitation = createLink();
  const [mine, theirs] = [createIdentity().seedB64, createIdentity().seedB64];
  const id = `reactions-${crypto.randomUUID()}`;
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink({ ...invitation.mine, id, profile: "paired-chat/1", participationSeed: mine, createdAt: 1,
    pairedPeerKey: identityFromSeedB64(theirs).pubKeyZ32, peerTrust: { version: 1 },
    peerTransports: ["iroh/1"], peerFallback: true, preferredTransport: "iroh/1", transportFallback: true,
    peerDescriptors: { "iroh/1": { id: "contact:iroh/1" } } });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const attention: AttentionEvent[] = [];
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: contactOptions.onMessages ?? vi.fn(), onCallSignal: vi.fn(), onAttention: event => { attention.push(event); },
    ...(contactOptions.onMessageChanges && { onMessageChanges: contactOptions.onMessageChanges }) },
    { transport, automaticWallets: false, nativeTransports: { "iroh/1": async () => net.endpoint("iroh/1", "app") } });
  let contactState: PairingState = { status: "connecting" };
  const contactGot: WireReaction[] = [];
  const receipts: number[] = [];
  const contact = new GhostLink({
    params: { ...invitation.invite, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: theirs, peerKey: identityFromSeedB64(mine).pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true, peerTransports: ["iroh/1"], peerFallback: true, peerDescriptors: { "iroh/1": { id: "app:iroh/1" } } },
    transport, createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    reactionsSupport: contactOptions.reactionsSupport ?? true,
    events: {
      onPairingState: state => { contactState = state; },
      onReaction: reaction => { contactGot.push(reaction); return contactOptions.take ?? true; },
      onReactionReceipt: n => { receipts.push(n); },
    },
  });
  contact.registerEndpoint(net.endpoint("iroh/1", "contact"));
  cleanup.push(async () => { await contact.stop(false); await node.shutdown(); await db.deleteLink(id); });
  await node.start();
  node.setActiveLink({ linkId: id });
  const view = () => node.getState().links.find(l => l.id === id)!;
  await vi.waitFor(() => expect(view().availableTransports).toHaveLength(1));
  void contact.connect(5_000).catch(() => {});
  await vi.waitFor(() => expect([view().pairing?.status, contactState.status]).toEqual(["ready", "ready"]));
  const messages = () => db.getMessages(id);
  const row = async (text: string) => { await vi.waitFor(async () => expect((await messages()).find(m => m.text === text)).toBeDefined()); return (await messages()).find(m => m.text === text)!; };
  const pending = async () => (await db.getLinks()).find(l => l.id === id)?.reactionsOut ?? [];
  const agreed = () => vi.waitFor(() => expect(contact.supportsReactions).toBe(contactOptions.reactionsSupport ?? true));
  return { node, contact, id, contactGot, receipts, attention, messages, row, view, pending, agreed };
}

describe("what the pages hear", () => {
  it("is the row that changed, never the whole history, when the host takes changes; a host that does not gets the whole", async () => {
    const changes: [string, { messages: StoredMessage[]; deleted: string[] }][] = [];
    const whole = vi.fn();
    const t = await setup({ onMessageChanges: (linkId, change) => { changes.push([linkId, change]); }, onMessages: whole });
    await t.agreed();
    expect(await t.contact.sendMessage("first")).toBeNull();
    expect(await t.contact.sendMessage("second")).toBeNull();
    const second = await t.row("second");
    await vi.waitFor(() => expect(changes.map(([, c]) => c.messages.map(m => m.text))).toEqual([["first"], ["second"]]));
    expect(changes.every(([linkId, c]) => linkId === t.id && !c.deleted.length)).toBe(true);

    changes.length = 0;
    expect(await t.node.react({ linkId: t.id, messageId: second.id, emoji: "👍" })).toEqual({ error: null });
    expect(changes).toHaveLength(1);
    expect(changes[0]![1].messages.map(m => [m.id, m.reactions?.me?.e])).toEqual([[second.id, "👍"]]);

    changes.length = 0;
    t.node.deleteMessage({ linkId: t.id, messageId: second.id });
    await vi.waitFor(() => expect(changes).toEqual([[t.id, { messages: [], deleted: [second.id] }]]));
    expect(t.view().lastMessageAt).toBe((await t.row("first")).timestamp);
    expect(whole).not.toHaveBeenCalled();
  });
});

describe("reacting over the live link", () => {
  it("names the contact's message by its wire id, shows it here at once and keeps it until the contact confirms it", async () => {
    const t = await setup();
    await t.agreed();
    expect(await t.contact.sendMessage("lunch at noon?")).toBeNull();
    const original = await t.row("lunch at noon?");
    expect(await t.node.react({ linkId: t.id, messageId: original.id, emoji: "👍" })).toEqual({ error: null });
    expect((await t.row("lunch at noon?")).reactions?.me).toMatchObject({ e: "👍" });
    await vi.waitFor(() => expect(t.contactGot).toHaveLength(1));
    expect(t.contactGot[0]).toMatchObject({ id: original.id.replace(/^peer_/, ""), e: "👍" });
    await vi.waitFor(async () => expect(await t.pending()).toEqual([]));
    expect(t.view().lastReaction).toMatchObject({ by: "me", emoji: "👍", snippet: "lunch at noon?", mine: false });
    // A reaction to someone else's message is no news to anyone here.
    expect(t.attention.filter(e => e.type === "reaction")).toEqual([]);
  });

  it("replaces, then takes back: each with a higher number, the contact sees the latest", async () => {
    const t = await setup();
    await t.agreed();
    await t.contact.sendMessage("hey");
    const original = await t.row("hey");
    await t.node.react({ linkId: t.id, messageId: original.id, emoji: "👍" });
    await t.node.react({ linkId: t.id, messageId: original.id, emoji: "❤" });
    await t.node.react({ linkId: t.id, messageId: original.id, emoji: "" });
    await vi.waitFor(() => expect(t.contactGot.map(r => r.e)).toEqual(["👍", "❤️", ""]));
    const [a, b, c] = t.contactGot.map(r => r.n);
    expect(a < b && b < c).toBe(true);
    expect((await t.row("hey")).reactions?.me).toMatchObject({ e: "", n: c });
    await vi.waitFor(async () => expect(await t.pending()).toEqual([]));
    // Nothing of mine to take back now.
    expect((await t.node.react({ linkId: t.id, messageId: original.id, emoji: "" })).error).toBeTruthy();
  });

  it("refuses what is not one emoji, or not a message of this chat", async () => {
    const t = await setup();
    await t.contact.sendMessage("hi");
    const original = await t.row("hi");
    await db.addMessage({ linkId: "another-chat", id: "me_other", wireId: "O".repeat(22), text: "x", sender: "me", timestamp: 1, via: "datalink" });
    for (const emoji of ["ok", "👍👍", "a👍", "x".repeat(64)]) expect((await t.node.react({ linkId: t.id, messageId: original.id, emoji })).error).toBeTruthy();
    for (const messageId of ["me_other", "O".repeat(22), "nope", ""]) expect((await t.node.react({ linkId: t.id, messageId, emoji: "👍" })).error).toBeTruthy();
    expect((await t.node.react({ linkId: "no-such-chat", messageId: original.id, emoji: "👍" })).error).toBeTruthy();
    expect(await t.pending()).toEqual([]);
  });

  it("a contact's reaction lands on the row under `peer`, the latest number winning, and mine stays mine", async () => {
    const t = await setup();
    await t.agreed();
    const sent = await t.node.sendMessage({ linkId: t.id, text: "the plan: friday" });
    const mine = (await t.messages()).find(m => m.id === sent.messageId)!;
    await t.node.react({ linkId: t.id, messageId: mine.id, emoji: "🙏" });
    expect(t.contact.sendReaction({ id: mine.wireId!, e: "😂", n: 50 })).toBeNull();
    await vi.waitFor(() => expect(t.receipts).toContain(50));
    // An older one arriving late changes nothing, and is still confirmed.
    expect(t.contact.sendReaction({ id: mine.wireId!, e: "😢", n: 40 })).toBeNull();
    await vi.waitFor(() => expect(t.receipts).toContain(40));
    let row = await t.row("the plan: friday");
    expect(row.reactions?.peer).toMatchObject({ e: "😂", n: 50 });
    expect(row.reactions?.me).toMatchObject({ e: "🙏" });
    // Taken back: kept as empty, so an older one cannot bring it back.
    t.contact.sendReaction({ id: mine.wireId!, e: "", n: 60 });
    t.contact.sendReaction({ id: mine.wireId!, e: "😮", n: 55 });
    await vi.waitFor(() => expect(t.receipts).toContain(55));
    row = await t.row("the plan: friday");
    expect(row.reactions?.peer).toMatchObject({ e: "", n: 60 });
    // Someone reacted to my message: one quiet notice for the 😂, none for what changed nothing.
    expect(t.attention.filter(e => e.type === "reaction")).toHaveLength(1);
    expect(t.attention.find(e => e.type === "reaction")?.linkId).toBe(t.id);
    expect(t.attention.filter(e => e.type === "message")).toEqual([]);
  });

  it("a reaction to a message not here yet waits for it", async () => {
    const t = await setup();
    await t.agreed();
    const wire = "W".repeat(22);
    t.contact.sendReaction({ id: wire, e: "😮", n: 7 });
    await vi.waitFor(() => expect(t.receipts).toContain(7));
    expect(await t.contact.sendMessage("surprise", Date.now(), wire)).toBeNull();
    await vi.waitFor(async () => expect((await t.row("surprise")).reactions?.peer).toMatchObject({ e: "😮", n: 7 }));
  });

  it("an older app gets nothing on the session: the reaction waits here (and rides on the DHT envelopes meanwhile)", async () => {
    const t = await setup({ reactionsSupport: false });
    await vi.waitFor(() => expect(t.contact.sessionOffers.peer).not.toBeNull());
    await t.contact.sendMessage("old app");
    const original = await t.row("old app");
    expect(await t.node.react({ linkId: t.id, messageId: original.id, emoji: "👍" })).toEqual({ error: null });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(t.contactGot).toEqual([]);
    expect(await t.pending()).toHaveLength(1);
    expect((await t.row("old app")).reactions?.me).toMatchObject({ e: "👍" });
  });

  it("what the contact did not take is said again on its next session", async () => {
    const t = await setup({ take: false });
    await t.agreed();
    await t.contact.sendMessage("again");
    const original = await t.row("again");
    await t.node.react({ linkId: t.id, messageId: original.id, emoji: "👍" });
    await vi.waitFor(() => expect(t.contactGot).toHaveLength(1));
    expect(await t.pending()).toHaveLength(1);
  });
});

describe("the reactions store", () => {
  const row = (fields: Partial<StoredMessage>): StoredMessage => ({ linkId: "group:g", id: "x", text: "", sender: "peer", timestamp: 1, via: "datalink", ...fields });
  function memory(rows: StoredMessage[]) {
    const changed: string[] = [];
    let now = 1_000;
    const host = {
      messages: async (chat: string) => rows.filter(r => r.linkId === chat),
      patch: async (chat: string, id: string, change: (m: StoredMessage) => Partial<StoredMessage> | null) => {
        const i = rows.findIndex(r => r.linkId === chat && r.id === id);
        if (i < 0) return undefined;
        const patch = change(rows[i]);
        if (patch) rows[i] = { ...rows[i], ...patch };
        return rows[i];
      },
      changed: (chat: string) => { changed.push(chat); },
      notify: vi.fn(),
      now: () => now,
    };
    return { reactions: new Reactions(host), host, changed, tick: (ms: number) => { now += ms; } };
  }

  it("finds the message a reaction names by its row alone when it can, else in the whole chat, and tells which row changed", async () => {
    const rows = [
      row({ linkId: "chat", id: "peer_AAAAAAAAAAAAAAAA", text: "theirs" }),
      row({ linkId: "chat", id: "me_BBBBBBBBBBBBBBBB", sender: "me", text: "mine" }),
      row({ linkId: "chat", id: "me_1", sender: "me", text: "a file", wireId: "fileWireId01" }),
      row({ id: "k:0:1", member: "k", text: "in the group" }),
    ];
    const { reactions, host } = memory(rows);
    const whole = vi.spyOn(host, "messages");
    const changedRows: string[] = [];
    Object.assign(host, {
      message: async (chat: string, id: string) => rows.find(r => r.linkId === chat && r.id === id),
      changed: (chat: string, id: string) => { changedRows.push(`${chat} ${id}`); },
    });
    expect(await reactions.receive("chat", "peer", { id: "AAAAAAAAAAAAAAAA", e: "👍", n: 1 })).toBe("applied");
    expect(await reactions.receive("chat", "peer", { id: "BBBBBBBBBBBBBBBB", e: "😂", n: 2 })).toBe("applied");
    expect(await reactions.receive("group:g", "p", { id: "k:0:1", e: "🙏", n: 1 })).toBe("applied");
    expect(whole).not.toHaveBeenCalled();
    expect(await reactions.receive("chat", "peer", { id: "fileWireId01", e: "❤️", n: 3 })).toBe("applied");
    expect(whole).toHaveBeenCalledOnce();
    expect(changedRows).toEqual(["chat peer_AAAAAAAAAAAAAAAA", "chat me_BBBBBBBBBBBBBBBB", "group:g k:0:1", "chat me_1"]);
    expect(rows.map(r => Object.values(r.reactions ?? {})[0]?.e)).toEqual(["👍", "😂", "❤️", "🙏"]);
  });

  it("takes at most REACTION_LIMITS.receive a window from one group member", async () => {
    const [ana, bo] = [createIdentity().pubKeyZ32, createIdentity().pubKeyZ32];
    const rows = [row({ id: `${ana}:0:1`, member: ana, text: "hello group" })];
    const { reactions, tick } = memory(rows);
    const outcomes: string[] = [];
    for (let n = 1; n <= REACTION_LIMITS.receive + 5; n++) outcomes.push(await reactions.receive("group:g", bo, { id: `${ana}:0:1`, e: "👍", n }));
    expect(outcomes.filter(o => o === "applied")).toHaveLength(REACTION_LIMITS.receive);
    expect(outcomes.slice(-5)).toEqual(Array(5).fill("dropped"));
    // Another member has a window of its own, and the window passes.
    expect(await reactions.receive("group:g", ana, { id: `${ana}:0:1`, e: "😂", n: 1 })).toBe("applied");
    tick(REACTION_LIMITS.windowMs);
    expect(await reactions.receive("group:g", bo, { id: `${ana}:0:1`, e: "🙏", n: 100 })).toBe("applied");
  });

  it("keeps one reaction per member per message in a group, by member key", async () => {
    const [ana, bo] = [createIdentity().pubKeyZ32, createIdentity().pubKeyZ32];
    const rows = [row({ id: `${ana}:0:1`, member: ana, text: "hello group" }), row({ id: `${bo}:0:1`, member: bo, sender: "me", text: "mine" })];
    const { reactions, host, tick } = memory(rows);
    expect(await reactions.receive("group:g", bo, { id: `${ana}:0:1`, e: "👍", n: 5 })).toBe("applied");
    expect(await reactions.receive("group:g", ana, { id: `${ana}:0:1`, e: "😂", n: 3 })).toBe("applied");
    expect(await reactions.receive("group:g", bo, { id: `${ana}:0:1`, e: "🙏", n: 4 })).toBe("stale");
    expect(rows[0].reactions).toMatchObject({ [bo]: { e: "👍", n: 5 }, [ana]: { e: "😂", n: 3 } });
    // A reaction to my message: a notice; to someone else's: none.
    expect(host.notify).not.toHaveBeenCalled();
    tick(1);
    await reactions.receive("group:g", ana, { id: `${bo}:0:1`, e: "❤️", n: 9 });
    expect(host.notify).toHaveBeenCalledTimes(1);
    expect(latestReaction(rows)).toMatchObject({ by: ana, emoji: "❤️", snippet: "mine", mine: true });
    // Mine, by the message's id here, in a group.
    const out = await reactions.mine("group:g", `${ana}:0:1`, "🙏");
    expect(out).toMatchObject({ reaction: { id: `${ana}:0:1`, e: "🙏" } });
    expect(rows[0].reactions?.me?.e).toBe("🙏");
  });

  it("a reaction waits a minute for its message, the newest per person, and then is dropped", async () => {
    const rows: StoredMessage[] = [];
    const { reactions, tick } = memory(rows);
    expect(await reactions.receive("group:g", "p", { id: "k:0:1", e: "👍", n: 2 })).toBe("waiting");
    expect(await reactions.receive("group:g", "p", { id: "k:0:1", e: "😂", n: 1 })).toBe("stale");
    expect(await reactions.receive("group:g", "p", { id: "k:0:1", e: "😮", n: 3 })).toBe("waiting");
    rows.push(row({ id: "k:0:1", member: "k" }));
    await reactions.stored(rows[0]);
    expect(rows[0].reactions?.p).toMatchObject({ e: "😮", n: 3 });
    expect(await reactions.receive("group:g", "p", { id: "k:0:2", e: "👍", n: 4 })).toBe("waiting");
    tick(61_000);
    rows.push(row({ id: "k:0:2", member: "k" }));
    await reactions.stored(rows[1]);
    expect(rows[1].reactions).toBeUndefined();
  });

  it("has room for so many waiting per chat", async () => {
    const { reactions } = memory([]);
    for (let i = 0; i < 64; i++) expect(await reactions.receive("group:g", `m${i}`, { id: "k:0:1", e: "👍", n: 1 })).toBe("waiting");
    expect(await reactions.receive("group:g", "one-more", { id: "k:0:1", e: "👍", n: 1 })).toBe("dropped");
  });

  it("numbers mine past what waits to be confirmed, even when the clock goes back", async () => {
    const rows = [row({ linkId: "l", id: `peer_${"A".repeat(22)}` })];
    const { reactions } = memory(rows);
    const out = await reactions.mine("l", rows[0].id, "👍", [{ id: "B".repeat(22), e: "😂", n: 5_000 }]);
    expect(out).toMatchObject({ reaction: { id: "A".repeat(22), n: 5_001 } });
  });
});
