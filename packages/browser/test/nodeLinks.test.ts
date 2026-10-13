import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { LIMITS, createIdentity, dhtFileId, type FileSink, type GhostLinkOptions } from "@ghostly/core";
import { GROUP_IROH_WEB_SLOTS, GROUP_NATIVE_SLOTS, GhostlyNode, NATIVE_HOLD_MS, RESUME_SPENT_MS, type NodeOptions } from "../src/engine/node";
import { db } from "../src/engine/db";
import { EditQueue } from "../src/engine/edits";
import { STORES, fileStore, transact } from "../src/shared/idb";
import { storedBlob } from "../src/shared/storedFiles";
import type { GroupEdgeView, StoredLink } from "../src/shared/types";
// covers: core.peer-keys, chat.paired.send, chat.paired.receipts, chat.paired.nickname-sync, files.paired.send, files.size-limit, files.persistence, delivery.hold.text, delivery.hold.picture, groups.protocol.link-frames, chat.waiting, chat.caps-record

/**
 * GhostLink is replaced by a recorder: the engine builds it with its callbacks, and a test plays the peer by
 * calling them. No networking, no WebRTC.
 */
type Recorded = {
  options: Omit<GhostLinkOptions, "events" | "pairing" | "params"> & { params: StoredLink; events: Required<NonNullable<GhostLinkOptions["events"]>>; pairing: NonNullable<GhostLinkOptions["pairing"]> };
  isDataLinkOpen: boolean; supportsFiles: boolean; sent: Uint8Array[];
  stop: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; sendFile: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn>; validateText: ReturnType<typeof vi.fn>;
};
const links = vi.hoisted(() => [] as Recorded[]);
vi.mock("@ghostly/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ghostly/core")>();
  class RecordedLink {
    availableTransports = ["webrtc/1"];
    isDataLinkOpen = true;
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
    /** As the real one: live over the transport, and unused for `idleMs` (`lastActivityAt`); a call holds it (`callOn`). */
    lastActivityAt = Date.now();
    callOn = false;
    canYieldEndpoint = vi.fn((transport: string, idleMs: number) => this.isDataLinkOpen && this.availableTransports.includes(transport)
      && !this.callOn && Date.now() - this.lastActivityAt >= idleMs);
    yieldEndpoint = vi.fn(async (transport: string, idleMs: number) => {
      if (!this.canYieldEndpoint(transport, idleMs)) return false;
      this.isDataLinkOpen = false;
      this.availableTransports = this.availableTransports.filter((t) => t !== transport);
      return true;
    });
    nativeDescriptors = {};
    relayedTransports: string[] = [];
    start = vi.fn();
    stop = vi.fn(async () => {});
    wake = vi.fn();
    depart = vi.fn();
    connect = vi.fn(async () => {});
    disconnect = vi.fn();
    sendFile = vi.fn(async (_wire: unknown, source: AsyncIterable<Uint8Array>) => { for await (const chunk of source) this.sent.push(chunk); });
    sent: Uint8Array[] = [];
    sendMessage = vi.fn(async () => null);
    validateText = vi.fn(() => null);
    setCallSignal = vi.fn(async () => {});
    setTyping = vi.fn();
    confirmPair = vi.fn(async () => {});
    peerAllowsPayment = vi.fn((m: string) => m === "cashu");
    // Its choice, wallets aside: Lightning too, which it has no wallet of (peerAllowsPayment leaves it out).
    peerChoosesPayment = vi.fn((m: string) => m === "cashu" || m === "lightning");
    allowsPayment = vi.fn(() => true);
    constructor(readonly options: GhostLinkOptions) { links.push(this as never); }
  }
  return { ...actual, GhostLink: RecordedLink };
});

/** Iroh's browser build (`NodeOptions.irohWeb`) is replaced by a recorder too: no wasm, no relay. */
const irohWeb = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../src/platform/irohWeb", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/platform/irohWeb")>(), createIrohWebEndpoint: irohWeb.start }));

const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
const nodes: GhostlyNode[] = [];
function engine(options: Partial<NodeOptions> = {}) {
  const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() };
  const node = new GhostlyNode(events, { automaticWallets: false, transport: fixture, ...options });
  nodes.push(node);
  return { node, events };
}
function row(stored: Partial<StoredLink> = {}): StoredLink {
  return { id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64, ...stored };
}
/** An engine started with these chats saved, each running on a recorded link. */
async function started(...rows: StoredLink[]) {
  return startedWith({}, ...rows);
}
async function startedWith(options: Partial<NodeOptions>, ...rows: StoredLink[]) {
  for (const r of rows) await db.putLink(r);
  const setup = engine(options);
  await setup.node.start();
  const linkOf = (id: string) => links.find((l) => l.options.params.id === id)!;
  return { ...setup, linkOf };
}
/**
 * A group's link toward a member, opened by hand. The group's session never asked for it, so its next tick (the engine
 * runs one a second) closes it as a link nobody wants: on a busy host that landed in the middle of a test, and a link
 * closed while its row was being written was never made at all. The session's tick is held from here on.
 */
async function openEdge(node: GhostlyNode, state: unknown, member: string): Promise<string> {
  vi.spyOn(node["groups"], "tick").mockResolvedValue();
  return node["openEdge"](state as never, member);
}
const saved = async (id: string) => (await db.getLinks()).find((l) => l.id === id);
const bytes = (text: string) => new TextEncoder().encode(text);

beforeEach(async () => {
  links.length = 0;
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await transact([STORES.links, STORES.messages, STORES.files, STORES.payments], (s) => { for (const n of [STORES.links, STORES.messages, STORES.files, STORES.payments]) s[n].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); vi.restoreAllMocks(); });

describe("a chat as the contact drives it", () => {
  it("the first message from the contact retires the invite, and is stored under the contact's id", async () => {
    const chat = row({ inviteCode: "invite" });
    const { node, events, linkOf } = await started(chat);
    await linkOf(chat.id).options.events.onMessage({ id: "w1", text: "hello", timestamp: Date.now() + 1_000, via: "datalink", nick: "Bob" });
    expect(await db.getMessages(chat.id)).toMatchObject([{ id: "peer_w1", text: "hello", sender: "peer" }]);
    expect(node.getState().links[0].inviteCode).toBeUndefined();
    await vi.waitFor(async () => expect((await saved(chat.id))?.inviteCode).toBeUndefined());
    // It names its chat, so a page can mute that one chat's notifications (apps/ui/src/lib/chatMute.ts).
    expect(events.onAttention).toHaveBeenCalledWith(expect.objectContaining({ type: "message", linkId: chat.id }));
  });

  it("remembers the contact's nick and picture, and writes only what changed", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    const patch = vi.spyOn(db, "patchLink");
    const { events } = linkOf(chat.id).options;
    events.onPeerNick("Bob");
    events.onPeerNick("Bob");
    events.onPresence({ online: true, lastPacketAt: 10, services: null, nick: "Bob" });
    events.onPeerAvatar("data:image/jpeg;base64,AAAA");
    events.onPeerAvatar("data:image/jpeg;base64,AAAA");
    events.onPeerAvatar(null);
    expect(patch.mock.calls.map(([, p]) => p)).toEqual([{ peerNick: "Bob" }, { peerAvatar: "data:image/jpeg;base64,AAAA" }, { peerAvatar: undefined }]);
    expect(node.getState().links[0]).toMatchObject({ peerNick: "Bob", peerOnline: true, peerLastSeenAt: 10, peerAvatar: undefined });
  });

  it("a paired contact's removed name is kept as none, and only the session says it", async () => {
    const chat = row({ peerNick: "Bob" });
    const { node, linkOf } = await started(chat);
    const { events } = linkOf(chat.id).options;
    events.onPeerNick(null);
    expect(node.getState().links[0].peerNick).toBe("");
    await vi.waitFor(async () => expect((await saved(chat.id))?.peerNick).toBe(""));
    // What the record says (possibly older than the session) does not bring it back.
    events.onPresence({ online: false, lastPacketAt: 11, services: null, nick: "Bob" });
    expect(node.getState().links[0].peerNick).toBe("");
    events.onPeerNick("Robert");
    expect(node.getState().links[0].peerNick).toBe("Robert");
  });

  it("a legacy contact's name comes from its record", async () => {
    const chat = row({ profile: undefined, participationSeed: undefined });
    const { node, linkOf } = await started(chat);
    linkOf(chat.id).options.events.onPresence({ online: true, lastPacketAt: 9, services: null, nick: "Old timer" });
    expect(node.getState().links[0].peerNick).toBe("Old timer");
  });

  it("an acknowledgement moves a legacy chat's read mark, never a paired one's", async () => {
    const legacy = row({ profile: undefined, participationSeed: undefined }), paired = row();
    const { node, linkOf } = await started(legacy, paired);
    linkOf(legacy.id).options.events.onPeerAck(42);
    linkOf(paired.id).options.events.onPeerAck(42);
    const view = (id: string) => node.getState().links.find((l) => l.id === id)!;
    expect(view(legacy.id).peerAck).toBe(42);
    expect(view(paired.id).peerAck).toBe(0);
  });

  it("an open data link replays pending payments; a closed one sends the waiting messages back to retry", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    const replay = vi.spyOn(node["desk"], "replay").mockResolvedValue();
    const disconnected = vi.spyOn(node["outboxFor"](chat.id), "disconnected");
    const { events } = linkOf(chat.id).options;
    events.onDataLinkState("open");
    expect(replay).toHaveBeenCalledWith(chat.id);
    events.onPairingState({ status: "error", error: "bad code" });
    events.onDataLinkState("idle");
    expect(disconnected).toHaveBeenCalledOnce();
    expect(node.getState().links[0]).toMatchObject({ dataLink: "idle", pairing: { status: "error" } });
    events.onPairingState({ status: "ready" });
    events.onDataLinkState("connecting");
    expect(node.getState().links[0].pairing).toEqual({ status: "connecting" });
  });

  it("a ready session remembers which ways of paying the contact chose, wallets aside, for requests held while it is away", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    const remember = vi.spyOn(node["hold"], "rememberPeerMethods");
    linkOf(chat.id).options.events.onPairingState({ status: "ready" });
    expect(remember).toHaveBeenCalledWith(chat.id, ["cashu", "lightning"]);
  });

  it("status, polling, discovery and call signals are passed on", async () => {
    const chat = row();
    const { node, events: nodeEvents, linkOf } = await started(chat);
    const { events } = linkOf(chat.id).options;
    events.onStatus("online");
    events.onPoll({ polling: true, nextInMs: 1_000 });
    events.onDiscoveryError("no relay");
    events.onCallSignal("offer");
    await events.onTransportDiscovery({ "iroh/1": {} }, ["iroh/1"], false);
    expect(node.getState().links[0]).toMatchObject({ status: "online", poll: { polling: true, interval: 1_000 }, discoveryError: "no relay" });
    expect(node.getState().links[0].lastSyncAt).toBeGreaterThan(0);
    expect(nodeEvents.onCallSignal).toHaveBeenCalledWith(chat.id, "offer");
    expect(await saved(chat.id)).toMatchObject({ peerTransports: ["iroh/1"], peerFallback: false });
  });

  it("a chat that never synced and whose reads fail (no network) shows its first sync under way once, not a state at every read", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    const { events } = linkOf(chat.id).options;
    const emit = vi.spyOn(node as unknown as { emitState(): void }, "emitState");
    events.onPoll({ polling: true, nextInMs: 0 });
    expect(node.getState().links[0].poll.polling, "the first sync under way").toBe(true);
    events.onStatus("error");
    events.onPoll({ polling: false, nextInMs: 2_000 });
    expect(node.getState().links[0].poll.polling).toBe(false);
    const first = emit.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) {
      events.onPoll({ polling: true, nextInMs: 0 });
      // A read under way after the first one is no first sync under way: the list shows none, whenever it is drawn.
      expect(node.getState().links[0].poll.polling).toBe(false);
      events.onStatus("error");
      events.onPoll({ polling: false, nextInMs: 2_000 });
    }
    expect(emit.mock.calls.length - first, "ten failed reads").toBe(0);
    // The read that works is news: the chat synced.
    events.onPoll({ polling: true, nextInMs: 0 });
    events.onStatus("online");
    expect(emit.mock.calls.length).toBeGreaterThan(first);
    expect(node.getState().links[0].lastSyncAt).toBeGreaterThan(0);
  });

  it("once paired, the chat is pinned to that contact: another key is refused, and a failed save pins nothing", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    const { pairing } = linkOf(chat.id).options;
    const first = createIdentity().pubKeyZ32;
    const pin = vi.spyOn(db, "pinPeer").mockRejectedValueOnce(new Error("disk full"));
    await expect(pairing.pinPeer(first, true)).rejects.toThrow("disk full");
    expect(node["links"].get(chat.id)!.stored.pairedPeerKey).toBeUndefined();
    pin.mockRestore();
    await pairing.pinPeer(first, true);
    await expect(pairing.pinPeer(createIdentity().pubKeyZ32, true)).rejects.toThrow("Already paired");
    await pairing.verifyPeer!(first);
    expect(await saved(chat.id)).toMatchObject({ pairedPeerKey: first, requireSignedSignals: true, peerTrust: { verifiedKey: first } });
    expect(node.getState().links[0]).toMatchObject({ peerVerified: true, peerParticipationKey: first });
  });
});

