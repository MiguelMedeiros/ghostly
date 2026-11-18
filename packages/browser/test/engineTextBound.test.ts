import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, LIMITS, STATUS_CARD_LIMITS, createIdentity, createLink, identityFromSeedB64, type IncomingMessage, type PairingState, type WireEdit } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { EngineServer } from "../src/engine/server";
import { db } from "../src/engine/db";
import { fileStore } from "../src/shared/idb";
import { FakeNativeNet, fakeDescriptor } from "./helpers/fakeNative";
// covers: chat.status-cards.wire, chat.order

/**
 * Every engine call that sends a message's text refuses one past 16 KiB (trimmed UTF-8) whole, before it keeps or
 * sends any of it: a 1:1 chat's text and edit, a compatibility chat's text, a group's (mesh or community) text, edit
 * and file caption, and a status card past its own bound. The CLI's secret guard leans on it: a raw `engine.call`
 * text past that bound is not read for a secret, since none of it can go (packages/cli guardEngineSend).
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

const SEED = "legal winner thank year wave sausage worth useful legal winner thank yellow";
/** Just past the bound, as the engine counts it: in bytes, not characters, and once trimmed. */
const OVER = [
  `${SEED} ${"x".repeat(LIMITS.maxChatMessageBytes - SEED.length)}`,
  `${SEED} ${"é".repeat(LIMITS.maxChatMessageBytes / 2)}`,
  `  ${"y".repeat(LIMITS.maxChatMessageBytes)} ${SEED}\n`,
];
const task = (extra: Record<string, unknown> = {}) => ({ kind: "task", id: "t1", title: "Fix it", status: "running", ...extra });
const bigCard = () => task({ step: `${SEED} ${"z".repeat(STATUS_CARD_LIMITS.bytes)}` });

it("every text here is past the bound by its trimmed UTF-8", () => {
  for (const text of OVER) expect(new TextEncoder().encode(text.trim()).length).toBeGreaterThan(LIMITS.maxChatMessageBytes);
});

/** A node and its contact over a stand-in for Iroh, as statusCards.test.ts sets them up. */
async function paired() {
  const net = new FakeNativeNet();
  const invitation = createLink();
  const [mine, theirs] = [createIdentity().seedB64, createIdentity().seedB64];
  const id = `bound-${crypto.randomUUID()}`;
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink({ ...invitation.mine, id, profile: "paired-chat/1", participationSeed: mine, createdAt: 1,
    pairedPeerKey: identityFromSeedB64(theirs).pubKeyZ32, peerTrust: { version: 1 },
    peerTransports: ["iroh/1"], peerFallback: true, preferredTransport: "iroh/1", transportFallback: true,
    peerDescriptors: { "iroh/1": fakeDescriptor("iroh/1", "contact") } });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() }, { transport, automaticWallets: false,
    nativeTransports: { "iroh/1": async () => net.endpoint("iroh/1", "app") } });
  let contactState: PairingState = { status: "connecting" };
  const contactGot: IncomingMessage[] = [], contactEdits: WireEdit[] = [];
  const contact = new GhostLink({
    params: { ...invitation.invite, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: theirs, peerKey: identityFromSeedB64(mine).pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true, peerTransports: ["iroh/1"], peerFallback: true, peerDescriptors: { "iroh/1": fakeDescriptor("iroh/1", "app") } },
    transport, createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    editSupport: true, statusCardSupport: true,
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
  return { node, id, contactGot, contactEdits };
}

describe("a 1:1 chat", () => {
  it("refuses a text, a card's fallback text, an edit or a card past its bound: nothing kept, nothing sent", async () => {
    const t = await paired();
    const sent = await t.node.sendMessage({ linkId: t.id, text: "hi" });
    expect(sent.error).toBeNull();
    await vi.waitFor(() => expect(t.contactGot.map(m => m.text)).toEqual(["hi"]));
    // The contact's receipt comes after it got "hi": the rows are read once it marked the row delivered, so the
    // comparison below sees only what the refused sends would change.
    await vi.waitFor(async () => expect((await db.getMessages(t.id)).find(m => m.id === sent.messageId)?.delivery).toBe("delivered"));
    const rows = await db.getMessages(t.id);
    const exceeds = { refused: true, error: `Message exceeds ${LIMITS.maxChatMessageBytes} UTF-8 bytes.` };
    for (const text of OVER) {
      expect(await t.node.sendMessage({ linkId: t.id, text })).toEqual(exceeds);
      expect(await t.node.sendMessage({ linkId: t.id, text, card: task() })).toEqual(exceeds);
      expect(await t.node.editMessage({ linkId: t.id, messageId: sent.messageId!, text })).toMatchObject(exceeds);
      expect(await t.node.editMessage({ linkId: t.id, messageId: sent.messageId!, text, card: task() })).toMatchObject({ refused: true });
    }
    expect(await t.node.sendMessage({ linkId: t.id, text: "", card: bigCard() })).toMatchObject({ refused: true, error: expect.stringMatching(/^Status card: The card takes \d+ bytes/) });
    expect(await t.node.editMessage({ linkId: t.id, messageId: sent.messageId!, text: "", card: bigCard() })).toMatchObject({ refused: true, error: expect.stringMatching(/^Status card: The card takes/) });
    expect(await db.getMessages(t.id)).toEqual(rows);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(t.contactGot.map(m => m.text)).toEqual(["hi"]);
    expect(t.contactEdits).toEqual([]);
  });
});

describe("a compatibility chat", () => {
  it("refuses a text past the bound before it keeps it", async () => {
    await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
    const id = `compat-${crypto.randomUUID()}`;
    await db.putLink({ ...createLink().mine, id, createdAt: 1 });
    const server = new EngineServer({ automaticWallets: false, transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) } });
    cleanup.push(async () => { await server.node.shutdown(); await db.deleteLink(id); });
    await server.ready;
    for (const text of OVER) expect(await server.node.sendMessage({ linkId: id, text })).toMatchObject({ refused: true, error: expect.stringMatching(/^Message too large for DHT/) });
    expect(await db.getMessages(id)).toEqual([]);
  });
});

