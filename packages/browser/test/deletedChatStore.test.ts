import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { GhostLink, createIdentity, createLink, identityFromSeedB64, type PairingState, type WireReply } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import type { StoredLink, StoredMessage } from "../src/shared/types";
import { FakeNativeNet, fakeDescriptor } from "./helpers/fakeNative";

/**
 * A chat deleted while a message for it is being stored: a real node and its contact's link over a stand-in for Iroh.
 * The store waits (a reply's original looked for, its row written) while the person deletes the chat; nothing of that
 * message is kept under the deleted chat's id, told to the pages or announced, and joining the same invite again
 * (the same chat id) shows none of it.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const step of cleanup.splice(0).reverse()) await step(); });

const WIRE = (c: string) => c.repeat(22);
/** A reply to a message that is not here: its lookup reads more than one row. */
const ELSEWHERE: WireReply = { i: "notherenothere00000001", s: "A message not here", f: "recipient" };

/** `history`: rows already in the chat before the app starts. */
async function setup({ history = 0 } = {}) {
  const net = new FakeNativeNet();
  const invitation = createLink();
  const [mine, theirs] = [createIdentity().seedB64, createIdentity().seedB64];
  // A joined chat's id: its invite key's, so joining the same invite again makes the same id (`addLink`).
  const id = identityFromSeedB64(invitation.mine.seedB64).pubKeyZ32.slice(0, 16);
  const row: Omit<StoredLink, "id" | "createdAt"> = { ...invitation.mine, profile: "paired-chat/1", participationSeed: mine,
    pairedPeerKey: identityFromSeedB64(theirs).pubKeyZ32, peerTrust: { version: 1 },
    peerTransports: ["iroh/1"], peerFallback: true, preferredTransport: "iroh/1", transportFallback: true,
    peerDescriptors: { "iroh/1": fakeDescriptor("iroh/1", "contact") } };
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink({ ...row, id, createdAt: 1 });
  await Promise.all(Array.from({ length: history }, (_, i) => db.putMessage({ linkId: id, id: `peer_seed${String(i).padStart(17, "0")}`,
    text: `Earlier ${i}`, sender: "peer", timestamp: 1_000 + i, via: "datalink" })));
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const onMessages = vi.fn(), onAttention = vi.fn();
  const makeNode = () => new GhostlyNode({ onState: vi.fn(), onMessages, onCallSignal: vi.fn(), onAttention }, { transport, automaticWallets: false,
    nativeTransports: { "iroh/1": async () => net.endpoint("iroh/1", "app") } });
  let node = makeNode();
  let contactState: PairingState = { status: "connecting" };
  const contact = new GhostLink({
    params: { ...invitation.invite, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: theirs, peerKey: identityFromSeedB64(mine).pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true, peerTransports: ["iroh/1"], peerFallback: true, peerDescriptors: { "iroh/1": fakeDescriptor("iroh/1", "app") } },
    transport, createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    events: { onPairingState: state => { contactState = state; } },
  });
  contact.registerEndpoint(net.endpoint("iroh/1", "contact"));
  cleanup.push(async () => { await contact.stop(false); await node.shutdown(); await db.deleteLink(id); });
  /** Every store the node begins, to wait for them all. */
  const stores: Promise<boolean>[] = [];
  const watchStores = () => {
    const store = (node as unknown as { storeNewMessage: (...args: unknown[]) => Promise<boolean> }).storeNewMessage.bind(node);
    (node as unknown as { storeNewMessage: (...args: unknown[]) => Promise<boolean> }).storeNewMessage = (...args) => { const done = store(...args); stores.push(done); return done; };
  };
  watchStores();
  await node.start();
  const view = () => node.getState().links.find(l => l.id === id);
  await vi.waitFor(() => expect(view()?.availableTransports).toHaveLength(1));
  void contact.connect(5_000).catch(() => {});
  await vi.waitFor(() => expect([view()?.pairing?.status, contactState.status]).toEqual(["ready", "ready"]), { timeout: 10_000 });
  return {
    get node() { return node; }, contact, id, row, view, stores, onMessages, onAttention,
    /** Everything the node began to store has settled. */
    settled: async () => { await Promise.allSettled(stores); await new Promise(resolve => setTimeout(resolve, 50)); },
    /** What reached the app for the chat from `from` on: the pages told of its rows, and the attention given to it. */
    heard: (from: { messages: number; attention: number }) => ({
      told: onMessages.mock.calls.slice(from.messages).filter(call => JSON.stringify(call).includes(id)).length,
      attention: onAttention.mock.calls.slice(from.attention).filter(([fact]) => (fact as { linkId?: string }).linkId === id).length,
    }),
    mark: () => ({ messages: onMessages.mock.calls.length, attention: onAttention.mock.calls.length }),
    /** The app closes and opens again on this device's storage. */
    restart: async () => { await node.shutdown(); node = makeNode(); watchStores(); await node.start(); },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** The person deletes the chat the moment `db.<method>` is first called for `rowId`'s row of the chat, which then goes on. */
function deleteDuring(t: Setup, method: "getMessage" | "addMessage", match: (linkId: string, rowId: string) => boolean) {
  let deleted = false;
  const at: { told?: { messages: number; attention: number } } = {};
  const remove = (linkId: string, rowId: string) => {
    if (deleted || linkId !== t.id || !match(linkId, rowId)) return;
    deleted = true;
    at.told = t.mark();
    t.node.removeLink({ linkId: t.id });
  };
  if (method === "getMessage") {
    const read = db.getMessage.bind(db);
    vi.spyOn(db, "getMessage").mockImplementation(async (linkId, rowId) => { remove(linkId, rowId); return read(linkId, rowId); });
  } else {
    const add = db.addMessage.bind(db);
    vi.spyOn(db, "addMessage").mockImplementation(async (message: StoredMessage) => { remove(message.linkId, message.id); return add(message); });
  }
  return { get deleted() { return deleted; }, at };
}

for (const history of [0, 1_500]) {
  it(`a reply heard as its chat is deleted, its original being looked for (${history} rows), is not stored, told or announced, after a restart neither`, async () => {
    const t = await setup({ history });
    const wire = WIRE("r");
    const race = deleteDuring(t, "getMessage", (_, rowId) => rowId === `peer_${ELSEWHERE.i}`);
    const wholeReads = vi.spyOn(db, "getMessages");
    expect(await t.contact.sendMessage("A reply as the chat goes", Date.now(), wire, undefined, ELSEWHERE)).toBeNull();
    await vi.waitFor(() => expect(race.deleted).toBe(true));
    await t.settled();
    // Its original is not looked for in the deleted chat's whole history either.
    expect(wholeReads.mock.calls.filter(([linkId]) => linkId === t.id)).toHaveLength(0);
    expect(await db.getMessages(t.id)).toEqual([]);
    expect(t.heard(race.at.told!)).toEqual({ told: 0, attention: 0 });
    await t.restart();
    expect(t.view()).toBeUndefined();
    expect(await db.getMessages(t.id)).toEqual([]);
  }, 60_000);
}

it("a message heard as its chat is deleted, its row being written, is not kept, told or announced", async () => {
  const t = await setup();
  const wire = WIRE("w");
  const race = deleteDuring(t, "addMessage", (_, rowId) => rowId === `peer_${wire}`);
  expect(await t.contact.sendMessage("Written as the chat goes", Date.now(), wire)).toBeNull();
  await vi.waitFor(() => expect(race.deleted).toBe(true));
  await t.settled();
  expect(await db.getMessages(t.id)).toEqual([]);
  expect(t.heard(race.at.told!)).toEqual({ told: 0, attention: 0 });
}, 60_000);

it("the same invite joined again while such a store is under way shows nothing of the deleted chat, and takes new messages", async () => {
  const t = await setup({ history: 20 });
  const read = db.getMessage.bind(db);
  let joined: Promise<string> | undefined;
  // The chat is deleted as the reply's original is looked for, and joined again (the same id) before that read answers.
  vi.spyOn(db, "getMessage").mockImplementation(async (linkId, rowId) => {
    if (!joined && linkId === t.id && rowId === `peer_${ELSEWHERE.i}`) {
      t.node.removeLink({ linkId: t.id });
      joined = (t.node as unknown as { addLink: (params: unknown) => Promise<string> }).addLink({ ...t.row, participationSeedB64: t.row.participationSeed });
      expect(await joined).toBe(t.id);
    }
    return read(linkId, rowId);
  });
  expect(await t.contact.sendMessage("A reply as the chat goes", Date.now(), WIRE("j"), undefined, ELSEWHERE)).toBeNull();
  await vi.waitFor(() => expect(joined).toBeDefined());
  await joined;
  await t.settled();
  expect(t.view()).toBeDefined();
  expect(await db.getMessages(t.id)).toEqual([]);
  // The joined chat stores what comes for it as any chat does.
  const before = t.mark();
  await t.node["storeMessage"]({ linkId: t.id, id: "peer_afterjoin0000000000001", text: "Written to the chat joined again", sender: "peer", timestamp: Date.now(), via: "datalink" });
  expect((await db.getMessages(t.id)).map(m => m.text)).toEqual(["Written to the chat joined again"]);
  expect(t.heard(before).told).toBeGreaterThan(0);
}, 60_000);

it("a message to a chat nobody deletes is stored, told and announced as before, a reply to one not here included", async () => {
  const t = await setup({ history: 3 });
  const before = t.mark();
  expect(await t.contact.sendMessage("A reply to a chat that stays", Date.now(), WIRE("k"), undefined, ELSEWHERE)).toBeNull();
  await vi.waitFor(async () => expect((await db.getMessages(t.id)).map(m => m.text)).toContain("A reply to a chat that stays"));
  await t.settled();
  const row = (await db.getMessages(t.id)).find(m => m.text === "A reply to a chat that stays")!;
  expect(row.replyTo).toMatchObject({ id: ELSEWHERE.i });
  expect(t.heard(before).told).toBeGreaterThan(0);
  expect(t.heard(before).attention).toBeGreaterThan(0);
}, 60_000);