describe("an app restarting (WISP 100, Back after a restart)", () => {
  /** A native endpoint that never connects: what these tests read is how each link was made. */
  const idle = (transport: "iroh/1" | "hyperdht/1") => vi.fn(async () => ({ transport, descriptor: { id: "ab".repeat(32), relay: "https://relay.test./", addresses: [] },
    connect: vi.fn(), close: vi.fn(async () => {}), onConnection: null, onDescriptor: null }));
  /** An app that runs every transport: WebRTC, Iroh and HyperDHT. */
  const everything = () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    onTestFinished(() => { vi.unstubAllGlobals(); });
    return { nativeTransports: { "iroh/1": idle("iroh/1"), "hyperdht/1": idle("hyperdht/1") } } as unknown as Partial<NodeOptions>;
  };

  it("a chat live when the app last ran resumes on that transport; one that ended off live, DHT only or unpaired does not", async () => {
    const paired = { pairedPeerKey: createIdentity().pubKeyZ32 };
    const live = row({ ...paired, transportHistory: [{ at: 1, kind: "live", transport: "iroh/1" }] });
    const switched = row({ ...paired, transportHistory: [{ at: 1, kind: "live", transport: "webrtc/1" }, { at: 2, kind: "switched", from: "webrtc/1", transport: "hyperdht/1" }] });
    const dropped = row({ ...paired, transportHistory: [{ at: 1, kind: "live", transport: "iroh/1" }, { at: 2, kind: "down", from: "iroh/1" }] });
    const dhtOnly = row({ ...paired, deliveryMode: "dht", transportHistory: [{ at: 1, kind: "live", transport: "iroh/1" }] });
    const unpaired = row({ transportHistory: [{ at: 1, kind: "live", transport: "iroh/1" }] });
    const { linkOf } = await startedWith(everything(), live, switched, dropped, dhtOnly, unpaired);
    expect([live, switched, dropped, dhtOnly, unpaired].map(chat => linkOf(chat.id).options.resume))
      .toEqual(["iroh/1", "hyperdht/1", undefined, undefined, undefined]);
  });

  it("a chat not live again within the contact's liveness bound is not resumed at the next start; one live again is", async () => {
    // #966 follow-up: a chat that never came back after its last live stretch said "live at last run" at every start,
    // and knocked every time (all ten chats of the repro).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    onTestFinished(() => { vi.useRealTimers(); });
    const paired = () => ({ pairedPeerKey: createIdentity().pubKeyZ32 });
    const gone = row({ ...paired(), transportHistory: [{ at: 1, kind: "live", transport: "iroh/1" }] });
    const back = row({ ...paired(), transportHistory: [{ at: 1, kind: "live", transport: "iroh/1" }] });
    const runs = everything();
    const first = await startedWith(runs, gone, back);
    expect([gone, back].map((chat) => first.linkOf(chat.id).options.resume)).toEqual(["iroh/1", "iroh/1"]);
    // One is live again in this run; the other's contact never comes back.
    first.node["links"].get(back.id)!.pairing = { status: "ready", transport: "iroh/1" } as never;
    first.node["links"].get(back.id)!.dataLink = "open";
    first.node["observeTransport"](back.id);
    // Not yet past the bound: a run this short says nothing (the contact may still hold the session).
    await vi.advanceTimersByTimeAsync(RESUME_SPENT_MS - 1_000);
    expect((await saved(gone.id))?.transportHistory).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(async () => expect((await saved(gone.id))?.transportHistory?.at(-1)).toMatchObject({ kind: "down", from: "iroh/1", restart: true }));
    expect((await saved(back.id))?.transportHistory?.at(-1)).toMatchObject({ kind: "live", transport: "iroh/1" });
    await first.node.shutdown();
    nodes.splice(nodes.indexOf(first.node), 1);
    links.length = 0;
    const again = await startedWith(runs);
    expect([gone, back].map((chat) => again.linkOf(chat.id).options.resume)).toEqual([undefined, "iroh/1"]);
  });

  it("after a handoff from a device that ran a transport this app lacks: resumed on one both run, with no floor of that device's session", async () => {
    // WISP 06: the Desktop on Linux was live with the contact on HyperDHT when the profile moved back to this web page,
    // which runs WebRTC and no HyperDHT. Resumed on HyperDHT, the link held every dial for its wait and never knocked.
    vi.stubGlobal("RTCPeerConnection", class {});
    onTestFinished(() => { vi.unstubAllGlobals(); });
    const paired = () => ({ pairedPeerKey: createIdentity().pubKeyZ32 });
    const fromLinux = row({ ...paired(), peerTransports: ["webrtc/1", "iroh/1", "hyperdht/1"], transportHistory: [{ at: 1, kind: "live", transport: "hyperdht/1" }] });
    const nothingShared = row({ ...paired(), peerTransports: ["hyperdht/1"], transportHistory: [{ at: 1, kind: "live", transport: "hyperdht/1" }] });
    const own = row({ ...paired(), peerTransports: ["webrtc/1"], transportHistory: [{ at: 5, kind: "live", transport: "webrtc/1" }] });
    const { linkOf } = await started(fromLinux, nothingShared, own);
    expect([fromLinux, nothingShared, own].map((chat) => linkOf(chat.id).options.resume)).toEqual(["webrtc/1", undefined, "webrtc/1"]);
    expect([fromLinux, nothingShared, own].map((chat) => linkOf(chat.id).options.resumeFloor)).toEqual([undefined, undefined, 5]);
  });

  // covers: transport.native-pool
  describe("more paired chats than native slots (eight per transport)", () => {
    const paired = () => ({ pairedPeerKey: createIdentity().pubKeyZ32 });
    const endpoint = () => ({ transport: "iroh/1" as const, descriptor: { id: "ab".repeat(32), relay: "https://relay.test./", addresses: [] },
      connect: vi.fn(), close: vi.fn(async () => {}), onConnection: null, onDescriptor: null });
    /** Started as a Linux Desktop is: Iroh native, no WebRTC to fall back on. */
    async function nativeStarted(...rows: StoredLink[]) {
      for (const r of rows) await db.putLink(r);
      const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() };
      const node = new GhostlyNode(events, { automaticWallets: false, transport: fixture, nativeTransports: { "iroh/1": vi.fn(async () => endpoint()) } });
      nodes.push(node);
      await node.start();
      await node["nativeQueue"];
      const linkOf = (id: string) => links.filter((l) => l.options.params.id === id).at(-1)! as unknown as Recorded & {
        registerEndpoint: ReturnType<typeof vi.fn>; releaseEndpoint: ReturnType<typeof vi.fn>; canReleaseEndpoint: ReturnType<typeof vi.fn> };
      return { node, linkOf };
    }
    // Stored first (the links store reads back in id order), each idle since long ago.
    const older = () => Array.from({ length: 10 }, (_, i) => row({ ...paired(), id: `chat-a${i}` }));

    it("the chat live most recently takes one first, among chats live when the app quit", async () => {
      // Omarchy (2026-09-30): both apps restarted, and the chat they had just been live in got no listener on one side:
      // the chats stored before it took all eight. Its contact dialled it every 20 s for minutes, never answered.
      const now = Date.now();
      const liveLongAgo = { transportHistory: [{ at: now - 3_600_000, kind: "live" as const, transport: "iroh/1" as const }] };
      const rows = [...older().map((r, i) => i < 8 ? { ...r, ...liveLongAgo } : r),
        row({ ...paired(), id: "chat-z", transportHistory: [{ at: now - 60_000, kind: "live", transport: "iroh/1" }] })];
      const { linkOf } = await nativeStarted(...rows);
      const listening = rows.filter((r) => linkOf(r.id).registerEndpoint.mock.calls.length > 0).map((r) => r.id);
      expect(listening).toHaveLength(8);
      expect(listening).toContain("chat-z");
      expect(listening).not.toContain("chat-a8");
      expect(listening).not.toContain("chat-a9");
    });

    it("a chat whose contact left just before this app quit, ahead of chats live when an older run ended", async () => {
      // Both apps quitting together: one hears the other's goodbye first and the chat ends off live there. The chats
      // that were live an hour ago and never came back since still end on that live stretch, run after run.
      const now = Date.now();
      const liveLongAgo = { transportHistory: [{ at: now - 3_600_000, kind: "live" as const, transport: "iroh/1" as const }] };
      const droppedLately = row({ ...paired(), id: "chat-y", transportHistory: [{ at: now - 60_000, kind: "live", transport: "iroh/1" }, { at: now - 5_000, kind: "down", from: "iroh/1" }] });
      const rows = [...older().map((r) => ({ ...r, ...liveLongAgo })), droppedLately];
      const { linkOf } = await nativeStarted(...rows);
      const listening = rows.filter((r) => linkOf(r.id).registerEndpoint.mock.calls.length > 0).map((r) => r.id);
      expect(listening).toHaveLength(8);
      expect(listening).toContain("chat-y");
    });

    it("on an app with WebRTC, chats whose contact has none take them first, each class most recent first", async () => {
      // #966 follow-up: a web app's listeners went to its most recent chats, contacts with WebRTC among them, and a
      // Linux Desktop (or a CLI with WebRTC off), which can reach it only natively, was left with none.
      vi.stubGlobal("RTCPeerConnection", class {});
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const now = Date.now();
      const record = (transports: string[]) => ({ rev: 1, issued: now, author: createIdentity().pubKeyZ32, versions: [1], transports,
        capabilities: [], extensions: [], descriptors: {}, name: "" });
      const liveAt = (at: number) => [{ at, kind: "live" as const, transport: "iroh/1" as const }];
      const withRtc = Array.from({ length: 8 }, (_, i) => row({ ...paired(), id: `chat-w${i}`, transportHistory: liveAt(now - (i + 1) * 60_000),
        capsState: { rev: 1, peer: record(["iroh/1", "hyperdht/1", "webrtc/1"]) } }));
      const nativeOnly = [0, 1].map((i) => row({ ...paired(), id: `chat-n${i}`, transportHistory: liveAt(now - (i + 1) * 3_600_000),
        capsState: { rev: 1, peer: record(["iroh/1"]) } }));
      const rows = [...withRtc, ...nativeOnly];
      const { linkOf } = await nativeStarted(...rows);
      const listening = rows.filter((r) => linkOf(r.id).registerEndpoint.mock.calls.length > 0).map((r) => r.id);
      expect(listening).toHaveLength(8);
      expect(listening).toEqual(expect.arrayContaining(["chat-n0", "chat-n1"]));
      // Among the contacts with WebRTC, #966's order: the two least recent are the ones left without.
      expect(listening).not.toContain("chat-w6");
      expect(listening).not.toContain("chat-w7");
    });

    it("the chat on screen gets one as soon as one is free, when every one was busy as it opened", async () => {
      const rows = [...older().slice(0, 8), row({ ...paired(), id: "chat-z" })];
      const { node, linkOf } = await nativeStarted(...rows);
      const holders = rows.slice(0, 8).map((r) => linkOf(r.id));
      for (const holder of holders) expect(holder.registerEndpoint).toHaveBeenCalled();
      // Each one dialling its contact (an app back after a restart dials every chat at once): none can let go.
      for (const holder of holders) holder.canReleaseEndpoint.mockReturnValue(false);
      node.setActiveLink({ linkId: "chat-z" });
      await node["nativeQueue"];
      expect(linkOf("chat-z").registerEndpoint).not.toHaveBeenCalled();
      expect(node.getState().links.find((l) => l.id === "chat-z")?.transportErrors?.["iroh/1"]).toMatch(/slots are in use/);
      // A dial ends (it timed out): that chat can let its listener go, and the chat on screen takes it.
      holders[3].canReleaseEndpoint.mockReturnValue(true);
      await vi.waitFor(() => expect(linkOf("chat-z").registerEndpoint).toHaveBeenCalled(), { timeout: 10_000 });
      expect(holders.filter((h) => h.releaseEndpoint.mock.calls.length > 0)).toEqual([holders[3]]);
    }, 15_000);

    describe("every listener carrying a live session (a Linux Desktop or a CLI bot talking to more contacts than that)", () => {
      type Holder = Recorded & { registerEndpoint: ReturnType<typeof vi.fn>; releaseEndpoint: ReturnType<typeof vi.fn>; canReleaseEndpoint: ReturnType<typeof vi.fn>;
        yieldEndpoint: ReturnType<typeof vi.fn>; lastActivityAt: number; callOn: boolean };
      /** Eight chats live over Iroh, each last used this many minutes ago, and a ninth with no listener. */
      async function allLive(minutesAgo: number[], ninth: Partial<StoredLink> = {}) {
        const rows = [...older().slice(0, 8), row({ ...paired(), id: "chat-z", ...ninth })];
        const started = await nativeStarted(...rows);
        const linkOf = (id: string) => started.linkOf(id) as unknown as Holder;
        const holders = rows.slice(0, 8).map((r) => linkOf(r.id));
        const now = Date.now();
        holders.forEach((holder, i) => {
          expect(holder.registerEndpoint).toHaveBeenCalled();
          // Each carries a session: none can simply let its listener go.
          holder.canReleaseEndpoint.mockReturnValue(false);
          holder.lastActivityAt = now - minutesAgo[i] * 60_000;
        });
        const nine = linkOf("chat-z");
        nine.isDataLinkOpen = false;
        expect(nine.registerEndpoint).not.toHaveBeenCalled();
        return { node: started.node, linkOf, holders, nine };
      }
      const yielded = (holders: Holder[]) => holders.filter((h) => h.yieldEndpoint.mock.results.some((r) => r.type === "return"
        && !h.availableTransports.includes("iroh/1")));

      it("the chat on screen takes the listener of the session unused longest, once that is two minutes", async () => {
        // #1006: chat ten, made while eight others were live over Iroh, stayed "On DHT · retrying live" for as long as they did.
        const { node, holders, nine } = await allLive([1, 5, 3, 9, 0, 2.5, 4, 1]);
        node.setActiveLink({ linkId: "chat-z" });
        await node["nativeQueue"];
        expect(nine.registerEndpoint).toHaveBeenCalled();
        expect(yielded(holders)).toEqual([holders[3]]);
        expect(holders[3].yieldEndpoint).toHaveBeenCalledWith("iroh/1", NATIVE_HOLD_MS);
        expect(node.getState().links.find((l) => l.id === "chat-z")?.transportErrors?.["iroh/1"]).toBeUndefined();
        expect(node.getState().links.find((l) => l.id === holders[3].options.params.id)?.transportErrors?.["iroh/1"]).toMatch(/quiet/);
      });

      it("never one with a call on, nor one used in the last two minutes: the chat on screen waits until one goes quiet", async () => {
        const { node, holders, nine } = await allLive([1, 1, 30, 1, 1, 1, 1, 1]);
        // The quietest has a call on: its media runs elsewhere, the session itself says nothing for half an hour.
        holders[2].callOn = true;
        node.setActiveLink({ linkId: "chat-z" });
        await node["nativeQueue"];
        expect(nine.registerEndpoint).not.toHaveBeenCalled();
        expect(yielded(holders)).toEqual([]);
        expect(node.getState().links.find((l) => l.id === "chat-z")?.transportErrors?.["iroh/1"]).toMatch(/slots are in use/);
        // One goes quiet: the chat on screen, asking again in a moment, takes its listener.
        holders[5].lastActivityAt = Date.now() - 3 * 60_000;
        await vi.waitFor(() => expect(nine.registerEndpoint).toHaveBeenCalled(), { timeout: 10_000 });
        expect(yielded(holders)).toEqual([holders[5]]);
      }, 15_000);

      it("no ping-pong: the chat a listener was taken from does not take it straight back", async () => {
        const { node, holders, nine } = await allLive([10, 1, 1, 1, 1, 1, 1, 1]);
        node.setActiveLink({ linkId: "chat-z" });
        await node["nativeQueue"];
        expect(yielded(holders)).toEqual([holders[0]]);
        // Back to the chat it was taken from, while the ninth still dials (no session: it could simply let go).
        node.setActiveLink({ linkId: holders[0].options.params.id });
        await node["nativeQueue"];
        expect(nine.releaseEndpoint).not.toHaveBeenCalled();
        expect(nine.availableTransports).toContain("iroh/1");
        expect(holders[0].registerEndpoint).toHaveBeenCalledOnce();
        // Live now, and just used: still not.
        nine.isDataLinkOpen = true;
        nine.lastActivityAt = Date.now();
        node.setActiveLink({ linkId: holders[0].options.params.id });
        await node["nativeQueue"];
        expect(nine.availableTransports).toContain("iroh/1");
        expect(holders[0].registerEndpoint).toHaveBeenCalledOnce();
        node.setActiveLink({ linkId: null });
      });

      it("on an app with WebRTC, a chat whose contact has WebRTC too ends nobody's session for one", async () => {
        vi.stubGlobal("RTCPeerConnection", class {});
        onTestFinished(() => { vi.unstubAllGlobals(); });
        const record = (transports: string[]) => ({ rev: 1, issued: Date.now(), author: createIdentity().pubKeyZ32, versions: [1], transports,
          capabilities: [], extensions: [], descriptors: {}, name: "" });
        const { node, holders, nine } = await allLive([10, 9, 8, 7, 6, 5, 4, 3], { capsState: { rev: 1, peer: record(["iroh/1", "webrtc/1"]) } });
        node.setActiveLink({ linkId: "chat-z" });
        await node["nativeQueue"];
        expect(nine.registerEndpoint).not.toHaveBeenCalled();
        expect(yielded(holders)).toEqual([]);
        node.setActiveLink({ linkId: null });
      });

      it("a text over the DHT in a chat not on screen takes one too: a bot has no chat on screen", async () => {
        const { node, holders, nine } = await allLive([3, 4, 5, 6, 7, 8, 9, 10]);
        await nine.options.events.onMessage({ id: "dht-1", text: "are you there?", timestamp: Date.now(), via: "pkarr" });
        await node["nativeQueue"];
        expect(nine.registerEndpoint).toHaveBeenCalled();
        expect(yielded(holders)).toEqual([holders[7]]);
      });
    });
  });

  it("shutting down says goodbye on every link before anything else it waits for", async () => {
    const chat = row({ pairedPeerKey: createIdentity().pubKeyZ32 });
    const { node, linkOf } = await started(chat);
    const link = linkOf(chat.id) as unknown as { depart: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    const stopping = node.shutdown();
    // Said synchronously, as the page may be gone by the next tick.
    expect(link.depart).toHaveBeenCalledOnce();
    await stopping;
    expect(link.stop).toHaveBeenCalled();
    expect(link.depart.mock.invocationCallOrder[0]).toBeLessThan(link.stop.mock.invocationCallOrder[0]);
  });

  it("after the goodbye nothing more goes out: the links and their records stop at once, whatever else the stop still waits for", async () => {
    const publish = vi.spyOn(fixture, "publish");
    const chat = row({ pairedPeerKey: createIdentity().pubKeyZ32 });
    const { node, linkOf } = await started(chat);
    const caps = node["links"].get(chat.id)!.caps!;
    const records = () => publish.mock.calls.filter(([identity]) => (identity as { pubKeyZ32: string }).pubKeyZ32 === caps.address).length;
    await vi.waitFor(() => expect(records()).toBe(1));
    // Held items still being written: the stop waits for them, and no longer than that.
    const writing = new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    vi.spyOn(node["hold"], "stop").mockImplementation(() => writing);
    let done = false;
    const stopping = node.shutdown().then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 20));
    // The link's own stop sends its leave packet, the last word; nothing it would dial or offer next goes out.
    expect(linkOf(chat.id).stop).toHaveBeenCalledWith(true);
    // A record due again meanwhile (its content changed, past the spacing) is not published either.
    (caps as unknown as { state: { publishedAt: number } }).state.publishedAt -= 60_000;
    (linkOf(chat.id) as unknown as { setHoldSupport: () => void }).setHoldSupport = vi.fn();
    await node.setChatHold({ linkId: chat.id, enabled: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(records()).toBe(1);
    expect(done, "the hold's writes are waited for").toBe(false);
    await stopping;
    nodes.splice(nodes.indexOf(node), 1);
  });

  it("stops what it waits for side by side: slow wallets, the hold and the links take as long as the slowest, not their sum", async () => {
    const chat = row({ pairedPeerKey: createIdentity().pubKeyZ32 });
    const { node, linkOf } = await started(chat);
    const slow = () => new Promise<void>((resolve) => setTimeout(resolve, 300));
    for (const kind of ["arkWallets", "barkWallets", "fedimintWallets", "sparkWallets", "usdtWallets", "lightnings", "bitcoins"] as const) {
      for (const wallet of Object.values(node[kind] as Record<string, { stop(): Promise<void> }>)) vi.spyOn(wallet, "stop").mockImplementation(slow);
    }
    vi.spyOn(node["wallet"], "stop").mockImplementation(slow);
    vi.spyOn(node["hold"], "stop").mockImplementation(slow);
    linkOf(chat.id).stop.mockImplementation(slow);
    const began = Date.now();
    await node.shutdown();
    nodes.splice(nodes.indexOf(node), 1);
    // One by one this was 17 waits of 300 ms (5 s).
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(linkOf(chat.id).stop).toHaveBeenCalled();
  }, 15_000);

  it("does not wait for a native listener still starting, and dials nothing once it is up: it is closed", async () => {
    // HyperDHT takes seconds to listen on a busy machine: a daemon stopped soon after it started waited 3 to 5 s for it.
    const close = vi.fn(async () => {});
    const made = { transport: "iroh/1" as const, descriptor: { id: "ab".repeat(32), relay: "https://relay.test./", addresses: [] },
      connect: vi.fn(), close, onConnection: null, onDescriptor: null };
    const iroh = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(made), 2_000)));
    // The side that dials a native contact as soon as its listeners are up (the lower key).
    const [mine, theirs] = [createIdentity(), createIdentity()].sort((a, b) => (a.pubKeyZ32 < b.pubKeyZ32 ? -1 : 1));
    const chat = row({ seedB64: mine.seedB64, peerPubKeyZ32: theirs.pubKeyZ32, pairedPeerKey: createIdentity().pubKeyZ32, peerTransports: ["iroh/1"] });
    const { node, linkOf } = await startedWith({ nativeTransports: { "iroh/1": iroh } } as unknown as Partial<NodeOptions>, chat);
    await vi.waitFor(() => expect(iroh).toHaveBeenCalled());
    let done = false;
    const stopping = node.shutdown().then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 100));
    expect(done).toBe(true);
    await vi.waitFor(() => expect(close).toHaveBeenCalled(), { timeout: 3_000 });
    // A dial after the goodbye was an offer published 3 s after it (#1452).
    expect(linkOf(chat.id).connect).not.toHaveBeenCalled();
    await stopping;
    nodes.splice(nodes.indexOf(node), 1);
  });
});

