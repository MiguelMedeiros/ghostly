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

  it("joins no group of mine by accepting an invitation made before the block; unblocked, its accept comes in", async () => {
    const chat = row();
    const { node, linkOf } = await started(chat);
    const peer = linkOf(chat.id).options.events;
    const contactFrame = vi.spyOn(node["groups"], "handleContactFrame").mockResolvedValue();
    const accept = { t: "group-accept", g: "g".repeat(22), key: createIdentity().pubKeyZ32 };
    await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: true });
    await peer.onGroupFrame(accept);
    expect(contactFrame).not.toHaveBeenCalled();
    // The signaling of a group both are in still goes through.
    await peer.onGroupFrame({ t: "group-signal", g: "g".repeat(22) });
    expect(contactFrame).toHaveBeenCalledTimes(1);
    await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: false });
    await peer.onGroupFrame(accept);
    expect(contactFrame).toHaveBeenLastCalledWith(chat.id, accept);
  });

  it("cannot be called: its answer would be dropped, so its chat says why and no call rings it for nothing", async () => {
    const chat = row(), other = row();
    const { node } = await started(chat, other);
    await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: true });
    expect(viewOf(node, chat.id).callsUnavailable).toBe("You blocked this contact. Unblock them to call");
    expect(viewOf(node, other.id).callsUnavailable).toBeUndefined();
    await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: false });
    expect(viewOf(node, chat.id).callsUnavailable).toBeUndefined();
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

  it("takes no native listener with a text over the DHT, which would take another chat's", async () => {
    // HyperDHT through a relay, as a CLI daemon's or a browser's; no listener starts here.
    await db.putSettings({ ...(await db.getSettings())!, hyperdhtRelay: "wss://relay.invalid" });
    const listen = vi.spyOn(GhostlyNode.prototype as never as { ensureNativeEndpoints(id: string, inUse?: boolean): Promise<void> }, "ensureNativeEndpoints").mockResolvedValue();
    const chat = row({ pairedPeerKey: createIdentity().pubKeyZ32 }), other = row({ pairedPeerKey: createIdentity().pubKeyZ32 });
    const { node, linkOf } = await started(chat, other);
    await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: true });
    for (const id of [chat.id, other.id]) linkOf(id).isDataLinkOpen = false;
    listen.mockClear();
    await linkOf(chat.id).options.events.onMessage({ id: "w1", text: "let me in", timestamp: Date.now(), via: "pkarr" });
    expect(listen).not.toHaveBeenCalled();
    // Another contact's text over the DHT takes one as before (`chatInUse`).
    await linkOf(other.id).options.events.onMessage({ id: "w2", text: "hi", timestamp: Date.now(), via: "pkarr" });
    expect(listen).toHaveBeenCalledWith(other.id, true);
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

