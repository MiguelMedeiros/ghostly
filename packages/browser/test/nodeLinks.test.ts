import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, createIdentity, type FileSink, type GhostLinkOptions } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, fileStore, transact } from "../src/shared/idb";
import { storedBlob } from "../src/shared/storedFiles";
import type { StoredLink } from "../src/shared/types";
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
    nativeDescriptors = {};
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
    allowsPayment = vi.fn(() => true);
    constructor(readonly options: GhostLinkOptions) { links.push(this as never); }
  }
  return { ...actual, GhostLink: RecordedLink };
});

const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
const nodes: GhostlyNode[] = [];
function engine() {
  const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() };
  const node = new GhostlyNode(events, { automaticWallets: false, transport: fixture });
  nodes.push(node);
  return { node, events };
}
function row(stored: Partial<StoredLink> = {}): StoredLink {
  return { id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64, ...stored };
}
/** An engine started with these chats saved, each running on a recorded link. */
async function started(...rows: StoredLink[]) {
  for (const r of rows) await db.putLink(r);
  const setup = engine();
  await setup.node.start();
  const linkOf = (id: string) => links.find((l) => l.options.params.id === id)!;
  return { ...setup, linkOf };
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

  it("a ready session remembers which ways of paying the contact allows, for requests held while it is away", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    const remember = vi.spyOn(node["hold"], "rememberPeerMethods");
    linkOf(chat.id).options.events.onPairingState({ status: "ready" });
    expect(remember).toHaveBeenCalledWith(chat.id, ["cashu"]);
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
  it("a chat live when the app last ran resumes on that transport; one that ended off live, DHT only or unpaired does not", async () => {
    const paired = { pairedPeerKey: createIdentity().pubKeyZ32 };
    const live = row({ ...paired, transportHistory: [{ at: 1, kind: "live", transport: "iroh/1" }] });
    const switched = row({ ...paired, transportHistory: [{ at: 1, kind: "live", transport: "webrtc/1" }, { at: 2, kind: "switched", from: "webrtc/1", transport: "hyperdht/1" }] });
    const dropped = row({ ...paired, transportHistory: [{ at: 1, kind: "live", transport: "iroh/1" }, { at: 2, kind: "down", from: "iroh/1" }] });
    const dhtOnly = row({ ...paired, deliveryMode: "dht", transportHistory: [{ at: 1, kind: "live", transport: "iroh/1" }] });
    const unpaired = row({ transportHistory: [{ at: 1, kind: "live", transport: "iroh/1" }] });
    const { linkOf } = await started(live, switched, dropped, dhtOnly, unpaired);
    expect([live, switched, dropped, dhtOnly, unpaired].map(chat => linkOf(chat.id).options.resume))
      .toEqual(["iroh/1", "hyperdht/1", undefined, undefined, undefined]);
  });

  it("shutting down says goodbye on every link before anything else it waits for", async () => {
    const chat = row({ pairedPeerKey: createIdentity().pubKeyZ32 });
    const { node, linkOf } = await started(chat);
    const link = linkOf(chat.id) as unknown as { depart: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    const stopping = node.shutdown();
    // Said synchronously, as the page may be gone by the next tick.
    expect(link.depart).toHaveBeenCalledOnce();
    expect(link.stop).not.toHaveBeenCalled();
    await stopping;
    expect(link.stop).toHaveBeenCalled();
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
    expect(() => node.sendPayment({ linkId: chat.id, amount: 1, timestamp: 1 })).toThrow("not held");
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
    const edgeId = await node["openEdge"](state as never, member);
    expect(await node["openEdge"](state as never, member)).toBe(edgeId);
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
    const { node } = await started();
    // A community: its edges are kept as the app starts (a private group's to keys not in its roster go at once).
    const { groupId } = await node.createGroup({ name: "Plaza" });
    const state = (await db.getGroups()).find((g) => g.id === groupId)!.community;
    const [kept, dropped] = [createIdentity().pubKeyZ32, createIdentity().pubKeyZ32];
    const keptId = await node["openEdge"](state as never, kept), droppedId = await node["openEdge"](state as never, dropped);
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

  it("a member's name stays while their edge is down, and only the member removes it", async () => {
    const { node } = await started();
    const { groupId } = await node.createGroup({ name: "Friends", profile: "mesh" });
    const state = (await db.getGroups()).find((g) => g.id === groupId)!.state;
    const member = createIdentity().pubKeyZ32;
    const edgeId = await node["openEdge"](state as never, member);
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