describe("the capability record of a chat (WISP 03)", () => {
  it("is published once for its content, and again when what it says changes", async () => {
    const publish = vi.spyOn(fixture, "publish");
    const chat = row({ pairedPeerKey: createIdentity().pubKeyZ32 });
    const { node, linkOf } = await started(chat);
    // Only what goes to the record's own key: the engine publishes presence and warmed invites too.
    const address = node["links"].get(chat.id)!.caps!.address;
    const records = () => publish.mock.calls.filter(([identity]) => (identity as { pubKeyZ32: string }).pubKeyZ32 === address).length;
    await vi.waitFor(() => expect(records()).toBe(1));
    await vi.waitFor(async () => expect((await saved(chat.id))?.capsState).toMatchObject({ rev: 1 }));
    node["capsChanged"](chat.id);
    await new Promise(r => setTimeout(r, 20));
    expect(records(), "nothing changed").toBe(1);
    (linkOf(chat.id) as unknown as { setHoldSupport: () => void }).setHoldSupport = vi.fn();
    // Past the spacing between two publications (CAPS_PUBLISH_SPACING_MS), as a person turning Hold on later is.
    (node["links"].get(chat.id)!.caps as unknown as { state: { publishedAt: number } }).state.publishedAt -= 60_000;
    await node.setChatHold({ linkId: chat.id, enabled: true });
    await vi.waitFor(() => expect(records()).toBe(2));
    await vi.waitFor(async () => expect((await saved(chat.id))?.capsState?.rev).toBe(2));
  });

  it("while no session is open, gives the contact's name, hold consent and ways of paying", async () => {
    const chat = row({ peerNick: "" });
    const { node, linkOf } = await started(chat);
    linkOf(chat.id).isDataLinkOpen = false;
    const said = vi.spyOn(node["hold"], "peerSaid"), methods = vi.spyOn(node["hold"], "rememberPeerMethods");
    const record = { rev: 3, issued: 1, author: createIdentity().pubKeyZ32, versions: [1], transports: ["webrtc/1"], extensions: [], descriptors: {},
      capabilities: ["chat/1", "dht-text/1", "hold/1", "payments/1", "payments-lightning/1"], name: "Bob", choice: "iroh/1" };
    node["peerCapsChanged"](chat.id, record);
    expect(node.getState().links[0].peerNick).toBe("Bob");
    // A choice the contact made meanwhile, from a record just read (WISP 100): the link tells it and dials it first.
    expect(linkOf(chat.id).learnPeerChoice).toHaveBeenCalledWith("iroh/1", true);
    expect(said).toHaveBeenCalledWith(chat.id, { peerAllows: true });
    expect(methods).toHaveBeenCalledWith(chat.id, ["lightning"]);
    // On an open session the session's own word stands.
    linkOf(chat.id).isDataLinkOpen = true;
    node["peerCapsChanged"](chat.id, { ...record, rev: 4, name: "Mallory" });
    expect(node.getState().links[0].peerNick).toBe("Bob");
  });
});

