import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createIdentity, type GhostLinkOptions, type NativeEndpoint, type NativeTransport, type PeerPresence } from "@ghostly/core";
import { GhostlyNode, NATIVE_GONE_MS } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink } from "../src/shared/types";
// covers: transport.native-pool, transport.hyperdht

/**
 * A HyperDHT listener costs the network about 62 requests a minute while it waits (hyperdht pings the three nodes that
 * hold its record every 3 s). A 1:1 chat whose contact is gone (not seen online, no session, unused, not on screen for
 * `NATIVE_GONE_MS`) lets it go, and listens again when the contact is seen online, a text goes, or the chat is opened.
 * GhostLink is replaced by a recorder (as in nodeLinks.test.ts): the test plays the contact through its callbacks.
 */

type Recorded = {
  options: GhostLinkOptions & { params: StoredLink; events: Required<NonNullable<GhostLinkOptions["events"]>> };
  availableTransports: string[]; isDataLinkOpen: boolean;
  registerEndpoint: ReturnType<typeof vi.fn>; releaseEndpoint: ReturnType<typeof vi.fn>; canReleaseEndpoint: ReturnType<typeof vi.fn>;
  knockOnReturn: ReturnType<typeof vi.fn>;
};
const links = vi.hoisted(() => [] as Recorded[]);
vi.mock("@ghostly/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ghostly/core")>();
  class RecordedLink {
    availableTransports = ["webrtc/1"];
    isDataLinkOpen = false;
    supportsFiles = true;
    canSendText = true;
    textDelivery = "stream";
    groupsSupport = false;
    supportsGroupVersion = vi.fn(() => false);
    identitySupport = false;
    peerProofAdapters: string[] = [];
    session = { setActive: vi.fn(), pollNow: vi.fn(), setFastPoll: vi.fn() };
    setChatActive = (active: boolean) => this.session.setActive(active);
    learnPeerTransports = vi.fn();
    learnPeerChoice = vi.fn();
    registerEndpoint = vi.fn((endpoint: { transport: string }) => { this.availableTransports = [...this.availableTransports, endpoint.transport]; });
    canReleaseEndpoint = vi.fn(() => true);
    releaseEndpoint = vi.fn(async (transport: string) => { this.availableTransports = this.availableTransports.filter((t) => t !== transport); });
    lastActivityAt = Date.now();
    knockOnReturn = vi.fn();
    canYieldEndpoint = vi.fn(() => false);
    yieldEndpoint = vi.fn(async () => false);
    nativeDescriptors = {};
    relayedTransports: string[] = [];
    start = vi.fn();
    stop = vi.fn(async () => {});
    wake = vi.fn();
    expectPeer = vi.fn();
    depart = vi.fn();
    connect = vi.fn(async () => {});
    disconnect = vi.fn();
    sendMessage = vi.fn(async () => null);
    validateText = vi.fn(() => null);
    setCallSignal = vi.fn(async () => {});
    setTyping = vi.fn();
    confirmPair = vi.fn(async () => {});
    peerAllowsPayment = vi.fn(() => false);
    peerChoosesPayment = vi.fn(() => false);
    allowsPayment = vi.fn(() => true);
    constructor(readonly options: GhostLinkOptions) { links.push(this as never); }
  }
  return { ...actual, GhostLink: RecordedLink };
});

const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
const nodes: GhostlyNode[] = [];
const endpoint = (transport: NativeTransport): NativeEndpoint => ({ transport, descriptor: { publicKey: "ab".repeat(32) },
  connect: vi.fn(), close: vi.fn(async () => {}), onConnection: null, onDescriptor: null });

/** An engine with these chats saved, running HyperDHT and Iroh natively (a Linux Desktop, the CLI). */
async function started(...rows: StoredLink[]) {
  for (const r of rows) await db.putLink(r);
  const hyperdht = vi.fn(async () => endpoint("hyperdht/1")), iroh = vi.fn(async () => endpoint("iroh/1"));
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() },
    { automaticWallets: false, transport: fixture, nativeTransports: { "hyperdht/1": hyperdht, "iroh/1": iroh } });
  nodes.push(node);
  await node.start();
  const linkOf = (id: string) => links.filter((l) => l.options.params.id === id).at(-1)!;
  await vi.waitFor(() => { for (const r of rows) expect(linkOf(r.id).availableTransports).toContain("hyperdht/1"); });
  return { node, linkOf, hyperdht };
}
const chat = () => ({ id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
  encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64,
  pairedPeerKey: createIdentity().pubKeyZ32 }) as StoredLink;
