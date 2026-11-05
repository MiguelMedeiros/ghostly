import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createIdentity, type GhostLinkOptions } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import type { StoredLink } from "../src/shared/types";
// covers: chat.paired.send

/** How long each recorded link takes to build: a chat's key derivations and capability record at 4x CPU. */
const LINK_MS = 4;
const busy = (ms: number) => { const until = performance.now() + ms; while (performance.now() < until) { /* the work */ } };

const built = vi.hoisted(() => [] as string[]);
/** The `lastSeenTimestamp` each link was built with, by chat. */
const seen = vi.hoisted(() => new Map<string, number | undefined>());
vi.mock("@ghostly/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ghostly/core")>();
  class SlowLink {
    availableTransports = ["webrtc/1"];
    isDataLinkOpen = false;
    supportsFiles = true;
    canSendText = true;
    textDelivery = "stream";
    groupsSupport = false;
    supportsGroupVersion = () => false;
    identitySupport = false;
    peerProofAdapters: string[] = [];
    session = { setActive: () => {}, pollNow: () => {}, setFastPoll: () => {} };
    setChatActive = () => {};
    learnPeerTransports = () => {};
    learnPeerChoice = () => {};
    nativeDescriptors = {};
    relayedTransports: string[] = [];
    start = () => {};
    stop = async () => {};
    wake = () => {};
    depart = () => {};
    allowsPayment = () => true;
    constructor(readonly options: GhostLinkOptions) {
      busy(LINK_MS);
      built.push((options.params as StoredLink).id);
      seen.set((options.params as StoredLink).id, options.lastSeenTimestamp);
    }
  }
  return { ...actual, GhostLink: SlowLink };
});

