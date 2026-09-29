import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, MAX_EDITS_PER_MESSAGE, createIdentity, createLink, identityFromSeedB64, readStatusCard, statusCardText, type IncomingMessage, type PairingState, type StatusCard, type WireEdit } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { FakeNativeNet } from "./helpers/fakeNative";
// covers: chat.status-cards.wire

/**
 * Status cards in the engine (WISP 4xx · Status Cards): a real node and its contact's link over a stand-in for Iroh. A
 * card goes beside its fallback text, an update is an edit carrying the card of its version, and past a text's hundred
 * edits a card's update goes only to a contact whose app shows cards.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function setup({ cards = true }: { cards?: boolean } = {}) {
  const net = new FakeNativeNet();
  const invitation = createLink();
  const [mine, theirs] = [createIdentity().seedB64, createIdentity().seedB64];
  const id = `cards-${crypto.randomUUID()}`;
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink({ ...invitation.mine, id, profile: "paired-chat/1", participationSeed: mine, createdAt: 1,
    pairedPeerKey: identityFromSeedB64(theirs).pubKeyZ32, peerTrust: { version: 1 },
    peerTransports: ["iroh/1"], peerFallback: true, preferredTransport: "iroh/1", transportFallback: true,
    peerDescriptors: { "iroh/1": { id: "contact:iroh/1" } } });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() }, { transport, automaticWallets: false,
    nativeTransports: { "iroh/1": async () => net.endpoint("iroh/1", "app") } });
  let contactState: PairingState = { status: "connecting" };
  const contactGot: IncomingMessage[] = [], contactEdits: WireEdit[] = [];
  const contact = new GhostLink({
    params: { ...invitation.invite, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: theirs, peerKey: identityFromSeedB64(mine).pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true, peerTransports: ["iroh/1"], peerFallback: true, peerDescriptors: { "iroh/1": { id: "app:iroh/1" } } },
    transport, createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    editSupport: true, statusCardSupport: cards,
    events: { onPairingState: state => { contactState = state; }, onMessage: message => { contactGot.push(message); }, onMessageEdit: edit => { contactEdits.push(edit); return true; } },
  });
  contact.registerEndpoint(net.endpoint("iroh/1", "contact"));
  cleanup.push(async () => { await contact.stop(false); await node.shutdown(); await db.deleteLink(id); });
  await node.start();
  node.setActiveLink({ linkId: id });
  const view = () => node.getState().links.find(l => l.id === id)!;
  await vi.waitFor(() => expect(view().availableTransports).toHaveLength(1));
  void contact.connect(5_000).catch(() => {});
  await vi.waitFor(() => expect([view().pairing?.status, contactState.status]).toEqual(["ready", "ready"]));
  const mineLink = () => (node as unknown as { links: Map<string, { link?: GhostLink }> }).links.get(id)?.link;
  await vi.waitFor(() => expect([mineLink()?.supportsEdits, contact.supportsEdits]).toEqual([true, true]));
  await vi.waitFor(() => expect(mineLink()?.supportsStatusCards).toBe(cards));
  const row = async (messageId: string) => (await db.getMessages(id)).find(m => m.id === messageId)!;
  const peerRow = async (text: string) => { await vi.waitFor(async () => expect((await db.getMessages(id)).find(m => m.text === text)).toBeDefined()); return (await db.getMessages(id)).find(m => m.text === text)!; };
  return { node, contact, id, contactGot, contactEdits, row, peerRow };
}

const task = (extra: Record<string, unknown> = {}) => ({ kind: "task", id: "relay-rotation", title: "Fix relay rotation", status: "running", ...extra });
const WIRE = (c: string) => c.repeat(22);

describe("sending a status card", () => {
  it("goes beside the fallback text the engine writes, and is kept with the row", async () => {
    const t = await setup();
    const sent = await t.node.sendMessage({ linkId: t.id, text: "", card: task({ progress: 40 }) });
    expect(sent.error).toBeNull();
    const card = readStatusCard(task({ progress: 40 }))!;
    await vi.waitFor(() => expect(t.contactGot.at(-1)).toMatchObject({ text: statusCardText(card), card }));
    expect(await t.row(sent.messageId!)).toMatchObject({ text: statusCardText(card), card });
  });

  it("refuses a card out of bounds, and never keeps a row for it", async () => {
    const t = await setup();
    const before = (await db.getMessages(t.id)).length;
    expect(await t.node.sendMessage({ linkId: t.id, text: "", card: task({ status: "paused" }) })).toMatchObject({ refused: true, error: expect.stringMatching(/status is one of/) });
    expect(await t.node.sendMessage({ linkId: t.id, text: "", card: task({ pr: { url: "http://x.example/1" } }) })).toMatchObject({ refused: true });
    expect((await db.getMessages(t.id)).length).toBe(before);
  });

  it("is updated by editing its message: the card of each version goes with it", async () => {
    const t = await setup();
    const sent = await t.node.sendMessage({ linkId: t.id, text: "", card: task({ progress: 10 }) });
    await vi.waitFor(async () => expect((await t.row(sent.messageId!)).delivery).toBe("delivered"));
    expect(await t.node.editMessage({ linkId: t.id, messageId: sent.messageId!, text: "", card: task({ status: "done", progress: 100 }) })).toEqual({ error: null, messageId: sent.messageId });
    const done = readStatusCard(task({ status: "done", progress: 100 }))!;
    expect(await t.row(sent.messageId!)).toMatchObject({ text: statusCardText(done), card: done, edit: { seq: 1 } });
    await vi.waitFor(() => expect(t.contactEdits.at(-1)).toMatchObject({ e: 1, m: statusCardText(done), sc: done }));
    // A text edit leaves the message a text: the card belongs to its version.
    await t.node.editMessage({ linkId: t.id, messageId: sent.messageId!, text: "Just text now" });
    expect((await t.row(sent.messageId!)).card).toBeUndefined();
  });

  it("takes more than a text's hundred edits, sent past it only to a contact whose app shows cards", async () => {
    for (const cards of [true, false]) {
      const t = await setup({ cards });
      const sent = await t.node.sendMessage({ linkId: t.id, text: "", card: task() });
      await vi.waitFor(async () => expect((await t.row(sent.messageId!)).delivery).toBe("delivered"));
      await db.patchMessage(t.id, sent.messageId!, () => ({ edit: { seq: MAX_EDITS_PER_MESSAGE, at: Date.now() - 60_000, history: [] } }));
      expect(await t.node.editMessage({ linkId: t.id, messageId: sent.messageId!, text: "", card: task({ progress: 99 }) })).toMatchObject({ error: null });
      expect(await t.node.editMessage({ linkId: t.id, messageId: sent.messageId!, text: "a text past its hundred" })).toMatchObject({ refused: true });
      if (cards) await vi.waitFor(() => expect(t.contactEdits.at(-1)).toMatchObject({ e: MAX_EDITS_PER_MESSAGE + 1, sc: { progress: 99 } }));
      else {
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(t.contactEdits).toEqual([]);
        expect((await t.row(sent.messageId!)).edit?.pending).toBe(true);
      }
      await cleanup.pop()!();
    }
  });
});

describe("receiving a status card", () => {
  it("keeps the contact's card with its text, and an edit replaces it with its own, or none", async () => {
    const t = await setup();
    const card = readStatusCard(task({ progress: 20 }))!;
    expect(await t.contact.sendMessage(statusCardText(card), Date.now(), WIRE("C"), undefined, undefined, undefined, card)).toBeNull();
    const row = await t.peerRow(statusCardText(card));
    expect(row.card).toEqual(card);
    const next: StatusCard = readStatusCard(task({ progress: 70, step: "Running the e2e" }))!;
    expect(await t.contact.sendEdit({ id: WIRE("C"), e: 150, ts: Date.now(), m: statusCardText(next), sc: next })).toBeNull();
    await vi.waitFor(async () => expect((await db.getMessage(t.id, row.id))?.card).toEqual(next));
    expect(await t.contact.sendEdit({ id: WIRE("C"), e: 151, ts: Date.now(), m: "plain words" })).toMatch(/takes no more edits/);
    expect(await t.contact.sendEdit({ id: WIRE("C"), e: 5, ts: Date.now(), m: "stale" })).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(await db.getMessage(t.id, row.id)).toMatchObject({ card: next, edit: { seq: 150 } });
  });

  it("drops a card that does not hold and keeps the message as its text", async () => {
    const t = await setup();
    expect(await t.contact.sendMessage("🔄 odd card", Date.now(), WIRE("D"), undefined, undefined, undefined, { kind: "task", id: "x" } as unknown as StatusCard)).toBeNull();
    expect((await t.peerRow("🔄 odd card")).card).toBeUndefined();
  });
});