describe.each(["mesh", "community"] as const)("a %s group", (profile) => {
  it("refuses a text, an edit, a card or a file's caption past the bound: nothing kept", async () => {
    await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
    const server = new EngineServer({ automaticWallets: false, transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) } });
    cleanup.push(async () => { await server.node.shutdown(); });
    await server.ready;
    const node = server.node;
    const { groupId } = await node.createGroup({ name: "Plaza", profile });
    const link = `group:${groupId}`;
    const sent = await node.sendGroupMessage({ groupId, text: "hi" });
    expect(sent.error).toBeNull();
    const file = async (n: number) => {
      const id = `group-${groupId}-out-f${n}`;
      await fileStore.put({ id, linkId: link, blob: new Blob(["x"]), createdAt: 1, direction: "out", metadata: { name: "a.txt", size: 1, mime: "text/plain", timestamp: 1 } });
      return { id, name: "a.txt", size: 1, mime: "text/plain" };
    };
    // The file goes with a caption that fits: the refusals below are the caption's.
    expect(await node.sendGroupFile({ groupId, file: await file(0), caption: "a note" })).toMatchObject({ error: null });
    const rows = await db.getMessages(link);
    let n = 1;
    for (const text of OVER) {
      expect(await node.sendGroupMessage({ groupId, text }), "text").toMatchObject({ error: expect.stringMatching(/^Message exceeds 16 KiB/) });
      expect(await node.sendGroupMessage({ groupId, text, card: task() }), "text and card").toMatchObject({ error: expect.stringMatching(/^Message exceeds 16 KiB/) });
      expect(await node.editMessage({ linkId: link, messageId: sent.messageId!, text }), "edit").toMatchObject({ refused: true, error: expect.stringMatching(/^Message exceeds 16384 UTF-8 bytes/) });
      expect(await node.sendGroupFile({ groupId, file: await file(n++), caption: text }), "caption").toMatchObject({ error: expect.stringMatching(/^Message exceeds 16 KiB/) });
    }
    expect(await node.sendGroupMessage({ groupId, text: "", card: bigCard() })).toMatchObject({ error: expect.stringMatching(/^Status card: The card takes/) });
    expect(await node.editMessage({ linkId: link, messageId: sent.messageId!, text: "", card: bigCard() })).toMatchObject({ refused: true, error: expect.stringMatching(/^Status card: The card takes/) });
    expect(await db.getMessages(link)).toEqual(rows);
  });
});
