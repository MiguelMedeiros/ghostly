import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, type GhostLinkOptions } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, fileStore, transact } from "../src/shared/idb";
import type { StoredLink } from "../src/shared/types";
// covers: chat.paired.block

/**
 * GhostLink is replaced by a recorder, as in nodeLinks.test.ts: the engine builds it with its callbacks, and a test
 * plays the contact by calling them. No networking.
 */
type Recorded = {
  options: Omit<GhostLinkOptions, "events" | "params"> & { params: StoredLink; events: Required<NonNullable<GhostLinkOptions["events"]>> };
  sendWake: ReturnType<typeof vi.fn>;
};
const links = vi.hoisted(() => [] as Recorded[]);
vi.mock("@ghostly/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ghostly/core")>();
  class RecordedLink {
    availableTransports = ["webrtc/1"];
    isDataLinkOpen = true;
    supportsFiles = true;
    supportsWake = true;
    canSendText = true;
    textRoom = true;
    textDelivery = "stream";
    groupsSupport = false;
    supportsGroupVersion = vi.fn(() => false);
    identitySupport = false;
    peerProofAdapters: string[] = [];
    session = { setActive: vi.fn(), pollNow: vi.fn(), setFastPoll: vi.fn() };
    setChatActive = (active: boolean) => this.session.setActive(active);
    learnPeerTransports = vi.fn();
    learnPeerChoice = vi.fn();
    registerEndpoint = vi.fn();
    canReleaseEndpoint = vi.fn(() => true);
    releaseEndpoint = vi.fn(async () => {});
    lastActivityAt = Date.now();
    callOn = false;
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
    sendFile = vi.fn(async () => {});
    sendMessage = vi.fn(async () => null);
    sendWake = vi.fn();
    validateText = vi.fn(() => null);
    setCallSignal = vi.fn(async () => {});
    setTyping = vi.fn();
    setStatus = vi.fn();
    refreshServices = vi.fn(async () => {});
    confirmPair = vi.fn(async () => {});
    peerAllowsPayment = vi.fn(() => true);
    peerChoosesPayment = vi.fn(() => true);
    allowsPayment = vi.fn(() => true);
    dhtHolds = vi.fn(() => false);
    withdrawDht = vi.fn(async () => {});
    constructor(readonly options: GhostLinkOptions) { links.push(this as never); }
  }
  return { ...actual, GhostLink: RecordedLink };
});

const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
const nodes: GhostlyNode[] = [];
function row(stored: Partial<StoredLink> = {}): StoredLink {
  return { id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64, ...stored };
}
async function started(...rows: StoredLink[]) {
  for (const r of rows) await db.putLink(r);
  const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn(), onAppFrame: vi.fn() };
  const node = new GhostlyNode(events, { automaticWallets: false, transport: fixture });
  nodes.push(node);
  await node.start();
  const linkOf = (id: string) => links.find((l) => l.options.params.id === id)!;
  return { node, events, linkOf };
}
const viewOf = (node: GhostlyNode, id: string) => node.getState().links.find((l) => l.id === id)!;
const offer = JSON.stringify({ t: "o", ts: Date.now(), u: "ufrag", p: "a".repeat(22), f: "0".repeat(64), s: "actpass" });