describe("files a contact sends", () => {
  async function incoming() {
    const chat = row();
    const setup = await started(chat);
    const events = setup.linkOf(chat.id).options.events;
    const announce = (id: string, size = 5, timestamp = 7) => events.onFileIncoming({ id, name: "a.txt", size, mime: "text/html", timestamp }) as FileSink | string;
    return { ...setup, chat, events, announce };
  }

  it("keeps the bytes under a local id of its own, served as something inert, and shows the transfer done", async () => {
    const { node, chat, events, announce } = await incoming();
    // The "." is outside the base64url alphabet of a local id, so no random id can contain this one by chance.
    const wire = "w.1";
    const sink = announce(wire) as FileSink;
    sink.write(bytes("hello"));
    events.onFileProgress(wire, 3, "in");
    const [file] = await vi.waitFor(async () => { const m = await db.getMessages(chat.id); expect(m).toHaveLength(1); return m.map((x) => x.file!); });
    expect(file.id).toMatch(new RegExp(`^${chat.id}-in-[A-Za-z0-9_-]{16}$`));
    expect(file.id).not.toContain(wire);
    expect(node.getState().transfers[file.id]).toMatchObject({ state: "transferring", transferred: 3 });
    await sink.close("digest-1");
    events.onFileComplete(wire, "in");
    expect(node.getState().transfers[file.id]).toMatchObject({ state: "done", transferred: 5 });
    const stored = await fileStore.get(file.id);
    expect(stored).toMatchObject({ direction: "in", wireId: wire, digest: "digest-1", metadata: { name: "a.txt", mime: "text/html" } });
    // Written to file storage as it came, never gathered whole: here IndexedDB pieces, the tests' storage.
    expect(stored!.blob).toBeUndefined();
    expect(stored!.bytes).toBe("idb");
    expect(await (await storedBlob(stored!, "application/octet-stream"))!.text()).toBe("hello");
    // Asked whether it is already here: only an exact match of what was announced says yes.
    expect(await events.onFileStored({ id: wire, name: "a.txt", size: 5, mime: "text/html", timestamp: 7 })).toBe("digest-1");
    expect(await events.onFileStored({ id: wire, name: "b.txt", size: 5, mime: "text/html", timestamp: 7 })).toBeUndefined();
  });

  it("the app has a file's transfer before the message that shows it: a file still arriving never reads as gone", async () => {
    const { node, chat, announce } = await incoming();
    // The engine's own events (what the app hears), not the link's.
    const events = node["events"] as unknown as { onState: ReturnType<typeof vi.fn>; onMessages: ReturnType<typeof vi.fn> };
    // Whatever the start left to say has been said.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const order: string[] = [];
    events.onState.mockImplementation((state: { transfers: Record<string, unknown> }) => {
      if (Object.keys(state.transfers).some((id) => id.startsWith(`${chat.id}-in-`))) order.push("transfer");
    });
    events.onMessages.mockImplementation((_linkId: string, messages: { file?: unknown }[]) => { if (messages.some((m) => m.file)) order.push("message"); });
    announce("w.first");
    await vi.waitFor(() => expect(order).toContain("message"));
    expect(order[0]).toBe("transfer");
  });

  it("a wire id is used once, and a contact cannot announce more than the room it has here", async () => {
    const { node, chat, events, announce } = await incoming();
    expect(typeof announce("w1")).toBe("object");
    expect(announce("w1")).toBe("duplicate file id");
    expect(announce("big", LIMITS.maxStoredIncomingBytesPerPeer)).toBe("no room for more files");
    // A transfer that failed gives its room and its id back.
    events.onFileFailed("w1", "cancelled", "in");
    expect(node["links"].get(chat.id)!.files.receivedBytes).toBe(0);
    expect(typeof announce("w1", 5, 8)).toBe("object");
    expect(node["receiveFile"]("unknown", { id: "x", name: "x", size: 1, mime: "", timestamp: 1 }), "a chat that is not there").toBe("refused");
  });

  it("two files announced at the same time each get a message of their own: no bytes without one", async () => {
    const { chat, events, announce } = await incoming();
    const first = announce("w1", 5, 9) as FileSink, second = announce("w2", 5, 9) as FileSink;
    for (const sink of [first, second]) sink.write(bytes("hello"));
    await first.close("d1"); await second.close("d2");
    events.onFileComplete("w1", "in"); events.onFileComplete("w2", "in");
    const messages = await db.getMessages(chat.id);
    expect(messages.map((m) => m.wireId).sort()).toEqual(["w1", "w2"]);
    // The first keeps the id the sender's reactions, edits and deletes name; the other has one of its own.
    expect(messages.find((m) => m.wireId === "w1")!.id).toBe("peer_9");
    expect(messages.find((m) => m.wireId === "w2")!.id).not.toBe("peer_9");
    const stored = await fileStore.listForLink(chat.id);
    expect(stored.map((f) => f.id).sort()).toEqual(messages.map((m) => m.file!.id).sort());
    // Nor does a message already there at that time take a file's place (an app whose texts are named by their time).
    await db.addMessage({ linkId: chat.id, id: "peer_11", text: "hi", sender: "peer", timestamp: 11, via: "datalink" });
    const third = announce("w3", 5, 11) as FileSink;
    third.write(bytes("hello")); await third.close("d3");
    const after = await db.getMessages(chat.id);
    expect(after.find((m) => m.id === "peer_11")!.text).toBe("hi");
    expect(after.find((m) => m.wireId === "w3")!.file!.id).toBe((await fileStore.listForLink(chat.id)).find((f) => f.wireId === "w3")!.id);
  });

  it("a file sent again after its transfer failed lands in the message it had, not in bytes of nobody's", async () => {
    const { chat, events, announce } = await incoming();
    const first = announce("w1", 5, 9) as FileSink;
    await vi.waitFor(async () => expect(await db.getMessages(chat.id)).toHaveLength(1));
    first.abort();
    events.onFileFailed("w1", "cancelled", "in");
    const again = announce("w1", 5, 9) as FileSink;
    again.write(bytes("hello")); await again.close("d1");
    events.onFileComplete("w1", "in");
    const messages = await db.getMessages(chat.id);
    expect(messages).toHaveLength(1);
    const [stored] = await fileStore.listForLink(chat.id);
    expect(messages[0].file!.id).toBe(stored.id);
  });

  it("a cancelled transfer or one whose message was deleted leaves no bytes behind", async () => {
    const { node, chat, announce } = await incoming();
    const cancelled = announce("w1", 5, 1) as FileSink;
    cancelled.write(bytes("hello"));
    cancelled.abort();
    await expect(cancelled.close()).rejects.toThrow("cancelled");
    const deleted = announce("w2", 5, 2) as FileSink;
    await vi.waitFor(async () => expect(await db.getMessages(chat.id)).toHaveLength(2));
    node.deleteMessage({ linkId: chat.id, messageId: "peer_2" });
    await expect(deleted.close()).rejects.toThrow("deleted");
    expect(await fileStore.listForLink(chat.id)).toEqual([]);
  });

  it("files received before a restart still count against the contact's room; interrupted transfers show as failed", async () => {
    const chat = row();
    await db.putLink(chat);
    const blob = new Blob([new Uint8Array(1_000)]);
    await fileStore.put({ id: `${chat.id}-in-a`, linkId: chat.id, blob, createdAt: 1, direction: "in", wireId: "a" });
    await fileStore.put({ id: `${chat.id}-legacy`, linkId: chat.id, blob, createdAt: 1 });
    await fileStore.put({ id: `${chat.id}-out-b`, linkId: chat.id, blob, createdAt: 1, direction: "out", wireId: "b", transfer: { state: "transferring", transferred: 10, size: 1_000 } });
    await db.addMessage({ linkId: chat.id, id: "peer_1", text: "📎", sender: "peer", timestamp: 1, via: "datalink", file: { id: `${chat.id}-legacy`, name: "l", size: 1_000, mime: "" } });
    const { node, linkOf } = await started();
    const live = node["links"].get(chat.id)!;
    expect(live.files.receivedBytes).toBe(2_000);
    expect([...live.files.wireIds].sort()).toEqual(["a", "b", "legacy"]);
    expect(node.getState().transfers[`${chat.id}-out-b`]).toMatchObject({ state: "failed", error: expect.stringContaining("interrupted") });
    expect(linkOf(chat.id).options.events.onFileIncoming({ id: "a", name: "x", size: 1, mime: "", timestamp: 3 })).toBe("duplicate file id");
  });

  it("asked whether it holds a file, a chat that never took it reads none of its stored files", async () => {
    const chat = row();
    await db.putLink(chat);
    const wire = { id: "a", name: "a.txt", size: 5, mime: "text/plain", timestamp: 7 };
    await fileStore.put({ id: `${chat.id}-in-a`, linkId: chat.id, blob: new Blob([bytes("hello")]), createdAt: 1, direction: "in", wireId: "a", digest: "digest-a",
      metadata: { name: wire.name, size: wire.size, mime: wire.mime, timestamp: wire.timestamp } });
    const { linkOf } = await started();
    const { onFileStored } = linkOf(chat.id).options.events;
    const stored = vi.spyOn(fileStore, "listForLink");
    // A new file, as nearly every one is: the chat knows the wire ids it holds, and this is none of them.
    expect(await onFileStored!({ ...wire, id: "new" })).toBeUndefined();
    expect(stored).not.toHaveBeenCalled();
    // One it holds is answered with its digest, when the question names the same file.
    expect(await onFileStored!(wire)).toBe("digest-a");
    expect(await onFileStored!({ ...wire, size: 6 })).toBeUndefined();
  });
});

describe("files sent to a contact", () => {
  it("streams the stored bytes and records the transfer; nothing starts twice", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    const file = { id: `${chat.id}-out-w1`, name: "a.txt", size: 5, mime: "text/plain" };
    await fileStore.put({ id: file.id, linkId: chat.id, blob: new Blob([bytes("hello")]), createdAt: 1, direction: "out", wireId: "w1" });
    node.sendFile({ linkId: chat.id, file, timestamp: 3 });
    node.sendFile({ linkId: chat.id, file, timestamp: 3 });
    const link = linkOf(chat.id);
    await vi.waitFor(() => expect(link.sendFile).toHaveBeenCalledOnce());
    expect(link.sendFile.mock.calls[0][0]).toEqual({ id: "w1", name: "a.txt", size: 5, mime: "text/plain", timestamp: 3 });
    await vi.waitFor(() => expect(new TextDecoder().decode(link.sent[0])).toBe("hello"));
    link.options.events.onFileProgress("w1", 5, "out");
    link.options.events.onFileComplete("w1", "out");
    expect(node.getState().transfers[file.id]).toMatchObject({ state: "done", transferred: 5 });
    expect((await db.getMessages(chat.id))[0]).toMatchObject({ id: "me_3", file: { id: file.id } });
  });

  it("a file can answer a message: the reply goes with it, stays on its row, and goes again when it is sent again", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    const wireId = "AbCdEfGhIjKlMnOpQrStUv";
    await db.putMessage({ linkId: chat.id, id: `peer_${wireId}`, wireId, text: "shall we?", sender: "peer", timestamp: 1 });
    const file = { id: `${chat.id}-out-w2`, name: "yes.webm", size: 5, mime: "audio/webm" };
    await fileStore.put({ id: file.id, linkId: chat.id, blob: new Blob([bytes("hello")]), createdAt: 1, direction: "out", wireId: "w2" });
    await expect(node.sendFile({ linkId: chat.id, file, timestamp: 3, replyTo: "peer_nothing" })).rejects.toThrow(/not in this chat/);
    await node.sendFile({ linkId: chat.id, file, timestamp: 3, replyTo: `peer_${wireId}` });
    const link = linkOf(chat.id);
    await vi.waitFor(() => expect(link.sendFile).toHaveBeenCalledOnce());
    expect(link.sendFile.mock.calls[0][0]).toMatchObject({ id: "w2", reply: { i: wireId, s: "shall we?", f: "recipient" } });
    await vi.waitFor(async () => expect((await db.getMessages(chat.id)).find(m => m.id === "me_3")?.replyTo)
      .toEqual({ id: wireId, snippet: "shall we?", from: "peer", messageId: `peer_${wireId}` }));
    link.options.events.onFileFailed("w2", "interrupted", "out");
    await node.sendFile({ linkId: chat.id, file, timestamp: 3 });
    await vi.waitFor(() => expect(link.sendFile).toHaveBeenCalledTimes(2));
    expect(link.sendFile.mock.calls[1][0]).toMatchObject({ id: "w2", reply: { i: wireId, s: "shall we?", f: "recipient" } });
  });

  it("waits while the chat is not live and nothing holds it, and goes when the session opens", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    vi.spyOn(node["desk"], "replay").mockResolvedValue();
    const link = linkOf(chat.id);
    link.isDataLinkOpen = false; link.supportsFiles = false;
    const file = { id: `${chat.id}-out-w9`, name: "a.txt", size: 5, mime: "text/plain" };
    await fileStore.put({ id: file.id, linkId: chat.id, blob: new Blob([bytes("hello")]), createdAt: 1, direction: "out", wireId: "w9" });
    node.sendFile({ linkId: chat.id, file, timestamp: 3 });
    await vi.waitFor(async () => expect((await db.getMessages(chat.id))[0]).toMatchObject({ id: "me_3", delivery: "waiting", file: { id: file.id } }));
    expect(link.sendFile).not.toHaveBeenCalled();
    expect(node.getState().transfers[file.id]).toBeUndefined();
    link.isDataLinkOpen = true; link.supportsFiles = true;
    link.options.events.onDataLinkState("open");
    await vi.waitFor(() => expect(link.sendFile).toHaveBeenCalledOnce());
    expect(link.sendFile.mock.calls[0][0]).toMatchObject({ id: "w9", name: "a.txt", timestamp: 3 });
    const [sent] = await db.getMessages(chat.id);
    expect(sent.delivery, "from now on it shows by its transfer").toBeUndefined();
  });

  it("a file still waiting for live when the app restarts keeps waiting, not an interrupted transfer, and goes when the session opens", async () => {
    // Found with two headless CLIs: a file sent to a contact who was away, then the sender's app restarted. The file
    // said "Transfer interrupted" (`file wait` failed at once) while its message still said it goes once live, and it did.
    const chat = row();
    await db.putLink(chat);
    const file = { id: `${chat.id}-out-w8`, name: "a.txt", size: 5, mime: "text/plain" };
    await fileStore.put({ id: file.id, linkId: chat.id, blob: new Blob([bytes("hello")]), createdAt: 1, direction: "out", wireId: "w8",
      transfer: { state: "transferring", transferred: 0, size: 5 } });
    await db.addMessage({ linkId: chat.id, id: "me_3", text: "📎 a.txt", sender: "me", timestamp: 3, via: "datalink", file,
      delivery: "waiting", deliveryError: "Sent when you are live." });
    const { node, linkOf } = await started();
    vi.spyOn(node["desk"], "replay").mockResolvedValue();
    expect(node.getState().transfers[file.id]).toBeUndefined();
    const link = linkOf(chat.id);
    link.options.events.onDataLinkState("open");
    await vi.waitFor(() => expect(link.sendFile).toHaveBeenCalledOnce());
    expect(link.sendFile.mock.calls[0][0]).toMatchObject({ id: "w8", name: "a.txt", timestamp: 3 });
    expect(node.getState().transfers[file.id]).toMatchObject({ state: "transferring" });
  });

  it("a waiting file for an app that takes no files fails with that reason; a cancelled one never goes", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    vi.spyOn(node["desk"], "replay").mockResolvedValue();
    const link = linkOf(chat.id);
    link.isDataLinkOpen = false; link.supportsFiles = false;
    const file = (n: number) => ({ id: `${chat.id}-out-f${n}`, name: `${n}.txt`, size: 1, mime: "text/plain" });
    node.sendFile({ linkId: chat.id, file: file(1), timestamp: 1 });
    node.sendFile({ linkId: chat.id, file: file(2), timestamp: 2 });
    await vi.waitFor(async () => expect(await db.getMessages(chat.id)).toHaveLength(2));
    node.deleteMessage({ linkId: chat.id, messageId: "me_2" });
    await vi.waitFor(async () => expect(await db.getMessages(chat.id)).toHaveLength(1));
    link.isDataLinkOpen = true;
    link.options.events.onDataLinkState("open");
    await vi.waitFor(async () => expect((await db.getMessages(chat.id))[0]).toMatchObject({ id: "me_1", delivery: "failed", deliveryError: "Your contact's app cannot receive files." }));
    expect(link.sendFile).not.toHaveBeenCalled();
  });

  it("a session that opens sends what waited for it by reading those messages, not the chat's whole history", async () => {
    const chat = row();
    await db.putLink(chat);
    const request = (n: number) => ({ linkId: chat.id, id: `me_${n}`, text: `⚡ Requested ${n} sats`, sender: "me" as const, timestamp: n, via: "datalink" as const,
      paymentId: `p${n}`, delivery: "waiting" as const, deliveryError: "Sent when you are live." });
    // One that waited when the app started, two written in this run (one of them deleted since).
    await db.addMessage(request(3));
    const { node, events: pages, linkOf } = await started();
    // As the CLI and the web app host it: the pages hear the rows that changed, not the whole history.
    Object.assign(pages, { onMessageChanges: vi.fn() });
    await node["storeMessage"](request(4));
    await node["storeMessage"](request(5));
    await db.deleteMessage(chat.id, "me_5");
    Object.assign(linkOf(chat.id), { supportsPayments: true });
    const history = vi.spyOn(db, "getMessages"), rows = vi.spyOn(db, "getMessage");
    await node["sendWaiting"](chat.id);
    expect(history).not.toHaveBeenCalled();
    expect(rows).toHaveBeenCalledWith(chat.id, "me_5");
    for (const id of ["me_3", "me_4"]) {
      const sent = (await db.getMessage(chat.id, id))!;
      expect(sent.delivery, id).toBeUndefined();
      expect(sent.details?.sentAt, id).toBeTypeOf("number");
    }
    // Gone: the next session has nothing to look for.
    rows.mockClear();
    await node["sendWaiting"](chat.id);
    expect(history).not.toHaveBeenCalled();
    expect(rows).not.toHaveBeenCalled();
  });

  it("fails visibly when offline, for an id not of this chat, a peer without files, or bytes that are gone", async () => {
    const chat = row(), away = row();
    const { node, linkOf } = await started(chat, away);
    node["links"].get(away.id)!.link = null;
    const failed = (id: string) => node.getState().transfers[id];
    const file = (id: string) => ({ id, name: "a", size: 1, mime: "" });
    // Refused before anything starts: the transfer says so, and the call rejects with the same reason.
    await expect(node.sendFile({ linkId: away.id, file: file(`${away.id}-out-1`), timestamp: 1 })).rejects.toThrow("You are offline");
    expect(failed(`${away.id}-out-1`)).toMatchObject({ state: "failed", error: "You are offline" });
    await expect(node.sendFile({ linkId: chat.id, file: file("someone-elses-file"), timestamp: 1 })).rejects.toThrow("Invalid file id");
    expect(failed("someone-elses-file")).toMatchObject({ state: "failed", error: "Invalid file id" });
    node.sendFile({ linkId: chat.id, file: file(`${chat.id}-out-gone`), timestamp: 2 });
    await vi.waitFor(() => expect(failed(`${chat.id}-out-gone`)).toMatchObject({ state: "failed", error: "The file is gone" }));
    linkOf(chat.id).supportsFiles = false;
    await expect(node.sendFile({ linkId: chat.id, file: file(`${chat.id}-out-2`), timestamp: 3 })).rejects.toThrow("updated peer");
    expect(failed(`${chat.id}-out-2`)).toMatchObject({ state: "failed", error: expect.stringContaining("updated peer") });
  });
});

