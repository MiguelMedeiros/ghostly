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
    }
  }
  return { ...actual, GhostLink: SlowLink };
});

const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
let node: GhostlyNode | undefined;
afterEach(async () => { await node?.shutdown(); node = undefined; built.length = 0; vi.unstubAllGlobals(); });

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
