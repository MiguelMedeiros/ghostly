import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, type GhostLinkOptions } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
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
  const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() };
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
    // A file offer is declined as a deleted one is (`FileDesk.weigh`), and one under way is not kept.
    expect(node["fileDesk"]["deps"].deleted(chat.id, "peer_f1")).toBe(true);
    Object.assign(linkOf(chat.id), { peerTyping: true, peerTypingActivity: null, peerStatus: { status: { text: "busy" } } });
    peer.onPeerTyping(true);
    expect(viewOf(node, chat.id)).not.toHaveProperty("peerTyping");
    expect(viewOf(node, chat.id)).not.toHaveProperty("peerStatus");
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
