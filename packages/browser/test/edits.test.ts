import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DhtDelivery, EDIT_BUFFER_MS, EDIT_SEND_LIMIT, GhostLink, MAX_EDITS_PER_MESSAGE, createIdentity, createLink, createRelayPayload, dhtEditId, identityFromSeedB64, parseRelayPayload, type IncomingMessage, type PairingState, type SignedPacket, type WireEdit } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { EditBuffer, EditQueue } from "../src/engine/edits";
import { EDIT_HISTORY_KEEP, EDIT_HISTORY_MAX_BYTES, canEdit, takesPeerEdit, withEdit } from "../src/shared/edits";
import type { StoredMessage } from "../src/shared/types";
import { FakeNativeNet } from "./helpers/fakeNative";
// covers: chat.edit.wire

/**
 * Edits in the engine (WISP 400 § Edits): a real node and its contact's link over a stand-in for Iroh. The node edits
 * its own texts and the contact is told; the contact's edits change only the contact's messages, the highest number
 * wins, and one that came before its message waits for it.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function setup(contactOptions: { editSupport?: boolean; confirm?: () => boolean } = {}) {
  const net = new FakeNativeNet();
  const invitation = createLink();
  const [mine, theirs] = [createIdentity().seedB64, createIdentity().seedB64];
  const id = `edits-${crypto.randomUUID()}`;
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink({ ...invitation.mine, id, profile: "paired-chat/1", participationSeed: mine, createdAt: 1,
    pairedPeerKey: identityFromSeedB64(theirs).pubKeyZ32, peerTrust: { version: 1 },
    peerTransports: ["iroh/1"], peerFallback: true, preferredTransport: "iroh/1", transportFallback: true,
    peerDescriptors: { "iroh/1": { id: "contact:iroh/1" } } });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const onAttention = vi.fn();
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention }, { transport, automaticWallets: false,
    nativeTransports: { "iroh/1": async () => net.endpoint("iroh/1", "app") } });
  let contactState: PairingState = { status: "connecting" };
  const contactGot: IncomingMessage[] = [];
  const contactEdits: WireEdit[] = [], contactReceipts: [string, number][] = [];
  const contact = new GhostLink({
    params: { ...invitation.invite, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: theirs, peerKey: identityFromSeedB64(mine).pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true, peerTransports: ["iroh/1"], peerFallback: true, peerDescriptors: { "iroh/1": { id: "app:iroh/1" } } },
    transport, createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    editSupport: contactOptions.editSupport ?? true,
    events: { onPairingState: state => { contactState = state; }, onMessage: message => { contactGot.push(message); },
      onMessageEdit: edit => { contactEdits.push(edit); return contactOptions.confirm?.() ?? true; }, onEditReceipt: (id, e) => { contactReceipts.push([id, e]); } },
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
  const peerRow = async (text: string) => { await vi.waitFor(async () => expect((await messages()).find(m => m.text === text)).toBeDefined()); return (await messages()).find(m => m.text === text)!; };
  const row = async (messageId: string) => (await messages()).find(m => m.id === messageId)!;
  return { node, contact, id, contactGot, contactEdits, contactReceipts, messages, peerRow, row, view, onAttention };
}

const WIRE = (c: string) => c.repeat(22);

describe("editing my message", () => {
  it("shows the new text here at once, tells the contact each edit, and the confirmations settle it", async () => {
    const t = await setup();
    const sent = await t.node.sendMessage({ linkId: t.id, text: "Working…" });
    await vi.waitFor(async () => expect((await t.row(sent.messageId!)).delivery).toBe("delivered"));
    for (const step of ["Step 1 of 3", "Step 2 of 3", "Done"]) {
      expect(await t.node.editMessage({ linkId: t.id, messageId: sent.messageId!, text: step })).toEqual({ error: null, messageId: sent.messageId });
      expect((await t.row(sent.messageId!)).text).toBe(step);
    }
    await vi.waitFor(() => expect(t.contactEdits.map(e => [e.e, e.m])).toEqual([[1, "Step 1 of 3"], [2, "Step 2 of 3"], [3, "Done"]]));
    const mine = await t.row(sent.messageId!);
    expect(t.contactEdits.every(e => e.id === mine.wireId)).toBe(true);
    await vi.waitFor(async () => expect((await t.row(sent.messageId!)).edit?.pending).toBeUndefined());
    expect((await t.row(sent.messageId!)).edit).toMatchObject({ seq: 3, history: [{ text: "Working…" }, { text: "Step 1 of 3" }, { text: "Step 2 of 3" }] });
    // Its wire id works as well as its id here (what a bot keeps from `send`).
    expect(await t.node.editMessage({ linkId: t.id, messageId: mine.wireId!, text: "Done!" })).toMatchObject({ error: null, messageId: sent.messageId });
  });

  it("refuses what cannot be edited: the contact's messages, files, payments, notices, empty text, the 101st edit", async () => {
    const t = await setup();
    expect(await t.contact.sendMessage("theirs")).toBeNull();
    const theirs = await t.peerRow("theirs");
    const refused = async (messageId: string, text = "x") => expect(await t.node.editMessage({ linkId: t.id, messageId, text })).toMatchObject({ refused: true });
    await refused(theirs.id);
    await refused("nope");
    await db.addMessage({ linkId: t.id, id: "me_file", wireId: WIRE("F"), text: "📎 a.txt", sender: "me", timestamp: 1, via: "datalink", file: { id: `${t.id}-out-x`, name: "a.txt", size: 1, mime: "text/plain" } });
    await refused("me_file");
    await db.addMessage({ linkId: t.id, id: "me_pay", wireId: WIRE("P"), text: "⚡ 10 sats", sender: "me", timestamp: 1, via: "datalink", paymentId: "pay-12345678" });
    await refused("me_pay");
    await db.addMessage({ linkId: t.id, id: `me_${WIRE("J")}`, wireId: WIRE("J"), text: "👋 Alice joined", sender: "me", timestamp: 1, via: "datalink" });
    await refused(`me_${WIRE("J")}`);
    const sent = await t.node.sendMessage({ linkId: t.id, text: "short" });
    await refused(sent.messageId!, "   ");
    await refused(sent.messageId!, "x".repeat(16 * 1024 + 1));
    // The same text again changes nothing.
    expect(await t.node.editMessage({ linkId: t.id, messageId: sent.messageId!, text: "short" })).toEqual({ error: null, messageId: sent.messageId });
    expect((await t.row(sent.messageId!)).edit).toBeUndefined();
    await db.patchMessage(t.id, sent.messageId!, m => ({ edit: { seq: MAX_EDITS_PER_MESSAGE, at: 1, history: [] }, text: m.text }));
    await refused(sent.messageId!, "one more");
  });

  it("waits for a contact whose app does not offer edit/1, and nothing is sent to it", async () => {
    const t = await setup({ editSupport: false });
    const sent = await t.node.sendMessage({ linkId: t.id, text: "status: 1" });
    await vi.waitFor(async () => expect((await t.row(sent.messageId!)).delivery).toBe("delivered"));
    expect((await t.node.editMessage({ linkId: t.id, messageId: sent.messageId!, text: "status: 2" })).error).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(t.contactEdits).toEqual([]);
    // Shown here, not confirmed: the contact keeps the text it has, and gets no second message.
    expect(await t.row(sent.messageId!)).toMatchObject({ text: "status: 2", edit: { seq: 1, pending: true } });
    expect(t.contactGot.map(m => m.text)).toEqual(["status: 1"]);
  });
});

describe("the contact's edits", () => {
  it("change its message, the highest number winning whatever order they come in; no sound, no move", async () => {
    const t = await setup();
    const at = Date.now() - 60_000;
    expect(await t.contact.sendMessage("v0", at, WIRE("A"))).toBeNull();
    const original = await t.peerRow("v0");
    const lastMessageAt = t.view().lastMessageAt;
    t.onAttention.mockClear();
    expect(await t.contact.sendEdit({ id: WIRE("A"), e: 3, ts: Date.now(), m: "v3" })).toBeNull();
    expect(await t.contact.sendEdit({ id: WIRE("A"), e: 2, ts: Date.now(), m: "v2" })).toBeNull();
    await vi.waitFor(() => expect(t.contactReceipts).toEqual([[WIRE("A"), 3], [WIRE("A"), 2]]));
    const edited = await t.row(original.id);
    expect(edited).toMatchObject({ text: "v3", edit: { seq: 3, history: [{ at: original.timestamp, text: "v0" }] } });
    expect(edited.edit?.pending).toBeUndefined();
    expect(t.view().lastMessageAt).toBe(lastMessageAt);
    expect(t.onAttention).not.toHaveBeenCalled();
    // A later one still goes on top.
    await t.contact.sendEdit({ id: WIRE("A"), e: 4, ts: Date.now(), m: "v4 https://ghostly.tools/", pv: { u: "https://ghostly.tools/", t: "Ghostly" } });
    await vi.waitFor(async () => expect((await t.row(original.id)).text).toBe("v4 https://ghostly.tools/"));
    expect((await t.row(original.id)).preview).toEqual({ u: "https://ghostly.tools/", t: "Ghostly" });
    expect((await t.row(original.id)).edit?.history.map(v => v.text)).toEqual(["v0", "v3"]);
  });

  it("never change one of my messages: an edit naming my wire id waits for a message of the contact's that never comes", async () => {
    const t = await setup();
    const sent = await t.node.sendMessage({ linkId: t.id, text: "mine" });
    const mine = await t.row(sent.messageId!);
    await t.contact.sendEdit({ id: mine.wireId!, e: 1, ts: Date.now(), m: "forged" });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect((await t.row(sent.messageId!)).text).toBe("mine");
    expect((await t.row(sent.messageId!)).edit).toBeUndefined();
    expect(t.contactReceipts).toEqual([]);
  });

  it("an edit before its message waits for it, then shows and is confirmed", async () => {
    const t = await setup();
    await t.contact.sendEdit({ id: WIRE("B"), e: 1, ts: Date.now(), m: "later text" });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(t.contactReceipts).toEqual([]);
    expect(await t.contact.sendMessage("first text", Date.now(), WIRE("B"))).toBeNull();
    await vi.waitFor(() => expect(t.contactReceipts).toEqual([[WIRE("B"), 1]]));
    const row = (await t.messages()).find(m => m.id === `peer_${WIRE("B")}`)!;
    expect(row).toMatchObject({ text: "later text", edit: { seq: 1, history: [{ text: "first text" }] } });
  });

  it("an edit of a message deleted here is confirmed and brings nothing back", async () => {
    const t = await setup();
    expect(await t.contact.sendMessage("to delete", Date.now(), WIRE("C"))).toBeNull();
    const row = await t.peerRow("to delete");
    t.node.deleteMessage({ linkId: t.id, messageId: row.id });
    await vi.waitFor(async () => expect((await t.messages()).find(m => m.id === row.id)).toBeUndefined());
    await t.contact.sendEdit({ id: WIRE("C"), e: 1, ts: Date.now(), m: "back?" });
    await vi.waitFor(() => expect(t.contactReceipts).toEqual([[WIRE("C"), 1]]));
    expect((await t.messages()).find(m => m.id === row.id)).toBeUndefined();
  });
});

describe("edits on the DHT floor", () => {
  it("go to a contact whose record takes them, under an id of their own, and its receipt settles them; not before", async () => {
    vi.stubGlobal("RTCPeerConnection", undefined);
    const packets = new Map<string, SignedPacket>();
    const transport = { publish: async (identity: Parameters<typeof createRelayPayload>[0], records: Parameters<typeof createRelayPayload>[1]) => {
      packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, createRelayPayload(identity, records)));
    }, resolve: async (key: string) => packets.get(key) ?? null, describe: () => ({ protocol: "signed packet fixture", relays: [] }) };
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false, nativeTransports: {} });
    const invitation = createLink();
    const received: { id: string; text: string; edit?: { i: string; e: number } }[] = [];
    const contact = new DhtDelivery({ params: invitation.invite, mode: "dht", credentials: { seedB64: createIdentity().seedB64 }, transport,
      save: async () => {}, pin: async () => {}, message: async m => { received.push(m); }, receipt: async () => {}, changed: () => {}, pollMs: 100 });
    let linkId = "";
    try {
      await node.start();
      ({ linkId } = await node.ensureLink({ ...invitation.mine, profile: "paired-chat/1", deliveryMode: "dht" }));
      node.setActiveLink({ linkId });
      // What the contact's capability record says it takes: DHT text, and edits only later.
      const said = ["chat/1", "dht-text/1"];
      const live = (node as unknown as { links: Map<string, { caps?: object }> }).links.get(linkId)!;
      Object.defineProperty(live.caps!, "peer", { get: () => ({ capabilities: said }), configurable: true });
      await contact.start();
      const sent = await node.sendMessage({ linkId, text: "status: 1" });
      await vi.waitFor(async () => expect((await t(linkId, sent.messageId!)).delivery).toBe("delivered"), { timeout: 20_000 });

      expect((await node.editMessage({ linkId, messageId: sent.messageId!, text: "status: 2" })).error).toBeNull();
      await new Promise(resolve => setTimeout(resolve, 1_500));
      expect(received.filter(m => m.edit)).toEqual([]);

      said.push("edit/1");
      expect((await node.editMessage({ linkId, messageId: sent.messageId!, text: "status: 3" })).error).toBeNull();
      const wireId = (await t(linkId, sent.messageId!)).wireId!;
      await vi.waitFor(() => expect(received.find(m => m.edit)).toEqual({ id: dhtEditId(wireId, 2), text: "status: 3", timestamp: expect.any(Number), edit: { i: wireId, e: 2 } }), { timeout: 20_000 });
      // No second message for it, and the contact's receipt settles it here.
      expect(received.filter(m => !m.edit).map(m => m.text)).toEqual(["status: 1"]);
      await vi.waitFor(async () => expect((await t(linkId, sent.messageId!)).edit).toMatchObject({ seq: 2 }), { timeout: 20_000 });
      await vi.waitFor(async () => expect((await t(linkId, sent.messageId!)).edit?.pending).toBeUndefined(), { timeout: 20_000 });
    } finally { await contact.stop(); await node.shutdown(); if (linkId) await db.deleteLink(linkId); vi.unstubAllGlobals(); }
  }, 60_000);

  it("a contact's edit that came on the DHT floor changes its message, and is no message of its own", async () => {
    vi.stubGlobal("RTCPeerConnection", undefined);
    const packets = new Map<string, SignedPacket>();
    const transport = { publish: async (identity: Parameters<typeof createRelayPayload>[0], records: Parameters<typeof createRelayPayload>[1]) => {
      packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, createRelayPayload(identity, records)));
    }, resolve: async (key: string) => packets.get(key) ?? null, describe: () => ({ protocol: "signed packet fixture", relays: [] }) };
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false, nativeTransports: {} });
    const invitation = createLink();
    const contact = new DhtDelivery({ params: invitation.invite, mode: "dht", credentials: { seedB64: createIdentity().seedB64 }, transport,
      save: async () => {}, pin: async () => {}, message: async () => {}, receipt: async () => {}, changed: () => {}, pollMs: 100 });
    let linkId = "";
    try {
      await node.start();
      ({ linkId } = await node.ensureLink({ ...invitation.mine, profile: "paired-chat/1", deliveryMode: "dht" }));
      node.setActiveLink({ linkId });
      await contact.start();
      const id = WIRE("Q");
      expect(await contact.send("building…", Date.now(), id)).toBeNull();
      await vi.waitFor(async () => expect((await db.getMessages(linkId)).map(m => m.text)).toEqual(["building…"]), { timeout: 20_000 });
      await vi.waitFor(async () => expect(await contact.send("built", Date.now(), dhtEditId(id, 1), undefined, [id, 1])).toBeNull(), { timeout: 20_000 });
      await vi.waitFor(async () => expect((await db.getMessages(linkId)).map(m => [m.id, m.text, m.edit?.seq])).toEqual([[`peer_${id}`, "built", 1]]), { timeout: 20_000 });
    } finally { await contact.stop(); await node.shutdown(); if (linkId) await db.deleteLink(linkId); vi.unstubAllGlobals(); }
  }, 60_000);
});

const t = async (linkId: string, messageId: string) => (await db.getMessages(linkId)).find(m => m.id === messageId)!;

describe("EditQueue", () => {
  const rows = new Map<string, StoredMessage>();
  const row = (n: number, fields: Partial<StoredMessage> = {}): StoredMessage => ({ linkId: "l", id: `me_${n}`, wireId: String(n).padStart(22, "W"), text: `t${n}`, sender: "me", timestamp: 1, via: "datalink", delivery: "delivered", edit: { seq: 1, at: 1_000 + n, history: [], pending: true }, ...fields });
  function queue(now: { t: number }, ready = true) {
    const sent: WireEdit[] = [], settled: [string, number][] = [];
    const q = new EditQueue({
      read: async () => [...rows.values()], ready: () => ready, now: () => now.t, receiptMs: 1_000,
      send: edit => { sent.push(edit); return null; },
      settle: async (id, seq) => { settled.push([id, seq]); const r = rows.get(id)!; rows.set(id, { ...r, edit: { ...r.edit!, pending: undefined } }); },
    });
    cleanup.push(async () => q.stop());
    return { q, sent, settled };
  }
  afterEach(() => rows.clear());

  it("sends the latest text of each pending message, oldest edit first, and paces a burst", async () => {
    const now = { t: 10_000 };
    for (let n = 1; n <= EDIT_SEND_LIMIT + 3; n++) rows.set(`me_${n}`, row(n));
    rows.set("me_w", row(99, { id: "me_w", delivery: "waiting" }));
    const { q, sent } = queue(now);
    await q.flush();
    expect(sent.map(e => e.m)).toEqual(Array.from({ length: EDIT_SEND_LIMIT }, (_, i) => `t${i + 1}`));
    now.t += 10_001;
    await q.flush();
    // New edits before resends of those not confirmed yet.
    expect(sent.slice(EDIT_SEND_LIMIT, EDIT_SEND_LIMIT + 3).map(e => e.m)).toEqual(["t11", "t12", "t13"]);
    expect(sent.slice(EDIT_SEND_LIMIT + 3).map(e => e.m)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7"]);
  });

  it("goes again without a confirmation, stops after the attempts, and a new session starts over", async () => {
    const now = { t: 10_000 };
    rows.set("me_1", row(1));
    const { q, sent } = queue(now);
    await q.flush();
    await q.flush();
    expect(sent).toHaveLength(1);
    for (let i = 0; i < 20; i++) { now.t += 400_000; await q.flush(); }
    expect(sent).toHaveLength(8);
    await q.flush({ reopened: true });
    expect(sent).toHaveLength(9);
  });

  it("settles on a confirmation of the edit shown, not of an older one; gives up after the window", async () => {
    const now = { t: 10_000 };
    rows.set("me_1", row(1, { edit: { seq: 4, at: 5_000, history: [], pending: true } }));
    const { q, settled } = queue(now);
    await q.received(row(1).wireId!, 3);
    expect(settled).toEqual([]);
    await q.received(row(1).wireId!, 4);
    expect(settled).toEqual([["me_1", 4]]);
    rows.set("me_2", row(2, { edit: { seq: 1, at: 1, history: [], pending: true } }));
    now.t = 8 * 24 * 60 * 60_000;
    await q.flush();
    expect(settled).toContainEqual(["me_2", 1]);
  });

  it("sends nothing while the chat cannot carry edits", async () => {
    rows.set("me_1", row(1));
    const { q, sent } = queue({ t: 10_000 }, false);
    await q.flush();
    expect(sent).toEqual([]);
  });
});

describe("EditBuffer", () => {
  it("keeps the highest edit per message for a minute, a bounded number of messages", () => {
    let now = 0;
    const buffer = new EditBuffer(() => now);
    const e = (id: string, n: number): WireEdit => ({ id, e: n, ts: 1, m: `m${n}` });
    buffer.hold("l", e("a", 2)); buffer.hold("l", e("a", 1));
    expect(buffer.take("l", "a")?.e).toBe(2);
    expect(buffer.take("l", "a")).toBeUndefined();
    buffer.hold("l", e("b", 1));
    now += EDIT_BUFFER_MS;
    expect(buffer.take("l", "b")).toBeUndefined();
    for (let i = 0; i < 40; i++) buffer.hold("l", e(`x${i}`, 1));
    expect(buffer.take("l", "x0")).toBeUndefined();
    expect(buffer.take("l", "x39")?.e).toBe(1);
  });
});

describe("what an edit keeps", () => {
  const base: StoredMessage = { linkId: "l", id: "me_1", wireId: WIRE("W"), text: "v0", sender: "me", timestamp: 100, via: "datalink", preview: { u: "https://a.example/" } };
  it("the version it replaces, newest ones within the bounds; a preview only with the text it came with", () => {
    let m = withEdit(base, { seq: 1, at: 200, text: "v1" });
    expect(m).toMatchObject({ text: "v1", edit: { seq: 1, at: 200, history: [{ at: 100, text: "v0" }] } });
    expect(m.preview).toBeUndefined();
    for (let i = 2; i <= EDIT_HISTORY_KEEP + 5; i++) m = withEdit(m, { seq: i, at: 200 + i, text: `v${i}` });
    expect(m.edit!.history).toHaveLength(EDIT_HISTORY_KEEP);
    expect(m.edit!.history.at(-1)!.text).toBe(`v${EDIT_HISTORY_KEEP + 4}`);
    const big = "x".repeat(EDIT_HISTORY_MAX_BYTES / 2);
    m = withEdit(withEdit(withEdit(base, { seq: 1, at: 1, text: big + "1" }), { seq: 2, at: 2, text: big + "2" }), { seq: 3, at: 3, text: "small" });
    expect(m.edit!.history.map(v => v.text.length)).toEqual([big.length + 1]);
    // The same text again only moves the number on.
    expect(withEdit(base, { seq: 1, at: 5, text: "v0" }).edit!.history).toEqual([]);
  });

  it("only for texts: mine to edit, the contact's to take edits", () => {
    expect(canEdit(base)).toBe(true);
    expect(canEdit({ ...base, sender: "peer" })).toBe(false);
    expect(canEdit({ ...base, linkId: "group:g" })).toBe(false);
    expect(canEdit({ ...base, wireId: undefined })).toBe(false);
    expect(canEdit({ ...base, text: "👋 Bob joined" })).toBe(false);
    expect(takesPeerEdit({ ...base, sender: "peer" })).toBe(true);
    expect(takesPeerEdit({ ...base, sender: "peer", paymentId: "p" })).toBe(false);
  });
});