const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
let node: GhostlyNode | undefined;
afterEach(async () => { await node?.shutdown(); node = undefined; built.length = 0; seen.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function chat(i: number, lastLiveAt: number): StoredLink {
  return { id: `chat-${String(i).padStart(2, "0")}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64,
    pairedPeerKey: createIdentity().pubKeyZ32, transportHistory: [{ at: lastLiveAt, kind: "live", transport: "webrtc/1" }] };
}

/** What the page got to run while the engine started: when it ran, and how many links were built by then. */
function watchPage(): { turns: number[] } {
  const turns: number[] = [];
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { turns.push(built.length); if (built.length < 40) channel.port2.postMessage(null); else channel.port1.close(); };
  channel.port2.postMessage(null);
  return { turns };
}

/**
 * At start every saved chat's link was built in one task: 50 chats and 20 groups held the page for 575-762 ms at 4x CPU,
 * 3.3 s after opening, right when the chat list appears and a person clicks a chat. Links now start in slices that let
 * the page go, most recently live first.
 */
it("a start with 40 saved chats lets the page run between slices of links, most recently live first", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  for (let i = 0; i < 40; i++) await db.putLink(chat(i, 1000 + i));
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport: fixture as never, automaticWallets: false, nativeTransports: {} });
  const page = watchPage();
  await node.start();
  expect(built).toHaveLength(40);
  // Most recently live first, as before.
  expect(built.slice(0, 3)).toEqual(["chat-39", "chat-38", "chat-37"]);
  // The page ran between links: no stretch of links built in one task holds it for much more than one slice.
  await vi.waitFor(() => expect(page.turns[page.turns.length - 1]).toBe(40));
  const stretches = page.turns.map((n, i) => n - (page.turns[i - 1] ?? 0)).filter((n) => n > 0);
  expect(Math.max(...stretches) * LINK_MS).toBeLessThanOrEqual(30);
}, 30000);

/** 40 saved chats, each with a message its contact sent over the DHT (`lastSeenTimestamp` 400 + i). */
async function fortyChats(online: boolean): Promise<void> {
  await db.putSettings({ online, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  for (let i = 0; i < 40; i++) {
    const link = chat(i, 1000 + i);
    await db.putLink(link);
    await db.putMessage({ linkId: link.id, id: `peer_${i}`, text: "hi", sender: "peer", timestamp: 500 + i, sentAt: 400 + i, via: "pkarr" });
  }
}

/** The links built from here on: most recently live first, in slices, and no chat's history read again for them. */
async function startsAsAStartDoes(start: () => Promise<void>): Promise<void> {
  expect(built).toHaveLength(0);
  const reads = vi.spyOn(db, "getMessages");
  const page = watchPage();
  await start();
  expect(built).toHaveLength(40);
  expect(built.slice(0, 3)).toEqual(["chat-39", "chat-38", "chat-37"]);
  expect(seen.get("chat-07")).toBe(407);
  expect(reads.mock.calls.filter(([id]) => id.startsWith("chat-"))).toEqual([]);
  await vi.waitFor(() => expect(page.turns[page.turns.length - 1]).toBe(40));
  const stretches = page.turns.map((n, i) => n - (page.turns[i - 1] ?? 0)).filter((n) => n > 0);
  expect(Math.max(...stretches) * LINK_MS).toBeLessThanOrEqual(30);
}

/**
 * The active device of a device set starts in limited mode until its turn read answers, then leaves it: the chats
 * started then in the order they were stored (a chat live a moment before could be left with no native listener), each
 * after a second read of its whole history, the start having read them all already.
 */
it("leaving limited mode starts the chats as a start does, reading no history again", async () => {
  await fortyChats(true);
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport: fixture as never, automaticWallets: false, nativeTransports: {}, limited: true });
  await node.start();
  await startsAsAStartDoes(() => node!.leaveLimited());
}, 30000);

it("the network turned on starts the chats as a start does, reading no history again", async () => {
  await fortyChats(false);
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport: fixture as never, automaticWallets: false, nativeTransports: {} });
  await node.start();
  await startsAsAStartDoes(() => node!.updateSettings({ settings: { online: true } }).then(() => {}));
}, 30000);

it("a chat started again knows the contact's messages over the DHT stored since the start, as a read of its history would", async () => {
  await fortyChats(true);
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport: fixture as never, automaticWallets: false, nativeTransports: {} });
  await node.start();
  expect(seen.get("chat-07")).toBe(407);
  const store = (message: object) => (node as unknown as { storeNewMessage(m: object): Promise<boolean> }).storeNewMessage(message);
  await store({ linkId: "chat-07", id: "peer_new", text: "again", sender: "peer", timestamp: 900, sentAt: 800, via: "pkarr" });
  // Neither one of mine nor one over the data link is what the DHT said.
  await store({ linkId: "chat-07", id: "me_new", text: "mine", sender: "me", timestamp: 2000, via: "pkarr" });
  await store({ linkId: "chat-07", id: "peer_live", text: "live", sender: "peer", timestamp: 2000, via: "datalink" });
  await node.updateSettings({ settings: { online: false } });
  await node.updateSettings({ settings: { online: true } });
  expect(seen.get("chat-07")).toBe(800);
  expect(seen.get("chat-07")).toBe(Math.max(...(await db.getMessages("chat-07")).filter((m) => m.sender === "peer" && m.via === "pkarr").map((m) => m.sentAt ?? m.timestamp)));
}, 30000);

it("a start that goes offline between slices starts no more links", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  for (let i = 0; i < 40; i++) await db.putLink(chat(i, 1000 + i));
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport: fixture as never, automaticWallets: false, nativeTransports: {} });
  const starting = node.start();
  // Offline as soon as the first links are built.
  await vi.waitFor(() => expect(built.length).toBeGreaterThan(0), { interval: 0 });
  await node.updateSettings({ settings: { online: false } });
  await starting;
  const live = [...(node as unknown as { links: Map<string, { link: unknown }> }).links.values()];
  expect(built.length).toBeLessThan(40);
  expect(live.filter((l) => l.link)).toHaveLength(0);
}, 30000);

/** A private group's edge to one of its members, stored under an id that sorts before every chat's. */
function edge(i: number): StoredLink {
  return { ...chat(i, 0), id: `a-edge-${String(i).padStart(2, "0")}`, group: "group-1", groupPeer: createIdentity().pubKeyZ32, transportHistory: [] };
}

/** 10 saved chats and 30 group edges, and the links started from here on, in the order they started. */
async function chatsAndEdges(online: boolean): Promise<string[]> {
  await db.putSettings({ online, nick: "", relays: [], iceServers: [{ urls: "turn:turn.example:3478", username: "u", credential: "c" }], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  for (const stored of await db.getLinks()) await db.deleteLink(stored.id);
  for (let i = 0; i < 30; i++) await db.putLink(edge(i));
  for (let i = 0; i < 10; i++) await db.putLink(chat(i, 1000 + i));
  const started: string[] = [];
  // Only the order is looked at: an edge of a group this test never stored builds nothing.
  vi.spyOn(GhostlyNode.prototype as unknown as { startLink(id: string): void }, "startLink").mockImplementation((id) => { started.push(id); });
  return started;
}

/** The chats first, most recently live first, then the edges: the chat about to be opened waits for none of them. */
const chatsFirst = ["chat-09", "chat-08", "chat-07", "chat-06", "chat-05", "chat-04", "chat-03", "chat-02", "chat-01", "chat-00"];

/**
 * Leaving limited mode, the network back on and "Hide my IP" switched started the links in the engine's order, every
 * private group's edge before any chat: with 10 mesh groups of 32, the newest chat started after 310 edges.
 */
it("a start puts the chats before the group edges stored ahead of them", async () => {
  const started = await chatsAndEdges(true);
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport: fixture as never, automaticWallets: false, nativeTransports: {} });
  await node.start();
  expect(started.slice(0, 10)).toEqual(chatsFirst);
  expect(started).toHaveLength(40);
}, 30000);

it("leaving limited mode puts the chats before the group edges", async () => {
  const started = await chatsAndEdges(true);
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport: fixture as never, automaticWallets: false, nativeTransports: {}, limited: true });
  await node.start();
  started.length = 0;
  await node.leaveLimited();
  expect(started.slice(0, 10)).toEqual(chatsFirst);
  expect(started).toHaveLength(40);
}, 30000);

it("the network turned on puts the chats before the group edges", async () => {
  const started = await chatsAndEdges(false);
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport: fixture as never, automaticWallets: false, nativeTransports: {} });
  await node.start();
  expect(started).toEqual([]);
  await node.updateSettings({ settings: { online: true } });
  expect(started.slice(0, 10)).toEqual(chatsFirst);
  expect(started).toHaveLength(40);
}, 30000);

it("\"Hide my IP\" switched starts the chats again before the group edges", async () => {
  const started = await chatsAndEdges(true);
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport: fixture as never, automaticWallets: false, nativeTransports: {} });
  await node.start();
  started.length = 0;
  await node.updateSettings({ settings: { relayOnly: true } });
  expect(started.slice(0, 10)).toEqual(chatsFirst);
  expect(started).toHaveLength(40);
}, 30000);
