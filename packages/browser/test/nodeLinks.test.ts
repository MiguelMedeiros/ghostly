import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, createIdentity, type FileSink, type GhostLinkOptions } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, fileStore, transact } from "../src/shared/idb";
import type { StoredLink } from "../src/shared/types";
// covers: core.peer-keys, chat.paired.send, chat.paired.receipts, chat.paired.nickname-sync, files.paired.send, files.size-limit, files.persistence, delivery.hold.text, delivery.hold.picture, groups.protocol.link-frames

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
    identitySupport = false;
    peerProofAdapters: string[] = [];
    session = { setActive: vi.fn(), pollNow: vi.fn(), setFastPoll: vi.fn() };
    start = vi.fn();
    stop = vi.fn(async () => {});
    wake = vi.fn();
    connect = vi.fn(async () => {});
    disconnect = vi.fn();
    sendFile = vi.fn(async (_wire: unknown, source: AsyncIterable<Uint8Array>) => { for await (const chunk of source) this.sent.push(chunk); });
    sent: Uint8Array[] = [];
    sendMessage = vi.fn(async () => null);
    validateText = vi.fn(() => null);
    setCallSignal = vi.fn(async () => {});
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
    expect(events.onAttention).toHaveBeenCalledWith(expect.objectContaining({ type: "message" }));
  });

  it("remembers the contact's nick and picture, and writes only what changed", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    const patch = vi.spyOn(db, "patchLink");
    const { events } = linkOf(chat.id).options;
    events.onPresence({ online: true, lastPacketAt: 9, services: null, nick: "Bob" });
    events.onPresence({ online: true, lastPacketAt: 10, services: null, nick: "Bob" });
    events.onPeerAvatar("data:image/jpeg;base64,AAAA");
    events.onPeerAvatar("data:image/jpeg;base64,AAAA");
    events.onPeerAvatar(null);
    expect(patch.mock.calls.map(([, p]) => p)).toEqual([{ peerNick: "Bob" }, { peerAvatar: "data:image/jpeg;base64,AAAA" }, { peerAvatar: undefined }]);
    expect(node.getState().links[0]).toMatchObject({ peerNick: "Bob", peerOnline: true, peerLastSeenAt: 10, peerAvatar: undefined });
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
    const sink = announce("w1") as FileSink;
    sink.write(bytes("hello"));
    events.onFileProgress("w1", 3, "in");
    const [file] = await vi.waitFor(async () => { const m = await db.getMessages(chat.id); expect(m).toHaveLength(1); return m.map((x) => x.file!); });
    expect(file.id.startsWith(`${chat.id}-in-`)).toBe(true);
    expect(file.id).not.toContain("w1");
    expect(node.getState().transfers[file.id]).toMatchObject({ state: "transferring", transferred: 3 });
    await sink.close("digest-1");
    events.onFileComplete("w1", "in");
    expect(node.getState().transfers[file.id]).toMatchObject({ state: "done", transferred: 5 });
    const stored = await fileStore.get(file.id);
    expect(stored).toMatchObject({ direction: "in", wireId: "w1", digest: "digest-1", metadata: { name: "a.txt", mime: "text/html" } });
    expect(stored!.blob.type).not.toBe("text/html");
    // Asked whether it is already here: only an exact match of what was announced says yes.
    expect(await events.onFileStored({ id: "w1", name: "a.txt", size: 5, mime: "text/html", timestamp: 7 })).toBe("digest-1");
    expect(await events.onFileStored({ id: "w1", name: "b.txt", size: 5, mime: "text/html", timestamp: 7 })).toBeUndefined();
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

  it("fails visibly when offline, for an id not of this chat, a peer without files, or bytes that are gone", async () => {
    const chat = row(), away = row();
    const { node, linkOf } = await started(chat, away);
    node["links"].get(away.id)!.link = null;
    const failed = (id: string) => node.getState().transfers[id];
    const file = (id: string) => ({ id, name: "a", size: 1, mime: "" });
    node.sendFile({ linkId: away.id, file: file(`${away.id}-out-1`), timestamp: 1 });
    expect(failed(`${away.id}-out-1`)).toMatchObject({ state: "failed", error: "You are offline" });
    node.sendFile({ linkId: chat.id, file: file("someone-elses-file"), timestamp: 1 });
    expect(failed("someone-elses-file")).toMatchObject({ state: "failed", error: "Invalid file id" });
    node.sendFile({ linkId: chat.id, file: file(`${chat.id}-out-gone`), timestamp: 2 });
    await vi.waitFor(() => expect(failed(`${chat.id}-out-gone`)).toMatchObject({ state: "failed", error: "The file is gone" }));
    linkOf(chat.id).supportsFiles = false;
    node.sendFile({ linkId: chat.id, file: file(`${chat.id}-out-2`), timestamp: 3 });
    expect(failed(`${chat.id}-out-2`)).toMatchObject({ state: "failed", error: expect.stringContaining("updated peer") });
  });
});

describe("text in a chat", () => {
  it("a paired chat keeps the message before it goes out, and hands it to the outbox", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    expect(await node.sendMessage({ linkId: chat.id, text: "  hi  ", timestamp: 4 })).toEqual({ error: null });
    const [message] = await db.getMessages(chat.id);
    expect(message).toMatchObject({ text: "hi", sender: "me", via: "datalink" });
    expect(linkOf(chat.id).sendMessage).toHaveBeenCalledWith("hi", 4, message.wireId);
    linkOf(chat.id).validateText.mockReturnValueOnce("Payment tokens are not text" as never);
    expect(await node.sendMessage({ linkId: chat.id, text: "cashuA" })).toEqual({ error: "Payment tokens are not text" });
    expect(await db.getMessages(chat.id)).toHaveLength(1);
  });

  it("a legacy chat refuses what the DHT cannot carry before keeping it, and a delivered message moves the read mark", async () => {
    const chat = row({ profile: undefined, participationSeed: undefined });
    const { node, linkOf } = await started(chat);
    const link = linkOf(chat.id);
    link.isDataLinkOpen = false;
    expect(await node.sendMessage({ linkId: chat.id, text: "x".repeat(600) })).toMatchObject({ refused: true });
    expect(await db.getMessages(chat.id)).toEqual([]);
    link.isDataLinkOpen = true;
    expect(await node.sendMessage({ linkId: chat.id, text: "x".repeat(600), timestamp: 9 })).toEqual({ error: null });
    expect(node.getState().links[0].peerAck).toBe(9);
    expect((await db.getMessages(chat.id))[0]).toMatchObject({ id: "me_9", via: "datalink" });
  });

  it("for an away contact that allows it, a text is held in storage, and never above the held-text limit", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    linkOf(chat.id).isDataLinkOpen = false;
    vi.spyOn(node["hold"], "canHold").mockReturnValue(true);
    const hold = vi.spyOn(node["hold"], "hold").mockResolvedValue();
    expect((await node.sendMessage({ linkId: chat.id, text: "x".repeat(70_000) })).error).toContain("held message is at most");
    expect(await node.sendMessage({ linkId: chat.id, text: "later", timestamp: 3 })).toEqual({ error: null });
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

  it("a file waits in storage for the contact, within the size of one held item", async () => {
    const { node, chat, hold } = await away();
    const big = { id: `${chat.id}-out-big`, name: "big", size: 64 * 1024 * 1024, mime: "" };
    node.sendFile({ linkId: chat.id, file: big, timestamp: 1 });
    expect(node.getState().transfers[big.id]).toMatchObject({ state: "failed", error: expect.stringContaining("at most") });
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
    const { groupId } = await node.createGroup({ name: "  Friends  " });
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
});