/** `NATIVE_GONE_MS`, as the engine says it (checked last in the first test). */
const GONE_MS = 10 * 60_000;
const online = (at: number): PeerPresence => ({ online: true, lastPacketAt: at, services: [] });
/** The engine's clock moved on by `ms` (and stays there), and its once-a-second tick ran. */
let ahead = 0, clocked = false;
function later(node: GhostlyNode, ms: number): void {
  if (!clocked) {
    clocked = true;
    const real = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => real() + ahead);
    onTestFinished(() => { clock.mockRestore(); ahead = 0; clocked = false; });
  }
  ahead += ms;
  node["retryNative"]();
}

beforeEach(async () => {
  links.length = 0;
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await transact([STORES.links, STORES.messages], (s) => { s[STORES.links].clear(); s[STORES.messages].clear(); });
});
afterEach(async () => { vi.restoreAllMocks(); for (const node of nodes.splice(0)) await node.shutdown(); });

it("a chat whose contact is gone lets its HyperDHT listener go, and listens again on the same key when the contact is back", async () => {
  const [gone, here, live] = [chat(), chat(), chat()];
  const { node, linkOf, hyperdht } = await started(gone, here, live);
  const seeds = (await db.getLinks()).find((l) => l.id === gone.id)?.transportSeeds;
  // Not yet: a contact gone a little while (an app restarting) finds the listener as before.
  later(node, GONE_MS - 60_000);
  expect(linkOf(gone.id).releaseEndpoint).not.toHaveBeenCalled();

  // Past it: the chat whose contact was never seen online in this run lets HyperDHT go, and keeps Iroh. The one whose
  // contact's packet says it is online keeps it, and so does the one live with its contact.
  linkOf(here.id).options.events.onPresence(online(1));
  linkOf(live.id).isDataLinkOpen = true;
  later(node, 61_000);
  await vi.waitFor(() => expect(linkOf(gone.id).availableTransports).not.toContain("hyperdht/1"));
  expect(linkOf(gone.id).releaseEndpoint.mock.calls).toEqual([["hyperdht/1"]]);
  expect(linkOf(gone.id).availableTransports).toContain("iroh/1");
  expect(linkOf(here.id).releaseEndpoint).not.toHaveBeenCalled();
  expect(linkOf(live.id).releaseEndpoint).not.toHaveBeenCalled();

  // Another start (a relay back, a failed start's retry) does not bring it back while the contact stays away.
  const starts = hyperdht.mock.calls.length;
  await node["ensureNativeEndpoints"](gone.id);
  expect(hyperdht.mock.calls.length).toBe(starts);

  // The contact's packet says it is online again: it listens again at once, on its saved transport key, and dials the
  // contact (whose own dials found no listener here and wait out their backoff).
  linkOf(gone.id).options.events.onPresence(online(2));
  await vi.waitFor(() => expect(linkOf(gone.id).availableTransports).toContain("hyperdht/1"));
  expect(hyperdht.mock.calls.at(-1)).toEqual([seeds?.["hyperdht/1"]]);
  expect(linkOf(gone.id).knockOnReturn.mock.calls).toEqual([["hyperdht/1"]]);
  expect(linkOf(here.id).knockOnReturn).not.toHaveBeenCalled();
  expect((await db.getLinks()).find((l) => l.id === gone.id)?.transportSeeds).toEqual(seeds);
  expect(NATIVE_GONE_MS).toBe(GONE_MS);
});

it("a gone contact's chat listens again when it is opened or a text comes in over the DHT, and never lets go one dialling", async () => {
  const [opened, written, busy] = [chat(), chat(), chat()];
  const { node, linkOf } = await started(opened, written, busy);
  linkOf(busy.id).canReleaseEndpoint.mockReturnValue(false);
  later(node, GONE_MS + 1_000);
  await vi.waitFor(() => { for (const c of [opened, written]) expect(linkOf(c.id).availableTransports).not.toContain("hyperdht/1"); });
  // A dial or a switch under way keeps it; once it ends, the next look lets it go.
  expect(linkOf(busy.id).availableTransports).toContain("hyperdht/1");
  linkOf(busy.id).canReleaseEndpoint.mockReturnValue(true);
  later(node, 16_000);
  await vi.waitFor(() => expect(linkOf(busy.id).availableTransports).not.toContain("hyperdht/1"));

  node.setActiveLink({ linkId: opened.id });
  await vi.waitFor(() => expect(linkOf(opened.id).availableTransports).toContain("hyperdht/1"));

  await linkOf(written.id).options.events.onMessage({ id: "dht-1", text: "back?", timestamp: Date.now(), via: "pkarr" } as never);
  await vi.waitFor(() => expect(linkOf(written.id).availableTransports).toContain("hyperdht/1"));
});