describe("setContactBlocked's input", () => {
  async function watched(...rows: StoredLink[]) {
    const started_ = await started(...rows);
    const rotated = vi.spyOn(started_.node as never as { rotateWake(): Promise<void> }, "rotateWake").mockResolvedValue(undefined);
    const shared = vi.spyOn(started_.node as never as { shareWake(id: string): Promise<void> }, "shareWake");
    return { ...started_, rotated, shared };
  }

  it("takes only true or false: the word \"false\" or \"yes\" is refused and blocks nothing", async () => {
    const chat = row({ wakeToken: "t" });
    const { node, rotated, shared } = await watched(chat);
    await expect(node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: "false" as never })).rejects.toThrow();
    for (let i = 0; i < 3; i++) await expect(node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: "yes" as never })).rejects.toThrow();
    for (const blocked of [1, null, undefined, {}]) await expect(node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: blocked as never })).rejects.toThrow();
    expect((await db.getSettings()).blockedContacts).toBeUndefined();
    expect(viewOf(node, chat.id).blocked).toBeUndefined();
    expect(rotated).not.toHaveBeenCalled();
    expect(shared).not.toHaveBeenCalled();
  });

  it("keeps a key once however often it is blocked, and tells the contact once", async () => {
    const chat = row({ wakeToken: "t" });
    const { node, rotated, shared } = await watched(chat);
    for (let i = 0; i < 3; i++) await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: true });
    expect((await db.getSettings()).blockedContacts).toEqual([chat.peerPubKeyZ32]);
    expect(rotated).toHaveBeenCalledTimes(1);
    expect(shared).toHaveBeenCalledTimes(1);
  });

  it("refuses what is not a contact's key: nothing is kept", async () => {
    const { node } = await watched(row());
    const key = createIdentity().pubKeyZ32;
    // The last character of a key carries padding bits: a "b" there spells no key (WISP 02).
    const respelled = `${key.slice(0, 51)}b`;
    for (const peerPubKeyZ32 of ["__proto__", "z".repeat(2_000_000), key.slice(0, 51), `${key}y`, key.toUpperCase(), respelled, "", 5, null]) {
      await expect(node.setContactBlocked({ peerPubKeyZ32: peerPubKeyZ32 as never, blocked: true })).rejects.toThrow();
    }
    expect((await db.getSettings()).blockedContacts).toBeUndefined();
  });

  it("unblocking a key that is not blocked changes nothing and tells nobody", async () => {
    const chat = row({ wakeToken: "t" }), other = row();
    const { node, rotated, shared } = await watched(chat, other);
    await node.setContactBlocked({ peerPubKeyZ32: other.peerPubKeyZ32, blocked: true });
    rotated.mockClear(); shared.mockClear();
    const put = vi.spyOn(db, "putSettings");
    await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: false });
    await node.setContactBlocked({ peerPubKeyZ32: createIdentity().pubKeyZ32, blocked: false });
    expect(put).not.toHaveBeenCalled();
    expect(rotated).not.toHaveBeenCalled();
    expect(shared).not.toHaveBeenCalled();
    expect((await db.getSettings()).blockedContacts).toEqual([other.peerPubKeyZ32]);
  });

  it("keeps a stored list that holds a key twice or what is no key as each key once, from the start", async () => {
    const chat = row(), other = row();
    await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true, blockedContacts: ["zzz", "zzz", chat.peerPubKeyZ32, chat.peerPubKeyZ32, "__proto__", 5 as never] });
    const { node, shared } = await watched(chat, other);
    expect(node.getState().settings.blockedContacts).toEqual([chat.peerPubKeyZ32]);
    expect(node.getSettings().blockedContacts).toEqual([chat.peerPubKeyZ32]);
    expect(viewOf(node, chat.id).blocked).toBe(true);
    await node.setContactBlocked({ peerPubKeyZ32: other.peerPubKeyZ32, blocked: true });
    expect((await db.getSettings()).blockedContacts).toEqual([chat.peerPubKeyZ32, other.peerPubKeyZ32]);
    shared.mockClear();
    await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: false });
    expect(shared).toHaveBeenCalledWith(chat.id);
    expect(viewOf(node, chat.id).blocked).toBeUndefined();
    expect((await db.getSettings()).blockedContacts).toEqual([other.peerPubKeyZ32]);
  });

  it("a block or unblock the device cannot save changes nothing here, and trying again saves it", async () => {
    const chat = row();
    const { node } = await watched(chat);
    const full = () => vi.spyOn(db, "putSettings").mockRejectedValueOnce(new DOMException("full", "QuotaExceededError"));
    full();
    await expect(node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: true })).rejects.toThrow("full");
    expect(node.getSettings().blockedContacts).toBeUndefined();
    expect(viewOf(node, chat.id).blocked).toBeUndefined();
    await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: true });
    expect((await db.getSettings()).blockedContacts).toEqual([chat.peerPubKeyZ32]);
    expect(viewOf(node, chat.id).blocked).toBe(true);
    full();
    await expect(node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: false })).rejects.toThrow("full");
    expect(node.getSettings().blockedContacts).toEqual([chat.peerPubKeyZ32]);
    expect(viewOf(node, chat.id).blocked).toBe(true);
    await node.setContactBlocked({ peerPubKeyZ32: chat.peerPubKeyZ32, blocked: false });
    expect((await db.getSettings()).blockedContacts).toBeUndefined();
  });

  it("a settings write, a block or an unblock made while a block is saved keeps it, here and on the device", async () => {
    const a = row(), b = row();
    const { node } = await watched(a, b);
    await Promise.all([node.setContactBlocked({ peerPubKeyZ32: a.peerPubKeyZ32, blocked: true }), node.setWakeOnline({ on: false })]);
    expect(node.getSettings().blockedContacts).toEqual([a.peerPubKeyZ32]);
    expect((await db.getSettings())).toMatchObject({ blockedContacts: [a.peerPubKeyZ32], wakeOnline: false });
    await Promise.all([node.setContactBlocked({ peerPubKeyZ32: b.peerPubKeyZ32, blocked: true }), node.setContactBlocked({ peerPubKeyZ32: a.peerPubKeyZ32, blocked: false })]);
    expect(node.getSettings().blockedContacts).toEqual([b.peerPubKeyZ32]);
    expect((await db.getSettings()).blockedContacts).toEqual([b.peerPubKeyZ32]);
    await Promise.all([node.setContactBlocked({ peerPubKeyZ32: a.peerPubKeyZ32, blocked: true }), node.setContactBlocked({ peerPubKeyZ32: a.peerPubKeyZ32, blocked: false })]);
    expect(node.getSettings().blockedContacts).toEqual([b.peerPubKeyZ32]);
    expect((await db.getSettings()).blockedContacts).toEqual([b.peerPubKeyZ32]);
  });

  it("a block that cannot be saved leaves one saved at the same time, and one made while the wake rotates is kept", async () => {
    const a = row(), b = row(), c = row({ wakeToken: "t" }), d = row();
    const { node, rotated } = await watched(a, b, c, d);
    // A's write fails while B's goes through: B stays, and A is blocked here only if the device kept it (B's write saves
    // A too when the two overlap; when they run one at a time, A is undone before B's runs).
    vi.spyOn(db, "putSettings").mockRejectedValueOnce(new DOMException("full", "QuotaExceededError"));
    const [failed, saved] = await Promise.allSettled([node.setContactBlocked({ peerPubKeyZ32: a.peerPubKeyZ32, blocked: true }), node.setContactBlocked({ peerPubKeyZ32: b.peerPubKeyZ32, blocked: true })]);
    expect([failed.status, saved.status]).toEqual(["rejected", "fulfilled"]);
    const kept = (await db.getSettings()).blockedContacts;
    expect(kept).toContain(b.peerPubKeyZ32);
    expect(node.getSettings().blockedContacts).toEqual(kept);
    // C waits for the wake to rotate while D is asked: whether D lands during the wait (C reads the list again after it)
    // or runs after C (one at a time), both stay.
    let release: (() => void) | undefined;
    rotated.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = node.setContactBlocked({ peerPubKeyZ32: c.peerPubKeyZ32, blocked: true });
    const second = node.setContactBlocked({ peerPubKeyZ32: d.peerPubKeyZ32, blocked: true });
    await vi.waitFor(() => expect(release).toBeDefined());
    release!();
    await Promise.all([first, second]);
    const all = [...(kept ?? []), c.peerPubKeyZ32, d.peerPubKeyZ32].sort();
    expect([...(node.getSettings().blockedContacts ?? [])].sort()).toEqual(all);
    expect([...((await db.getSettings()).blockedContacts ?? [])].sort()).toEqual(all);
  });

  it("a stored list with no key left in it is no list", async () => {
    await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true, blockedContacts: ["zzz", "zzz"] });
    const { node } = await watched(row());
    expect(node.getState().settings.blockedContacts).toBeUndefined();
  });
});