describe("text in a chat", () => {
  it("a paired chat keeps the message before it goes out, and hands it to the outbox", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    expect(await node.sendMessage({ linkId: chat.id, text: "  hi  ", timestamp: 4 })).toEqual({ error: null, messageId: expect.stringMatching(/^me_/) });
    const [message] = await db.getMessages(chat.id);
    expect(message).toMatchObject({ text: "hi", sender: "me", via: "datalink" });
    expect(linkOf(chat.id).sendMessage).toHaveBeenCalledWith("hi", 4, message.wireId);
    linkOf(chat.id).validateText.mockReturnValueOnce("Payment tokens are not text" as never);
    expect(await node.sendMessage({ linkId: chat.id, text: "cashuA" })).toMatchObject({ error: "Payment tokens are not text", refused: true });
    expect(await db.getMessages(chat.id)).toHaveLength(1);
  });

  it("the receipt of a message I sent reads that message, not the chat's whole history", async () => {
    const chat = row();
    const { node, events: pages, linkOf } = await started(chat);
    // As the CLI and the web app host it: the pages hear the rows that changed, not the whole history.
    Object.assign(pages, { onMessageChanges: vi.fn() });
    const { messageId } = await node.sendMessage({ linkId: chat.id, text: "hi", timestamp: 4 });
    const sent = (await db.getMessage(chat.id, messageId!))!;
    await db.patchMessage(chat.id, sent.id, () => ({ edit: { seq: 1, at: 5, pending: true } }));
    const { events } = linkOf(chat.id).options;
    const history = vi.spyOn(db, "getMessages");
    const flush = vi.spyOn(EditQueue.prototype, "flush").mockResolvedValue();
    await events.onMessageReceipt(sent.wireId!);
    expect((await db.getMessage(chat.id, sent.id))?.delivery).toBe("delivered");
    expect(history).not.toHaveBeenCalled();
    // Its edit waited for this receipt: it goes now.
    expect(flush).toHaveBeenCalledOnce();
    // An id no message of mine has (a file's offer or an edit said on the DHT floor) is still looked for.
    await events.onMessageReceipt("floor-id");
    expect(history).toHaveBeenCalled();
  });

  it("a receipt for a file said on the DHT floor finds it without reading the chat's whole history again", async () => {
    const chat = row();
    const { node, events: pages, linkOf } = await started(chat);
    // As the CLI and the web app host it: the pages hear the rows that changed, not the whole history.
    Object.assign(pages, { onMessageChanges: vi.fn() });
    const link = linkOf(chat.id), { events } = link.options;
    const waiting = (wireId: string, at: number, fileOnFloor?: "sent") => ({ linkId: chat.id, id: `me_${at}`, text: "a.txt", sender: "me" as const, timestamp: at, via: "datalink" as const,
      delivery: "waiting" as const, file: { id: `${chat.id}-out-${wireId}`, name: "a.txt", size: 1, mime: "text/plain" }, ...(fileOnFloor && { fileOnFloor }) });
    const seen = { fileOnFloor: "seen", deliveryError: "Your contact sees it. The file goes when you are live." };
    // Said on the floor in an earlier run: the chat's history is where it is found, once.
    await db.addMessage(waiting("w1", 1, "sent"));
    // The first id no message of mine has: the outbox, the edits and the floor's files each learn what waits, once.
    await events.onMessageReceipt("an-edit-on-the-floor");
    const history = vi.spyOn(db, "getMessages");
    await events.onMessageReceipt(dhtFileId("w1"));
    expect(await db.getMessage(chat.id, "me_1")).toMatchObject(seen);
    // Said on the floor in this run: known from the moment it is said.
    await db.addMessage(waiting("w2", 2));
    Object.assign(link, { isDataLinkOpen: false, fileAnnounceError: () => null, announceFile: vi.fn(async () => null), dhtPendingId: dhtFileId("w2") });
    await node["sayFileOnFloor"](node["links"].get(chat.id)!, (await db.getMessage(chat.id, "me_2"))!);
    expect((await db.getMessage(chat.id, "me_2"))?.fileOnFloor).toBe("sent");
    await events.onMessageReceipt(dhtFileId("w2"));
    expect(await db.getMessage(chat.id, "me_2")).toMatchObject(seen);
    // A receipt that names no file of mine changes nothing, and reads nothing.
    await events.onMessageReceipt(dhtFileId("w3"));
    expect(history).not.toHaveBeenCalled();
  });

  // covers: chat.link-preview.wire
  it("a link preview is kept with the message and goes with it; one of a link the text lacks is dropped", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    const preview = { u: "https://news.example/a", t: "A story" };
    expect(await node.sendMessage({ linkId: chat.id, text: "see https://news.example/a?utm_source=x", timestamp: 5, preview })).toEqual({ error: null, messageId: expect.stringMatching(/^me_/) });
    const [message] = await db.getMessages(chat.id);
    expect(message.preview).toEqual(preview);
    expect(linkOf(chat.id).sendMessage).toHaveBeenCalledWith("see https://news.example/a?utm_source=x", 5, message.wireId, preview);
    expect(await node.sendMessage({ linkId: chat.id, text: "no link here", timestamp: 6, preview })).toEqual({ error: null, messageId: expect.stringMatching(/^me_/) });
    const second = (await db.getMessages(chat.id)).find(m => m.text === "no link here")!;
    expect(second.preview).toBeUndefined();
    expect(linkOf(chat.id).sendMessage).toHaveBeenLastCalledWith("no link here", 6, second.wireId);
  });

  it("a legacy chat refuses what the DHT cannot carry before keeping it, and a delivered message moves the read mark", async () => {
    const chat = row({ profile: undefined, participationSeed: undefined });
    const { node, linkOf } = await started(chat);
    const link = linkOf(chat.id);
    link.isDataLinkOpen = false;
    expect(await node.sendMessage({ linkId: chat.id, text: "x".repeat(600) })).toMatchObject({ refused: true });
    expect(await db.getMessages(chat.id)).toEqual([]);
    link.isDataLinkOpen = true;
    expect(await node.sendMessage({ linkId: chat.id, text: "x".repeat(600), timestamp: 9 })).toEqual({ error: null, messageId: expect.stringMatching(/^me_/) });
    expect(node.getState().links[0].peerAck).toBe(9);
    expect((await db.getMessages(chat.id))[0]).toMatchObject({ id: "me_9", via: "datalink" });
  });

  it("for an away contact that allows it, a text is held in storage, and never above the held-text limit", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    linkOf(chat.id).isDataLinkOpen = false;
    vi.spyOn(node["hold"], "canHold").mockReturnValue(true);
    const hold = vi.spyOn(node["hold"], "hold").mockResolvedValue();
    expect((await node.sendMessage({ linkId: chat.id, text: "x".repeat(70_000) })).error).toContain("16384");
    expect(await node.sendMessage({ linkId: chat.id, text: "later", timestamp: 3 })).toEqual({ error: null, messageId: expect.stringMatching(/^me_/) });
    expect((await db.getMessages(chat.id))[0]).toMatchObject({ text: "later", via: "hold", delivery: "sending" });
    expect(hold).toHaveBeenCalledWith(chat.id, expect.objectContaining({ kind: "text", timestamp: 3 }));
    expect(node.getState().links[0]).toMatchObject({ textDelivery: "hold", canSendText: true });
    await expect(node.sendPayment({ linkId: chat.id, amount: 1, timestamp: 1 })).rejects.toThrow("not held");
  });
});