beforeEach(async () => {
  links.length = 0;
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await transact([STORES.links, STORES.messages, STORES.files, STORES.payments], (s) => { for (const n of [STORES.links, STORES.messages, STORES.files, STORES.payments]) s[n].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); vi.restoreAllMocks(); });

describe("a blocked contact", () => {
  it("sends nothing that is kept, notified or rung, in every chat with its key; the chat keeps what it had", async () => {
    const chat = row(), again = row({ peerPubKeyZ32: undefined }), other = row();
    again.peerPubKeyZ32 = chat.peerPubKeyZ32;
    const { node, events, linkOf } = await started(chat, again, other);
    await linkOf(chat.id).options.events.onMessage({ id: "w1", text: "before", timestamp: Date.now(), via: "datalink" });
    await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: true });
    expect((await db.getSettings()).blockedContacts).toEqual([chat.peerPubKeyZ32]);
    expect(viewOf(node, chat.id).blocked).toBe(true);
    expect(viewOf(node, again.id).blocked).toBe(true);
    expect(viewOf(node, other.id).blocked).toBeUndefined();
    events.onAttention.mockClear();
    const reacted = vi.spyOn(node["reactions"], "receive");

    for (const id of [chat.id, again.id]) {
      const peer = linkOf(id).options.events;
      await peer.onMessage({ id: "w2", text: "after", timestamp: Date.now() + 1_000, via: "datalink" });
      peer.onCallSignal(offer);
      // Confirmed, so the contact does not say them again, and dropped.
      expect(await peer.onReaction({ id: "w1", e: "👍", n: 1 })).toBe(true);
      expect(await peer.onPin({ id: "w1", timestamp: Date.now() } as never)).toBe(true);
    }
    expect((await db.getMessages(chat.id)).map((m) => m.text)).toEqual(["before"]);
    expect(await db.getMessages(again.id)).toEqual([]);
    expect(events.onCallSignal).not.toHaveBeenCalled();
    expect(events.onAttention).not.toHaveBeenCalled();
    expect(reacted).not.toHaveBeenCalled();
    expect(viewOf(node, chat.id).pin).toBeUndefined();
    // Another contact is heard as before.
    await linkOf(other.id).options.events.onMessage({ id: "w3", text: "hi", timestamp: Date.now(), via: "datalink" });
    linkOf(other.id).options.events.onCallSignal(offer);
    expect(await db.getMessages(other.id)).toHaveLength(1);
    expect(events.onCallSignal).toHaveBeenCalledWith(other.id, offer);
  });

  it("rings no more for an offer heard before; its edits, payments, files, typing and status are dropped too", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    const peer = linkOf(chat.id).options.events;
    peer.onCallSignal(offer);
    expect(node["offersWaiting"].has(chat.id)).toBe(true);
    await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: true });
    expect(node["offersWaiting"].has(chat.id)).toBe(false);
    // Confirmed (not asked for again in a minute) though its message is not here.
    expect(await node["receiveEdit"](chat.id, { id: "missing", text: "changed", ts: Date.now() } as never)).toBe(true);
    const pay = vi.spyOn(node["desk"], "onPayment"), request = vi.spyOn(node["desk"], "onPaymentRequest"), ask = vi.spyOn(node["desk"], "onPaymentAsk");
    await peer.onPayment({ id: "p1" } as never);
    await peer.onPaymentRequest({ id: "p2" } as never);
    await peer.onPaymentAsk({ id: "p3" } as never);
    expect([pay, request, ask].map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    // One under way when the block came is not kept (`FileDesk`'s `deleted`).
    expect(node["fileDesk"]["deps"].deleted(chat.id, "peer_f1")).toBe(true);
    Object.assign(linkOf(chat.id), { peerTyping: true, peerTypingActivity: null, peerStatus: { presence: "away", status: { text: "busy" } } });
    peer.onPeerTyping(true);
    expect(viewOf(node, chat.id)).not.toHaveProperty("peerTyping");
    expect(viewOf(node, chat.id)).not.toHaveProperty("peerStatus");
    expect(viewOf(node, chat.id)).not.toHaveProperty("peerPresence");
  });

  it("writes none of its files, by any way they come, and answers none of its offers", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    const peer = linkOf(chat.id).options.events;
    await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: true });
    // files/3: the offer reaches no file desk, so it is neither taken nor declined (a decline would tell the contact).
    const desk = vi.spyOn(node["fileDesk"], "handle");
    await peer.onFilesFrame({ t: "pf-offer", id: "wBlockedFile1", name: "a.pdf", mime: "application/pdf", size: 2048, ts: Date.now() });
    expect(desk).not.toHaveBeenCalled();
    // files/2: refused before anything is stored.
    expect(peer.onFileIncoming({ id: "f2", name: "b.txt", size: 4, mime: "text/plain", timestamp: Date.now() })).toBe("refused");
    // Said on the DHT floor: no bubble, no record.
    await peer.onFileAnnounced!({ wireId: "f3", name: "c.txt", size: 4, mime: "text/plain", timestamp: Date.now() } as never, {} as never);
    // From the hold: taken as a deleted file is, and nothing written.
    const host = node["hold"]["host"] as { receiveFile(linkId: string, wire: object, bytes: Uint8Array, digest: string): Promise<string | null> };
    expect(await host.receiveFile(chat.id, { wireId: "f4", name: "d.txt", size: 4, mime: "text/plain", timestamp: 5 }, new TextEncoder().encode("held"), "d")).toBeNull();
    expect(await fileStore.listForLink(chat.id)).toEqual([]);
    expect(await db.getMessages(chat.id)).toEqual([]);
  });

  it("keeps the name and picture it had, and takes no group invitation, proof or app frame from it", async () => {
    const chat = row({ peerNick: "Bob" });
    const { node, events, linkOf } = await started(chat);
    const peer = linkOf(chat.id).options.events;
    await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: true });
    peer.onPeerNick("Renamed");
    peer.onPeerAvatar("data:image/jpeg;base64,AAAA");
    expect(viewOf(node, chat.id)).toMatchObject({ peerNick: "Bob" });
    expect(viewOf(node, chat.id).peerAvatar).toBeUndefined();
    const contactFrame = vi.spyOn(node["groups"], "handleContactFrame").mockResolvedValue();
    await peer.onGroupFrame({ t: "group-invite", g: "g".repeat(22), admin: createIdentity().pubKeyZ32, name: "Trap" });
    expect(contactFrame).not.toHaveBeenCalled();
    // The signaling of a group both are in still goes through.
    await peer.onGroupFrame({ t: "group-signal", g: "g".repeat(22) });
    expect(contactFrame).toHaveBeenCalledTimes(1);
    const proofs = vi.spyOn(node["identities"], "frame");
    await peer.onIdentityProof({ t: "id-proof" } as never);
    expect(proofs).not.toHaveBeenCalled();
    const asked = vi.spyOn(node as never, "appRangeAsked" as never);
    peer.onAppFrame?.({ t: "app" } as never);
    await peer.onAppRangeTask?.({} as never);
    expect(events.onAppFrame).not.toHaveBeenCalled();
    expect(asked).not.toHaveBeenCalled();
  });

  it("is told not to wake this app; unblocked, it is heard again", async () => {
    const chat = row();
    const { node, events, linkOf } = await started(chat);
    await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: true });
    expect(linkOf(chat.id).sendWake).toHaveBeenLastCalledWith(null);
    await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: false });
    expect((await db.getSettings()).blockedContacts).toBeUndefined();
    expect(viewOf(node, chat.id).blocked).toBeUndefined();
    await linkOf(chat.id).options.events.onMessage({ id: "w1", text: "back", timestamp: Date.now(), via: "datalink" });
    linkOf(chat.id).options.events.onCallSignal(offer);
    expect((await db.getMessages(chat.id)).map((m) => m.text)).toEqual(["back"]);
    expect(events.onCallSignal).toHaveBeenCalledWith(chat.id, offer);
  });

  it("leaves no payment request record from the hold, as none from a live one", async () => {
    const chat = row();
    const { node } = await started(chat);
    await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: true });
    const request = vi.spyOn(node["desk"], "onPaymentRequest");
    const host = node["hold"]["host"] as { receivePaymentRequest(linkId: string, request: object): Promise<void> };
    await host.receivePaymentRequest(chat.id, { id: "held-request", timestamp: Date.now(), amount: { value: 21, asset: "sat" } });
    expect(request).not.toHaveBeenCalled();
    // Another contact's comes in as before.
    const other = row();
    await db.putLink(other);
    await host.receivePaymentRequest(other.id, { id: "other-request", timestamp: Date.now(), amount: { value: 21, asset: "sat" } }).catch(() => {});
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("is not kept when the block lands while its text is being stored", async () => {
    const chat = row();
    const { node, events, linkOf } = await started(chat);
    const resolve = node["resolveReply"].bind(node);
    vi.spyOn(node as never, "resolveReply" as never).mockImplementation((async (message: never) => {
      await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: true });
      return resolve(message);
    }) as never);
    events.onAttention.mockClear();
    await linkOf(chat.id).options.events.onMessage({ id: "w1", text: "racing", timestamp: Date.now(), via: "datalink" });
    expect(await db.getMessages(chat.id)).toEqual([]);
    expect(events.onAttention).not.toHaveBeenCalled();
  });

  it("offers none of its services, nor any its presence says later", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    const peer = linkOf(chat.id).options.events;
    const services = [{ name: "wiki", port: 8080 }] as never;
    peer.onPresence({ online: true, lastPacketAt: 1, services });
    expect(viewOf(node, chat.id).peerServices).toEqual(services);
    await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: true });
    expect(viewOf(node, chat.id).peerServices).toBeNull();
    peer.onPresence({ online: true, lastPacketAt: 2, services: [{ name: "renamed", port: 8080 }] as never });
    expect(viewOf(node, chat.id).peerServices).toBeNull();
    await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: false });
    expect(viewOf(node, chat.id).peerServices).toEqual([{ name: "renamed", port: 8080 }]);
  });

  it("is kept through a restart, and the settings patch cannot unblock it", async () => {
    const chat = row();
    const first = await started(chat);
    await first.node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: true });
    await first.node.updateSettings({ settings: { blockedContacts: [] } as never });
    expect((await db.getSettings()).blockedContacts).toEqual([chat.peerPubKeyZ32]);
    await first.node.shutdown();
    links.length = 0;
    const { node, linkOf } = await started();
    expect(viewOf(node, chat.id).blocked).toBe(true);
    await linkOf(chat.id).options.events.onMessage({ id: "w1", text: "after", timestamp: Date.now(), via: "datalink" });
    expect(await db.getMessages(chat.id)).toEqual([]);
  });
});