describe("an away contact", () => {
  async function away() {
    const chat = row();
    const setup = await started(chat);
    setup.linkOf(chat.id).isDataLinkOpen = false;
    setup.linkOf(chat.id).supportsFiles = false;
    vi.spyOn(setup.node["hold"], "canHold").mockReturnValue(true);
    const hold = vi.spyOn(setup.node["hold"], "hold").mockResolvedValue();
    return { ...setup, chat, hold };
  }

  it("a held message that was dropped is held again under the same message", async () => {
    const { node, chat, hold } = await away();
    vi.spyOn(node["hold"], "retry").mockResolvedValue(false);
    await db.addMessage({ linkId: chat.id, id: "me_w9", wireId: "w9", text: "later", sender: "me", timestamp: 4, via: "hold", delivery: "failed" });
    await node.retryMessage({ linkId: chat.id, messageId: "me_w9" });
    expect((await db.getMessages(chat.id))[0].delivery).toBe("sending");
    expect(hold).toHaveBeenCalledWith(chat.id, { kind: "text", id: "w9", messageId: "me_w9", bytes: 5, timestamp: 4 });
  });

  it("sealing a held text, retrying it and opening its details read that message, not the chat's whole history", async () => {
    const { node, events: pages, chat, hold } = await away();
    // As the CLI and the web app host it: the pages hear the rows that changed, not the whole history.
    Object.assign(pages, { onMessageChanges: vi.fn() });
    vi.spyOn(node["hold"], "retry").mockResolvedValue(false);
    await db.addMessage({ linkId: chat.id, id: "me_w8", wireId: "w8", text: "before", sender: "me", timestamp: 3, via: "datalink", delivery: "delivered" });
    await db.addMessage({ linkId: chat.id, id: "me_w9", wireId: "w9", text: "later", sender: "me", timestamp: 4, via: "hold", delivery: "failed", forwarded: 2 });
    const host = node["hold"]["host"] as { text(linkId: string, messageId: string): Promise<string | null>; reply(linkId: string, messageId: string): Promise<unknown>; forwarded(linkId: string, messageId: string): Promise<number | undefined> };
    const history = vi.spyOn(db, "getMessages");
    // What the hold asks for when it seals the text: the text, what it answers, how far it was forwarded.
    expect(await host.text(chat.id, "me_w9")).toBe("later");
    expect(await host.text(chat.id, "me_gone")).toBeNull();
    expect(await host.reply(chat.id, "me_w9")).toBeUndefined();
    expect(await host.forwarded(chat.id, "me_w9")).toBe(2);
    await node.retryMessage({ linkId: chat.id, messageId: "me_w9" });
    expect(hold).toHaveBeenCalledWith(chat.id, { kind: "text", id: "w9", messageId: "me_w9", bytes: 5, timestamp: 4 });
    expect(await node.messageDetails({ linkId: chat.id, messageId: "me_w9" })).toMatchObject({ message: { id: "me_w9", kind: "text", via: "hold" } });
    expect(await node.messageDetails({ linkId: chat.id, messageId: "me_gone" })).toBeNull();
    expect(history).not.toHaveBeenCalled();
  });

  it("a file waits in storage for the contact, within the size of one held item; a larger one waits for live", async () => {
    const { node, chat, hold } = await away();
    const big = { id: `${chat.id}-out-big`, name: "big", size: 64 * 1024 * 1024, mime: "" };
    node.sendFile({ linkId: chat.id, file: big, timestamp: 1 });
    await vi.waitFor(async () => expect((await db.getMessages(chat.id)).find((m) => m.id === "me_1")).toMatchObject({ delivery: "waiting", file: { id: big.id } }));
    expect(hold).not.toHaveBeenCalled();
    await db.deleteMessage(chat.id, "me_1");
    const small = { id: `${chat.id}-out-w1`, name: "small", size: 3, mime: "" };
    node.sendFile({ linkId: chat.id, file: small, timestamp: 2 });
    await vi.waitFor(() => expect(hold).toHaveBeenCalledWith(chat.id, { kind: "file", id: "w1", messageId: "me_2", ref: small.id, bytes: 3, timestamp: 2 }));
    expect((await db.getMessages(chat.id))[0]).toMatchObject({ via: "hold", delivery: "sending", file: { id: small.id } });
    // Once picked up, the transfer shows done.
    const host = node["hold"]["host"] as { delivery(linkId: string, messageId: string, state: string): Promise<void> };
    await host.delivery(chat.id, "me_2", "held");
    expect(node.getState().transfers[small.id]).toMatchObject({ state: "done", transferred: 3 });
  });

  it("reconnecting needs the engine online", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    await node.connect({ linkId: chat.id });
    expect(linkOf(chat.id).connect).toHaveBeenCalledOnce();
    await expect(node.connect({ linkId: "missing" })).rejects.toThrow("Go online before reconnecting");
  });

  it("reconnecting dials at once where WebRTC can carry the chat, beside a native listener still starting; a native-only chat waits for it", async () => {
    // Iroh's relay out of reach: its listener takes 10 s to give up. Reconnect waited for it before it dialed.
    vi.stubGlobal("RTCPeerConnection", class {});
    const starting: (() => void)[] = [];
    const made = () => ({ transport: "iroh/1" as const, descriptor: { id: "ab".repeat(32), relay: "https://relay.test./", addresses: [] },
      connect: vi.fn(), close: vi.fn(async () => {}), onConnection: null, onDescriptor: null });
    const iroh = vi.fn(() => new Promise((resolve) => { starting.push(() => resolve(made())); }));
    const both = row({ pairedPeerKey: createIdentity().pubKeyZ32, peerTransports: ["webrtc/1", "iroh/1"] });
    const native = row({ pairedPeerKey: createIdentity().pubKeyZ32, peerTransports: ["iroh/1"] });
    const pinned = row({ pairedPeerKey: createIdentity().pubKeyZ32, peerTransports: ["webrtc/1", "iroh/1"], preferredTransport: "iroh/1", transportFallback: false });
    try {
      const { node, linkOf } = await startedWith({ nativeTransports: { "iroh/1": iroh } } as unknown as Partial<NodeOptions>, both, native, pinned);
      for (const chat of [both, native, pinned]) linkOf(chat.id).availableTransports = ["webrtc/1"];
      const began = Date.now();
      await node.connect({ linkId: both.id });
      expect(Date.now() - began).toBeLessThan(500);
      expect(linkOf(both.id).connect).toHaveBeenCalledOnce();
      // Nothing to dial without the listener: these wait for it, as before.
      const waiting = [node.connect({ linkId: native.id }), node.connect({ linkId: pinned.id })];
      await new Promise((r) => setTimeout(r, 50));
      expect(linkOf(native.id).connect).not.toHaveBeenCalled();
      expect(linkOf(pinned.id).connect).not.toHaveBeenCalled();
      // The listeners come up, one after another in Iroh's queue: then they dial.
      await vi.waitFor(() => { for (const start of starting.splice(0)) start(); expect(linkOf(pinned.id).connect).toHaveBeenCalled(); }, { timeout: 3_000 });
      await Promise.all(waiting);
      // (The engine also dials a native contact itself once its listener is up, as the lower key.)
      expect(linkOf(native.id).connect).toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("what arrives from held storage", () => {
  it("a held file lands once, its bytes before its message, and not in a chat that deleted it", async () => {
    const chat = row({ deletedIds: ["peer_gone"] });
    const { node } = await started(chat);
    const host = node["hold"]["host"] as { receiveFile(linkId: string, wire: object, bytes: Uint8Array, digest: string): Promise<string | null> };
    const wire = (wireId: string) => ({ wireId, name: "h.txt", size: 4, mime: "text/plain", timestamp: 5 });
    expect(await host.receiveFile("unknown", wire("a"), bytes("held"), "d")).toBe("unknown chat");
    expect(await host.receiveFile(chat.id, wire("gone"), bytes("held"), "d")).toBeNull();
    expect(await fileStore.listForLink(chat.id)).toEqual([]);
    expect(await host.receiveFile(chat.id, wire("a"), bytes("held"), "d")).toBeNull();
    expect(await host.receiveFile(chat.id, wire("a"), bytes("held"), "d")).toBe("duplicate file id");
    const [message] = await db.getMessages(chat.id);
    expect(message).toMatchObject({ id: "peer_a", via: "hold" });
    expect(await fileStore.get(message.file!.id)).toMatchObject({ direction: "in", digest: "d" });
  });
});

describe("private groups through the engine", () => {
  it("refuses a nameless group, an invitation to a contact that is not paired, and joining while offline", async () => {
    const legacy = row({ profile: undefined, participationSeed: undefined });
    const { node } = await started(legacy);
    await expect(node.createGroup({ name: "   " })).rejects.toThrow("Give the group a name");
    // A name a group cannot have is refused, as a rename refuses it: it was cut at 48 without a word.
    await expect(node.createGroup({ name: "x".repeat(65), profile: "mesh" })).rejects.toThrow("A group's name is 1 to 64 characters on one line");
    // A new line is a space, and 64 characters fit.
    const { groupId } = await node.createGroup({ name: " Book\nclub ", profile: "mesh" });
    expect(node.getState().groups.find(g => g.id === groupId)?.name).toBe("Book club");
    const long = await node.createGroup({ name: "y".repeat(64), profile: "mesh" });
    expect(node.getState().groups.find(g => g.id === long.groupId)?.name).toBe("y".repeat(64));
    expect(() => node.inviteToGroup({ groupId: "g", linkId: legacy.id })).toThrow("Invite a paired contact");
    await expect(node.joinGroupByLink({ link: 42 as never })).rejects.toThrow("not a link to a group");
    await node.updateSettings({ settings: { online: false } });
    await expect(node.joinGroupByLink({ link: "ghostly://group" })).rejects.toThrow("Go online");
    expect(await node.sendGroupMessage({ groupId: "g", text: 1 as never })).toEqual({ error: "Nothing to send" });
  });

  it("a group's edge is a link the engine runs, pinned to the member, never shown or exported as a chat", async () => {
    const { node } = await started();
    const { groupId } = await node.createGroup({ name: "  Friends  ", profile: "mesh" });
    const state = (await db.getGroups()).find((g) => g.id === groupId)!.state;
    const member = createIdentity().pubKeyZ32;
    const edgeId = await openEdge(node, state,member);
    expect(await openEdge(node, state,member)).toBe(edgeId);
    expect(node.getState().links).toEqual([]);
    expect(node.exportLinks()).toEqual([]);
    const edge = links.find((l) => l.options.params.id === edgeId)!;
    await expect(edge.options.pairing.pinPeer(createIdentity().pubKeyZ32)).rejects.toThrow("Not the member");
    await expect(edge.options.pairing.pinPeer(member)).resolves.toBeUndefined();
    edge.options.events.onPresence({ online: true, lastPacketAt: 1, services: null, nick: "Carol" });
    const host = node["groups"]["host"] as { edgeNick(id: string): string | undefined; closeEdge(id: string): Promise<void>; edges(g: string): Map<string, string> };
    expect(host.edgeNick(edgeId)).toBe("Carol");
    expect(host.edges(groupId)).toEqual(new Map([[member, edgeId]]));
    await host.closeEdge(edgeId);
    expect(edge.stop).toHaveBeenCalledWith(true);
    expect(await saved(edgeId)).toBeUndefined();
  });

  it("an edge live when the app quit is dialled at once when it starts again; one that dropped before is not", async () => {
    // An app with WebRTC: the edge resumes on it.
    vi.stubGlobal("RTCPeerConnection", class {});
    onTestFinished(() => { vi.unstubAllGlobals(); });
    const { node } = await started();
    // A community: its edges are kept as the app starts (a private group's to keys not in its roster go at once).
    const { groupId } = await node.createGroup({ name: "Plaza" });
    const state = (await db.getGroups()).find((g) => g.id === groupId)!.community;
    const [kept, dropped] = [createIdentity().pubKeyZ32, createIdentity().pubKeyZ32];
    const keptId = await openEdge(node, state,kept), droppedId = await openEdge(node, state,dropped);
    const edge = (id: string) => links.filter((l) => l.options.params.id === id).at(-1)!;
    expect(edge(keptId).options.resume).toBeUndefined();
    // Both sessions open; one drops while the app runs (the member went away), then the app quits with the other up.
    for (const id of [keptId, droppedId]) edge(id).options.events.onGroupsSupport(true);
    await vi.waitFor(async () => expect((await saved(keptId))?.edgeLive).toBe(true));
    edge(droppedId).options.events.onGroupsSupport(false);
    await vi.waitFor(async () => expect((await saved(droppedId))?.edgeLive).toBeFalsy());
    // The member of a dropped edge is back once it published since the drop (the community waits longer for it then).
    const host = node["groups"]["host"] as { linkBack(id: string): boolean };
    const { events } = edge(droppedId).options;
    events.onDataLinkState("open"); events.onDataLinkState("idle");
    const dropAt = Date.now();
    events.onPresence({ online: true, lastPacketAt: dropAt - 5_000, services: [] });
    expect(host.linkBack(droppedId)).toBe(false);
    events.onPresence({ online: true, lastPacketAt: dropAt + 1_000, services: [] });
    expect(host.linkBack(droppedId)).toBe(true);
    const stopping = node.shutdown();
    // Its links ending as the app quits say nothing about the next run.
    edge(keptId).options.events.onGroupsSupport(false);
    await stopping;
    nodes.splice(nodes.indexOf(node), 1);
    expect((await saved(keptId))?.edgeLive).toBe(true);
    const before = links.length;
    await started();
    expect(links.length).toBeGreaterThan(before);
    expect([keptId, droppedId].map(id => edge(id).options.resume)).toEqual(["webrtc/1", undefined]);
  });

  it("an edge back up after a restart keeps that session's start, so the next restart does not answer an offer from before it", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    onTestFinished(() => { vi.unstubAllGlobals(); });
    let { node } = await started();
    const { groupId } = await node.createGroup({ name: "Plaza" });
    const state = (await db.getGroups()).find((g) => g.id === groupId)!.community;
    const edgeId = await openEdge(node, state,createIdentity().pubKeyZ32);
    const edge = () => links.filter((l) => l.options.params.id === edgeId).at(-1)!;
    const restart = async () => {
      await node.shutdown();
      nodes.splice(nodes.indexOf(node), 1);
      ({ node } = await started());
    };
    edge().options.events.onGroupsSupport(true);
    await vi.waitFor(async () => expect((await saved(edgeId))?.edgeLiveSince).toBeTypeOf("number"));
    const first = (await saved(edgeId))!.edgeLiveSince!;
    await restart();
    expect(edge().options.resumeFloor).toBe(first);
    // The member answers the resumed dial (or this app its offer): a session of this run, which began later.
    await new Promise((resolve) => setTimeout(resolve, 5));
    edge().options.events.onGroupsSupport(true);
    await vi.waitFor(async () => expect((await saved(edgeId))?.edgeLiveSince).toBeGreaterThan(first));
    const second = (await saved(edgeId))!.edgeLiveSince!;
    // The same session said again changes nothing.
    edge().options.events.onGroupsSupport(true);
    await restart();
    // An offer the member made for that session, before it began, is not answered when the app is back again.
    expect(edge().options.resumeFloor).toBe(second);
    expect(edge().options.resume).toBe("webrtc/1");
  });

  // covers: groups.native-links
  describe("native transports on a group's links (WISP 902 § Transports)", () => {
    const endpoint = () => ({ transport: "iroh/1" as const, descriptor: { id: "ab".repeat(32), relay: "https://relay.test./", addresses: [] },
      connect: vi.fn(), close: vi.fn(async () => {}), onConnection: null, onDescriptor: null });
    /** An engine running Iroh as the Desktop does (the host's own adapter). */
    async function nativeEngine() {
      const iroh = vi.fn(async () => endpoint());
      const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() };
      const node = new GhostlyNode(events, { automaticWallets: false, transport: fixture, nativeTransports: { "iroh/1": iroh } });
      nodes.push(node);
      await node.start();
      return { node, iroh };
    }
    const edgeOf = (id: string) => links.filter((l) => l.options.params.id === id).at(-1)!;

    it("an edge whose listener failed to start (Iroh's relay out of reach) starts it again on a later tick, and at once when the network is back", async () => {
      const { node, iroh } = await nativeEngine();
      iroh.mockRejectedValueOnce(new Error("Iroh relay unreachable"));
      const { groupId } = await node.createGroup({ name: "Plaza" });
      const state = (await db.getGroups()).find((g) => g.id === groupId)!.community;
      const edgeId = await openEdge(node, state,createIdentity().pubKeyZ32);
      await vi.waitFor(() => expect(node["links"].get(edgeId)?.transportErrors?.["iroh/1"]).toBe("Iroh relay unreachable"));
      // The next tick before the wait is over: nothing yet.
      node["retryGroupNative"]();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(iroh).toHaveBeenCalledOnce();
      // One retry period later, the tick starts it again, and the edge has it.
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 16_000);
      onTestFinished(() => { clock.mockRestore(); });
      node["retryGroupNative"]();
      await vi.waitFor(() => expect(edgeOf(edgeId).registerEndpoint).toHaveBeenCalledOnce());
      expect(iroh).toHaveBeenCalledTimes(2);
      expect(node["links"].get(edgeId)?.transportErrors?.["iroh/1"]).toBeUndefined();
      // Failed again (the network went down once more): the network coming back starts it at the next tick.
      edgeOf(edgeId).availableTransports = ["webrtc/1"];
      iroh.mockRejectedValueOnce(new Error("Iroh relay unreachable"));
      node["groupNativeFailed"].clear();
      void node["ensureNativeEndpoints"](edgeId);
      await vi.waitFor(() => expect(node["groupNativeFailed"].has(edgeId)).toBe(true));
      node.wake({ network: true });
      node["retryGroupNative"]();
      await vi.waitFor(() => expect(edgeOf(edgeId).registerEndpoint).toHaveBeenCalledTimes(2));
    });

    it("an app with WebRTC takes an endpoint on an edge only once the member's packet says it has none, and again after a restart", async () => {
      vi.stubGlobal("RTCPeerConnection", class {});
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const { node, iroh } = await nativeEngine();
      expect(node.getState().transport.groupLinks).toBeUndefined();
      const { groupId } = await node.createGroup({ name: "Plaza" });
      const state = (await db.getGroups()).find((g) => g.id === groupId)!.community;
      const edgeId = await openEdge(node, state,createIdentity().pubKeyZ32);
      expect(edgeOf(edgeId).options.packetTransports).toBe(true);
      // Two apps with WebRTC: no endpoint, as before.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(iroh).not.toHaveBeenCalled();
      // The member's app has none (a Linux Desktop): this side starts Iroh for that edge, and keeps what it said.
      const descriptors = { "iroh/1": { id: "cd".repeat(32), relay: null, addresses: [], relayed: true } };
      edgeOf(edgeId).options.events.onPacketTransports(["iroh/1", "hyperdht/1"], descriptors);
      await vi.waitFor(() => expect(edgeOf(edgeId).registerEndpoint).toHaveBeenCalledTimes(1));
      expect(iroh).toHaveBeenCalledTimes(1);
      await vi.waitFor(async () => expect((await saved(edgeId))?.peerTransports).toEqual(["iroh/1", "hyperdht/1"]));
      // Started again, with the edge live when it quit: Iroh at once, the member dialled how it said, resumed on Iroh.
      await db.patchLink(edgeId, { edgeLive: true, edgeLiveSince: Date.now() });
      await node.shutdown();
      nodes.splice(nodes.indexOf(node), 1);
      const again = await nativeEngine();
      await vi.waitFor(() => expect(again.iroh).toHaveBeenCalledTimes(1));
      expect(edgeOf(edgeId).options.native).toMatchObject({ peerTransports: ["iroh/1", "hyperdht/1"], peerDescriptors: descriptors });
      expect(edgeOf(edgeId).options.resume).toBe("iroh/1");
    });

    it("an app with no WebRTC takes an endpoint on every edge at once, and can make groups", async () => {
      const { node, iroh } = await nativeEngine();
      expect(node.getState().transport).toMatchObject({ webrtc: false });
      expect(node.getState().transport.groupLinks).toBeUndefined();
      const { groupId } = await node.createGroup({ name: "Penguins" });
      const state = (await db.getGroups()).find((g) => g.id === groupId)!.community;
      const edgeId = await openEdge(node, state,createIdentity().pubKeyZ32);
      await vi.waitFor(() => expect(edgeOf(edgeId).registerEndpoint).toHaveBeenCalledTimes(1));
      expect(iroh).toHaveBeenCalled();
    });

    it("an edge whose WebRTC connects nothing goes on over a native transport, as on an app with no WebRTC; one that connects stays as it is", async () => {
      // A member behind a VPN or a firewall: both apps have WebRTC, so the edge ran nothing else, and never went live.
      vi.stubGlobal("RTCPeerConnection", class {});
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const { node, iroh } = await nativeEngine();
      const { groupId } = await node.createGroup({ name: "Plaza" });
      const state = (await db.getGroups()).find((g) => g.id === groupId)!.community;
      const blocked = await openEdge(node, state,createIdentity().pubKeyZ32);
      const fine = await openEdge(node, state,createIdentity().pubKeyZ32);
      await node["nativeQueue"];
      expect(iroh).not.toHaveBeenCalled();
      const first = edgeOf(blocked), other = edgeOf(fine);
      expect(first.options.rtcAvailable).toBe(true);

      other.options.events.onDirectEvidence("open");
      first.options.events.onDirectEvidence("no-path");
      await vi.waitFor(() => expect(edgeOf(blocked)).not.toBe(first));
      // No goodbye: the member must not take the restart for a leave.
      expect(first.stop).toHaveBeenCalledWith(false);
      const again = edgeOf(blocked);
      expect(again.options.rtcAvailable).toBe(false);
      await vi.waitFor(() => expect(again.registerEndpoint).toHaveBeenCalledOnce());
      expect(iroh).toHaveBeenCalledOnce();
      // The edge that connects keeps WebRTC, and takes no listener.
      expect(edgeOf(fine)).toBe(other);
      expect(other.registerEndpoint).not.toHaveBeenCalled();
      // Said again (the old link's last words, a later attempt): nothing more happens.
      first.options.events.onDirectEvidence("no-public");
      again.options.events.onDirectEvidence("no-path");
      await node["nativeQueue"];
      expect(edgeOf(blocked)).toBe(again);
      expect(iroh).toHaveBeenCalledOnce();
    });

    // A member whose app quit in the middle of the attempt (one-shot CLI commands while its daemon was down) looked like a
    // network that blocks: its edge stayed native for this whole run, and past 4 such edges members stayed unreachable.
    it("an edge gone native tries WebRTC again once its member is seen online after a packet said it was gone, not while it stays online", async () => {
      vi.stubGlobal("RTCPeerConnection", class {});
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const { node, iroh } = await nativeEngine();
      const { groupId } = await node.createGroup({ name: "Plaza" });
      const state = (await db.getGroups()).find((g) => g.id === groupId)!.community;
      const edgeId = await openEdge(node, state, createIdentity().pubKeyZ32);
      const presence = (online: boolean, at: number) => ({ online, lastPacketAt: at, services: online ? [] : null });
      const first = edgeOf(edgeId);
      first.options.events.onDirectEvidence("no-path");
      await vi.waitFor(() => expect(edgeOf(edgeId)).not.toBe(first));
      const native = edgeOf(edgeId);
      expect(native.options.rtcAvailable).toBe(false);
      await vi.waitFor(() => expect(native.registerEndpoint).toHaveBeenCalledOnce());
      // Online all along (a network that really blocks): the edge stays native, whatever packets it publishes.
      native.options.events.onPresence(presence(true, 1));
      native.options.events.onPresence(presence(true, 2));
      await node["nativeQueue"];
      expect(edgeOf(edgeId)).toBe(native);
      // Gone (its goodbye, or a packet gone stale), and back: WebRTC again, no native endpoint, and no goodbye.
      native.options.events.onPresence(presence(false, 3));
      expect(edgeOf(edgeId)).toBe(native);
      native.options.events.onPresence(presence(true, 4));
      await vi.waitFor(() => expect(edgeOf(edgeId)).not.toBe(native));
      expect(native.stop).toHaveBeenCalledWith(false);
      const back = edgeOf(edgeId);
      expect(back.options.rtcAvailable).toBe(true);
      // It ran an endpoint there: its packet says it has WebRTC again, and the member's app goes back to it.
      expect(back.options.packetTransportsSaid).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(back.registerEndpoint).not.toHaveBeenCalled();
      // A network that really blocks: one more failed attempt, and native again.
      back.options.events.onDirectEvidence("no-path");
      await vi.waitFor(() => expect(edgeOf(edgeId)).not.toBe(back));
      expect(edgeOf(edgeId).options.rtcAvailable).toBe(false);
      await vi.waitFor(() => expect(edgeOf(edgeId).registerEndpoint).toHaveBeenCalledOnce());
      expect(iroh).toHaveBeenCalledTimes(2);
    });

    // libdatachannel's race on a loaded core refused every answer to the edge's offers, through the pauses after them:
    // the next offer would wait minutes of backoff while the member is there (meshSignals on CI, 2026-10-11).
    it("an edge whose answers WebRTC here keeps refusing goes on over a native transport, as one whose WebRTC connected nothing", async () => {
      vi.stubGlobal("RTCPeerConnection", class {});
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const { node, iroh } = await nativeEngine();
      const { groupId } = await node.createGroup({ name: "Plaza" });
      const state = (await db.getGroups()).find((g) => g.id === groupId)!.community;
      const refused = await openEdge(node, state, createIdentity().pubKeyZ32);
      const fine = await openEdge(node, state, createIdentity().pubKeyZ32);
      await node["nativeQueue"];
      expect(iroh).not.toHaveBeenCalled();
      const first = edgeOf(refused), other = edgeOf(fine);
      first.options.events.onAnswersRefused();
      await vi.waitFor(() => expect(edgeOf(refused)).not.toBe(first));
      // No goodbye: the member must not take the restart for a leave.
      expect(first.stop).toHaveBeenCalledWith(false);
      const again = edgeOf(refused);
      expect(again.options.rtcAvailable).toBe(false);
      await vi.waitFor(() => expect(again.registerEndpoint).toHaveBeenCalledOnce());
      expect(edgeOf(fine)).toBe(other);
      expect(other.registerEndpoint).not.toHaveBeenCalled();
      // Said again by the old link: nothing more.
      first.options.events.onAnswersRefused();
      await node["nativeQueue"];
      expect(edgeOf(refused)).toBe(again);
      expect(iroh).toHaveBeenCalledOnce();
    });

    it("an edge that ran a native endpoint says its transports on from then, and one that never did says none", async () => {
      // An edge whose WebRTC failed once said `_tr = ["iroh/1"]` for that run. Back with WebRTC it ran no endpoint and
      // published no `_tr` at all, so the member's app kept dialling the Iroh endpoint of the run before, for good.
      vi.stubGlobal("RTCPeerConnection", class {});
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const { node } = await nativeEngine();
      const { groupId } = await node.createGroup({ name: "Plaza" });
      const state = (await db.getGroups()).find((g) => g.id === groupId)!.community;
      const blocked = await openEdge(node, state,createIdentity().pubKeyZ32);
      const fine = await openEdge(node, state,createIdentity().pubKeyZ32);
      expect(edgeOf(blocked).options.packetTransportsSaid).toBe(false);
      const first = edgeOf(blocked);
      first.options.events.onDirectEvidence("no-path");
      await vi.waitFor(() => expect(edgeOf(blocked)).not.toBe(first));
      await vi.waitFor(() => expect(edgeOf(blocked).registerEndpoint).toHaveBeenCalledOnce());
      // The member's app answers in kind: it has WebRTC, and runs Iroh for this edge now.
      edgeOf(blocked).options.events.onPacketTransports(["webrtc/1", "iroh/1"], { "iroh/1": { id: "cd".repeat(32), relay: null, addresses: [], relayed: true } });
      await vi.waitFor(async () => expect((await saved(blocked))?.peerTransports).toEqual(["webrtc/1", "iroh/1"]));
      await node.shutdown();
      nodes.splice(nodes.indexOf(node), 1);
      // The next run: WebRTC again, no endpoint (the member's app has WebRTC), and the edge says so.
      const again = await nativeEngine();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(again.iroh).not.toHaveBeenCalled();
      expect(edgeOf(blocked).options.rtcAvailable).toBe(true);
      expect(edgeOf(blocked).options.packetTransportsSaid).toBe(true);
      // The edge that never left WebRTC says nothing, as before.
      expect(edgeOf(fine).options.packetTransportsSaid).toBe(false);
    });

    it("what a member's packet said is forgotten once its packet says none any more, for the next start too", async () => {
      vi.stubGlobal("RTCPeerConnection", class {});
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const { node, iroh } = await nativeEngine();
      const { groupId } = await node.createGroup({ name: "Plaza" });
      const state = (await db.getGroups()).find((g) => g.id === groupId)!.community;
      const member = createIdentity().pubKeyZ32;
      const edgeId = await openEdge(node, state,member);
      // The member's WebRTC failed once: its edge said it had none, and this app keeps that.
      const descriptors = { "iroh/1": { id: "cd".repeat(32), relay: null, addresses: [], relayed: true } };
      edgeOf(edgeId).options.events.onPacketTransports(["iroh/1"], descriptors);
      await vi.waitFor(() => expect(edgeOf(edgeId).registerEndpoint).toHaveBeenCalledOnce());
      await vi.waitFor(async () => expect((await saved(edgeId))?.peerTransports).toEqual(["iroh/1"]));
      // Its app is back with WebRTC, and from before it said so itself: its packet carries no `_tr` (two minutes of it).
      edgeOf(edgeId).options.events.onPacketTransportsGone();
      await vi.waitFor(async () => expect(await saved(edgeId)).toMatchObject({ id: edgeId, transportSeeds: { "iroh/1": expect.any(String) } }));
      await vi.waitFor(async () => {
        const kept = await saved(edgeId);
        expect(kept?.peerTransports).toBeUndefined();
        expect(kept?.peerDescriptors).toBeUndefined();
        expect(kept?.peerFallback).toBeUndefined();
      });
      await db.patchLink(edgeId, { edgeLive: true, edgeLiveSince: Date.now() });
      await node.shutdown();
      nodes.splice(nodes.indexOf(node), 1);
      // Started again: an edge between two apps with WebRTC, which takes no listener and resumes on WebRTC.
      const again = await nativeEngine();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(again.iroh).not.toHaveBeenCalled();
      expect(iroh).toHaveBeenCalledOnce();
      expect(edgeOf(edgeId).options.native).toMatchObject({ peerTransports: undefined, peerDescriptors: undefined });
      expect(edgeOf(edgeId).options.resume).toBe("webrtc/1");
      // It ran an endpoint here, so it says what it runs now: the member's app kept its `["webrtc/1", "iroh/1"]`.
      expect(edgeOf(edgeId).options.packetTransportsSaid).toBe(true);
    });

    it("a link waiting for a native slot waits for none once its member's packet says it has WebRTC, or says no transports any more", async () => {
      // Five saved contacts and three group links hold the eight listeners: the next two group links wait.
      const chats = Array.from({ length: 5 }, () => row({ pairedPeerKey: createIdentity().pubKeyZ32 }));
      for (const r of chats) await db.putLink(r);
      vi.stubGlobal("RTCPeerConnection", class {});
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const { node } = await nativeEngine();
      await vi.waitFor(() => { for (const chat of chats) expect(edgeOf(chat.id).registerEndpoint).toHaveBeenCalled(); });
      const { groupId } = await node.createGroup({ name: "Plaza" });
      const state = (await db.getGroups()).find((g) => g.id === groupId)!.community;
      const members = Array.from({ length: 5 }, () => createIdentity().pubKeyZ32);
      const edgeIds: string[] = [];
      for (const member of members) edgeIds.push(await openEdge(node, state,member));
      // Each member's app said it has no WebRTC.
      for (const id of edgeIds) edgeOf(id).options.events.onPacketTransports(["iroh/1"], {});
      const waiting = () => members.filter((member) => (node["edgeView"](groupId, member) as GroupEdgeView | undefined)?.noSlot);
      await vi.waitFor(() => expect(waiting()).toHaveLength(2));
      const [one, two] = waiting().map((member) => edgeIds[members.indexOf(member)]);
      edgeOf(one).options.events.onPacketTransports(["webrtc/1"], {});
      await vi.waitFor(() => expect(waiting()).toHaveLength(1));
      edgeOf(two).options.events.onPacketTransportsGone();
      await vi.waitFor(() => expect(waiting()).toHaveLength(0));
    });

    it("an app with no WebRTC offers to be no private group's hub, and gives its groups four connections in all", async () => {
      const iroh = vi.fn(async () => endpoint());
      const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() };
      const node = new GhostlyNode(events, { automaticWallets: false, transport: fixture, platform: "desktop", nativeTransports: { "iroh/1": iroh } });
      nodes.push(node);
      await node.start();
      const host = node["groups"]["host"] as { staysOnline(): boolean; peerRoom(groupId: string): number | undefined };
      // A Linux Desktop: native listeners only, a few of them. A Mac (WebRTC) stays a hub candidate, as before.
      expect(host.staysOnline()).toBe(false);
      const { groupId } = await node.createGroup({ name: "Plaza" });
      expect(host.peerRoom(groupId)).toBe(GROUP_NATIVE_SLOTS);
      // Another group's links take from the same four.
      const other = await node.createGroup({ name: "Other" });
      const state = (await db.getGroups()).find((g) => g.id === other.groupId)!.community;
      await openEdge(node, state,createIdentity().pubKeyZ32);
      expect(host.peerRoom(groupId)).toBe(GROUP_NATIVE_SLOTS - 1);
      vi.stubGlobal("RTCPeerConnection", class {});
      onTestFinished(() => { vi.unstubAllGlobals(); });
      expect(host.staysOnline()).toBe(true);
      expect(host.peerRoom(groupId)).toBeUndefined();
    });

    it("an app whose Iroh is the browser build holds twelve Iroh listeners for group links: six members with no WebRTC are all reached, the thirteenth waits", async () => {
      // As the CLI runs (the web app the same, its HyperDHT through a relay): Iroh's wasm, HyperDHT of its own, WebRTC.
      vi.stubGlobal("RTCPeerConnection", class {});
      onTestFinished(() => { vi.unstubAllGlobals(); });
      irohWeb.start.mockImplementation(async () => endpoint());
      const hyper = vi.fn(async () => ({ ...endpoint(), transport: "hyperdht/1" as const, descriptor: { publicKey: "ef".repeat(32) } }));
      const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() };
      const node = new GhostlyNode(events, { automaticWallets: false, transport: fixture, irohWeb: true, nativeTransports: { "hyperdht/1": hyper } });
      nodes.push(node);
      await node.start();
      const { groupId } = await node.createGroup({ name: "Team" });
      const state = (await db.getGroups()).find((g) => g.id === groupId)!.community;
      const members: string[] = [], edgeIds: string[] = [];
      const join = async (count: number) => {
        for (let i = 0; i < count; i++) {
          const member = createIdentity().pubKeyZ32;
          members.push(member);
          edgeIds.push(await openEdge(node, state, member));
          // The member's app said it has no WebRTC on this link (a Linux Desktop, or an edge whose WebRTC connected nothing).
          edgeOf(edgeIds.at(-1)!).options.events.onPacketTransports(["iroh/1", "hyperdht/1"], {});
        }
      };
      const running = (transport: string) => edgeIds.filter((id) => edgeOf(id).availableTransports.includes(transport));
      const waiting = () => members.filter((member) => (node["edgeView"](groupId, member) as GroupEdgeView | undefined)?.noSlot);
      await join(6);
      await vi.waitFor(() => expect(running("iroh/1")).toHaveLength(6));
      // HyperDHT keeps its four: a link needs one native transport, and none of the six waits.
      await vi.waitFor(() => expect(running("hyperdht/1")).toHaveLength(GROUP_NATIVE_SLOTS));
      expect(waiting()).toHaveLength(0);
      await join(7);
      await vi.waitFor(() => expect(waiting()).toHaveLength(1));
      expect(running("iroh/1")).toHaveLength(GROUP_IROH_WEB_SLOTS);
      expect(running("hyperdht/1")).toHaveLength(GROUP_NATIVE_SLOTS);
      // With no WebRTC (GHOSTLY_WEBRTC=0), those twelve are what its groups may hold in all.
      vi.unstubAllGlobals();
      expect((node["groups"]["host"] as { peerRoom(groupId: string): number | undefined }).peerRoom(groupId)).toBe(GROUP_IROH_WEB_SLOTS);
      expect(GROUP_IROH_WEB_SLOTS).toBe(12);
    });

    it("1:1 chats hold eight of the browser build's sixteen Iroh listeners as before, and group links what they leave", async () => {
      // Nine saved contacts: eight keep a listener, as on every app; the ninth takes one when its chat is in use.
      const chats = Array.from({ length: 9 }, () => row({ pairedPeerKey: createIdentity().pubKeyZ32 }));
      for (const r of chats) await db.putLink(r);
      vi.stubGlobal("RTCPeerConnection", class {});
      onTestFinished(() => { vi.unstubAllGlobals(); });
      irohWeb.start.mockImplementation(async () => endpoint());
      await db.putSettings({ ...(await db.getSettings()), hyperdhtRelay: "" });
      const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() };
      const node = new GhostlyNode(events, { automaticWallets: false, transport: fixture, irohWeb: true });
      nodes.push(node);
      await node.start();
      const onIroh = (ids: string[]) => ids.filter((id) => edgeOf(id).availableTransports.includes("iroh/1"));
      await vi.waitFor(() => expect(onIroh(chats.map((c) => c.id))).toHaveLength(8));
      await node["nativeQueues"].get("iroh/1");
      expect(onIroh(chats.map((c) => c.id))).toHaveLength(8);
      const { groupId } = await node.createGroup({ name: "Team" });
      const state = (await db.getGroups()).find((g) => g.id === groupId)!.community;
      const members = Array.from({ length: 9 }, () => createIdentity().pubKeyZ32);
      const edgeIds: string[] = [];
      for (const member of members) edgeIds.push(await openEdge(node, state, member));
      for (const id of edgeIds) edgeOf(id).options.events.onPacketTransports(["iroh/1"], {});
      // Eight of the nine links take the eight listeners the chats leave; the ninth waits, and no chat lost its own.
      const waiting = () => members.filter((member) => (node["edgeView"](groupId, member) as GroupEdgeView | undefined)?.noSlot);
      await vi.waitFor(() => expect(waiting()).toHaveLength(1));
      expect(onIroh(edgeIds)).toHaveLength(8);
      expect(onIroh(chats.map((c) => c.id))).toHaveLength(8);
    });

    it("group links hold at most half the native slots, a chat takes one back from an idle group link, and a link with none says it waits", async () => {
      // Five saved contacts: each keeps a native listener (five of eight).
      const chats = Array.from({ length: 5 }, () => row({ pairedPeerKey: createIdentity().pubKeyZ32 }));
      const later = row();
      for (const r of [...chats, later]) await db.putLink(r);
      const { node } = await nativeEngine();
      await vi.waitFor(() => { for (const chat of chats) expect(edgeOf(chat.id).registerEndpoint).toHaveBeenCalled(); });
      const { groupId } = await node.createGroup({ name: "Plaza" });
      const state = (await db.getGroups()).find((g) => g.id === groupId)!.community;
      const members = Array.from({ length: 5 }, () => createIdentity().pubKeyZ32);
      const edgeIds: string[] = [];
      for (const member of members) edgeIds.push(await openEdge(node, state,member));
      await node["nativeQueue"];
      await vi.waitFor(() => expect(edgeIds.filter((id) => edgeOf(id).availableTransports.includes("iroh/1"))).toHaveLength(3));
      // Three of the five got the three slots left (eight in all); the other two wait, and their rows say so.
      // (What each member's row shows: the edge's view.)
      const members$ = () => members.map((member) => ({ edge: node["edgeView"](groupId, member) as GroupEdgeView | undefined }));
      await vi.waitFor(() => expect(members$().filter((m) => m.edge?.noSlot)).toHaveLength(2));
      // Opening a chat with no listener takes one from a group link that carries nothing, never from a chat.
      node.setActiveLink({ linkId: later.id });
      await vi.waitFor(() => expect(edgeOf(later.id).registerEndpoint).toHaveBeenCalled());
      for (const chat of chats) expect(edgeOf(chat.id).releaseEndpoint).not.toHaveBeenCalled();
      expect(edgeIds.filter((id) => edgeOf(id).availableTransports.includes("iroh/1"))).toHaveLength(2);
      await vi.waitFor(() => expect(members$().filter((m) => m.edge?.noSlot)).toHaveLength(3));
    });

    it("an app with neither WebRTC nor a native transport says its group links have none", async () => {
      const { node } = await started();
      expect(node.getState().transport).toMatchObject({ webrtc: false, groupLinks: false });
    });
  });

  it("a member's name stays while their edge is down, and only the member removes it", async () => {
    const { node } = await started();
    const { groupId } = await node.createGroup({ name: "Friends", profile: "mesh" });
    const state = (await db.getGroups()).find((g) => g.id === groupId)!.state;
    const member = createIdentity().pubKeyZ32;
    const edgeId = await openEdge(node, state,member);
    const edge = links.find((l) => l.options.params.id === edgeId)!;
    const session = node["groups"]["sessions"].get(groupId)!;
    const hooks = session["hooks"], changed = hooks.changed;
    let changes = 0;
    hooks.changed = () => { changes++; changed(); };
    const nick = async () => { await session["serialize"](async () => {}); return session.state.nicks[member]; };
    const { events } = edge.options;
    // As GhostLink says it: an open edge before and after the member's own `paired-nick`, then the edge closing.
    const opens = async (name: string | null) => {
      edge.isDataLinkOpen = true;
      events.onPresence({ online: true, lastPacketAt: 0, services: null });
      events.onPeerNick?.(name);
      events.onPresence({ online: true, lastPacketAt: 0, services: null, nick: name ?? undefined });
    };
    const closes = () => { edge.isDataLinkOpen = false; events.onPresence({ online: false, lastPacketAt: 0, services: null }); };
    await opens("Carol");
    expect(await nick()).toBe("Carol");
    expect(changes).toBe(1);
    for (let i = 0; i < 3; i++) {
      closes();
      expect(await nick()).toBe("Carol");
      await opens("Carol");
      expect(await nick()).toBe("Carol");
    }
    expect(changes).toBe(1);
    // A new name, and a name the member removed on purpose, are theirs to say.
    await opens("Caz");
    expect(await nick()).toBe("Caz");
    await opens(null);
    expect(await nick()).toBeUndefined();
    closes();
    expect(await nick()).toBeUndefined();
    // While it is down, the member's packet can still bring a new name.
    events.onPresence({ online: true, lastPacketAt: 5, services: null, nick: "Cee" });
    expect(await nick()).toBe("Cee");
    expect(changes).toBe(4);
  });

  it("a community group is what a group is by default; its link is group2 and every member's", async () => {
    const { node } = await started();
    const { groupId } = await node.createGroup({ name: "Plaza" });
    const stored = (await db.getGroups()).find((g) => g.id === groupId)!;
    expect(stored.community?.profile).toBe("group-community/1");
    expect(stored.state).toBeUndefined();
    const { link } = await node.enableGroupLink({ groupId });
    expect(link).toMatch(new RegExp(`^group2/${groupId}/`));
    expect(node.getState().groups.find(g => g.id === groupId)).toMatchObject({ profile: "community", isAdmin: true, entryLink: link });
  });
});
