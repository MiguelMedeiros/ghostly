import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, STATUS_FRAME, STATUS_IDLE_AFTER_MS, createIdentity, createLink, identityFromSeedB64, type PairingState, type StatusState } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import type { AttentionEvent } from "../src/shared/rpc";
import type { Settings, StoredLink } from "../src/shared/types";
import { FakeNativeNet, fakeDescriptor } from "./helpers/fakeNative";
// covers: chat.status.wire

/**
 * Presence and a set status in the engine (WISP 401 § Presence and status): this profile's word goes on every 1:1 chat
 * whose contact offers `status/1`, the contact's shows in its chat's view, "Share when I'm online" takes presence out
 * of it, and Do not disturb keeps messages quiet here. A real node and its contact's link over a stand-in for Iroh.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); vi.useRealTimers(); });

type Setup = { statusSupport?: boolean; settings?: Partial<Settings>; before?: (node: GhostlyNode, contact: GhostLink) => void };

async function setup(options: Setup = {}) {
  const net = new FakeNativeNet();
  // Every text frame either side puts on any session.
  const wire: Record<string, unknown>[] = [];
  type End = { send(data: string | Uint8Array): void };
  const pair = (net as unknown as { pair(): End[] }).pair.bind(net);
  (net as unknown as { pair(): End[] }).pair = () => pair().map(end => {
    const send = end.send;
    end.send = data => { if (typeof data === "string") wire.push(JSON.parse(data)); send(data); };
    return end;
  });
  const invitation = createLink();
  const [mine, theirs] = [createIdentity().seedB64, createIdentity().seedB64];
  const id = `status-${crypto.randomUUID()}`;
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true, ...options.settings });
  await db.putLink({ ...invitation.mine, id, profile: "paired-chat/1", participationSeed: mine, createdAt: 1,
    pairedPeerKey: identityFromSeedB64(theirs).pubKeyZ32, peerTrust: { version: 1 },
    peerTransports: ["iroh/1"], peerFallback: true, preferredTransport: "iroh/1", transportFallback: true,
    peerDescriptors: { "iroh/1": fakeDescriptor("iroh/1", "contact") } });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const attention: AttentionEvent[] = [];
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: event => { attention.push(event); } },
    { transport, automaticWallets: false, nativeTransports: { "iroh/1": async () => net.endpoint("iroh/1", "app") } });
  let contactState: PairingState = { status: "connecting" };
  const heard: StatusState[] = [];
  const contact = new GhostLink({
    params: { ...invitation.invite, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: theirs, peerKey: identityFromSeedB64(mine).pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true, peerTransports: ["iroh/1"], peerFallback: true, peerDescriptors: { "iroh/1": fakeDescriptor("iroh/1", "app") } },
    transport, createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    statusSupport: options.statusSupport ?? true,
    events: { onPairingState: state => { contactState = state; }, onPeerStatus: state => { heard.push(state); } },
  });
  contact.registerEndpoint(net.endpoint("iroh/1", "contact"));
  cleanup.push(async () => { await contact.stop(false); await node.shutdown(); await db.deleteLink(id); });
  // Before the engine starts: it dials the contact by itself, and a word said after the session's first waits 5 s.
  options.before?.(node, contact);
  await node.start();
  node.setActiveLink({ linkId: id });
  const view = () => node.getState().links.find(l => l.id === id)!;
  await vi.waitFor(() => expect(view().availableTransports).toHaveLength(1));
  void contact.connect(5_000).catch(() => {});
  await vi.waitFor(() => expect([view().pairing?.status, contactState.status]).toEqual(["ready", "ready"]));
  const statusFrames = () => wire.filter(frame => frame.t === STATUS_FRAME);
  return { node, contact, id, heard, attention, view, statusFrames };
}

describe("this profile's status on the live link", () => {
  it("a kept status goes as the session comes up, with presence, and again when it changes", async () => {
    const t = await setup({ settings: { ownStatus: { availability: "busy", emoji: "🍕", text: "At lunch" } }, before: node => node.setPresence({ presence: "active" }) });
    await vi.waitFor(() => expect(t.contact.peerStatus).toEqual({ presence: "active", status: { availability: "busy", emoji: "🍕", text: "At lunch" } }));
    await t.node.clearOwnStatus();
    // A change inside the send interval goes when it ends (5 s).
    await vi.waitFor(() => expect(t.contact.peerStatus).toEqual({ presence: "active" }), { timeout: 8_000 });
  }, 15_000);

  it("Share when I'm online off: the status goes, presence never does", async () => {
    const t = await setup({ settings: { sharePresence: false, ownStatus: { availability: "away", text: "On holiday" } }, before: node => node.setPresence({ presence: "active" }) });
    await vi.waitFor(() => expect(t.contact.peerStatus).toEqual({ status: { availability: "away", text: "On holiday" } }));
    expect(t.statusFrames().filter(frame => frame.s)).not.toEqual([]);
    expect(t.statusFrames().some(frame => "p" in frame)).toBe(false);
    expect(t.heard.some(state => state.presence)).toBe(false);
  });

  it("a contact whose app does not offer status/1 is sent nothing", async () => {
    const t = await setup({ statusSupport: false, settings: { ownStatus: { availability: "dnd" } }, before: node => node.setPresence({ presence: "active" }) });
    await vi.waitFor(() => expect(t.view().sessionOffers?.peer).not.toBeNull());
    expect(t.view().sessionOffers?.mine).toContain("status/1");
    await t.node.setOwnStatus({ status: { availability: "busy", text: "Later" } });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(t.statusFrames()).toEqual([]);
    expect(t.heard).toEqual([]);
    expect(t.view().peerStatus).toBeUndefined();
  });
});

describe("the contact's status in its chat", () => {
  it("shows its presence while the session is live and its status while it lasts", async () => {
    const t = await setup({ before: (_node, contact) => {
      contact.setStatus({ presence: "idle", status: { availability: "dnd", emoji: "🌴", text: "Off today", until: Date.now() + 3_600_000 } });
    } });
    await vi.waitFor(() => expect(t.view().peerPresence).toBe("idle"));
    expect(t.view().peerStatus).toMatchObject({ availability: "dnd", emoji: "🌴", text: "Off today" });
    // Gone with the session: presence ends, the status stands.
    await t.contact.stop(false);
    await vi.waitFor(() => expect(t.view().peerPresence).toBeUndefined());
    expect(t.view().peerStatus).toMatchObject({ availability: "dnd", text: "Off today" });
  });
});

describe("Do not disturb", () => {
  it("keeps a message quiet while it lasts; the message itself comes as ever", async () => {
    const t = await setup();
    await t.node.setOwnStatus({ status: { availability: "dnd" } });
    expect(await t.contact.sendMessage("are you there?")).toBeNull();
    await vi.waitFor(async () => expect((await db.getMessages(t.id)).some(m => m.text === "are you there?")).toBe(true));
    expect(t.attention.filter(e => e.type === "message")).toEqual([]);
    await t.node.clearOwnStatus();
    expect(await t.contact.sendMessage("hello?")).toBeNull();
    await vi.waitFor(() => expect(t.attention.filter(e => e.type === "message")).toHaveLength(1));
  });
});

/** A connected contact: what the engine calls on it, recorded. */
function stubLink() {
  return { isDataLinkOpen: true, availableTransports: ["iroh/1"], setChatActive: vi.fn(), setTyping: vi.fn(), setStatus: vi.fn(),
    allowsPayment: vi.fn(() => true), paymentEnabled: vi.fn(() => true),
    peerStatus: {}, stop: vi.fn(async () => {}), depart: vi.fn(), wake: vi.fn() };
}
async function addChat(node: GhostlyNode, link: ReturnType<typeof stubLink>, stored: Partial<StoredLink> = {}) {
  const row: StoredLink = { id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64, ...stored };
  await db.putLink(row);
  (node as unknown as { links: Map<string, unknown> }).links.set(row.id, { stored: row, myPubKeyZ32: "me", link, status: "online", dataLink: "open",
    presence: { online: true, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } });
  cleanup.push(async () => { await db.deleteLink(row.id); });
  return row;
}
function engine() {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
  cleanup.push(() => node.shutdown());
  return node;
}

describe("the RPCs", () => {
  it("set and clear: kept in the settings, checked, said to every 1:1 chat and never to a group's", async () => {
    const node = engine();
    const chat = stubLink(), edge = stubLink();
    await addChat(node, chat);
    await addChat(node, edge, { group: "g1" });
    await node.setOwnStatus({ status: { availability: "busy", text: "see https://x.example", emoji: "🍕" } });
    expect(chat.setStatus).toHaveBeenLastCalledWith({ status: { availability: "busy", emoji: "🍕" } });
    expect((await db.getSettings()).ownStatus).toEqual({ availability: "busy", emoji: "🍕" });
    expect(node.getOwnStatus()).toEqual({ sharePresence: true, status: { availability: "busy", emoji: "🍕" } });
    await node.clearOwnStatus();
    expect(chat.setStatus).toHaveBeenLastCalledWith({});
    expect(await db.getSettings()).not.toHaveProperty("ownStatus");
    expect(edge.setStatus).not.toHaveBeenCalled();
    // Not a setting a patch writes.
    await node.updateSettings({ settings: { ownStatus: { availability: "dnd" } } as never });
    expect(node.getOwnStatus().status).toBeUndefined();
  });

  it("presence: active at a page's word, idle 10 minutes after the last; the switch off takes it out at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const node = engine();
    const chat = stubLink();
    await addChat(node, chat);
    node.setPresence({ presence: "active" });
    expect(chat.setStatus).toHaveBeenLastCalledWith({ presence: "active" });
    vi.advanceTimersByTime(STATUS_IDLE_AFTER_MS - 1_000);
    node.setPresence({ presence: "active" });
    vi.advanceTimersByTime(STATUS_IDLE_AFTER_MS - 1_000);
    expect(chat.setStatus).toHaveBeenLastCalledWith({ presence: "active" });
    vi.advanceTimersByTime(1_000);
    expect(chat.setStatus).toHaveBeenLastCalledWith({ presence: "idle" });
    await node.updateSettings({ settings: { sharePresence: false } });
    expect(chat.setStatus).toHaveBeenLastCalledWith({});
    expect((await db.getSettings()).sharePresence).toBe(false);
    expect(node.getOwnStatus()).toEqual({ sharePresence: false, presence: "idle" });
    await node.updateSettings({ settings: { sharePresence: true } });
    expect(chat.setStatus).toHaveBeenLastCalledWith({ presence: "idle" });
    expect(await db.getSettings()).not.toHaveProperty("sharePresence");
  });

  it("presence taken back (null): said at once with no p, and no idle after it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const node = engine();
    const chat = stubLink();
    await addChat(node, chat);
    node.setPresence({ presence: null });
    expect(chat.setStatus).not.toHaveBeenCalled();
    node.setPresence({ presence: "active" });
    expect(chat.setStatus).toHaveBeenLastCalledWith({ presence: "active" });
    node.setPresence({ presence: null });
    expect(chat.setStatus).toHaveBeenLastCalledWith({});
    expect(node.getOwnStatus()).toEqual({ sharePresence: true });
    vi.advanceTimersByTime(STATUS_IDLE_AFTER_MS);
    expect(chat.setStatus).toHaveBeenCalledTimes(2);
  });

  it("daemonPresence (a headless daemon's opt-in): kept only while on, and only as true or false", async () => {
    const node = engine();
    await node.updateSettings({ settings: { daemonPresence: true } });
    expect((await db.getSettings()).daemonPresence).toBe(true);
    await node.updateSettings({ settings: { daemonPresence: false } });
    expect(await db.getSettings()).not.toHaveProperty("daemonPresence");
    await expect(node.updateSettings({ settings: { daemonPresence: "yes" } as never })).rejects.toThrow("daemonPresence is on or off (true or false)");
  });

  it("a status that ends is cleared by itself, and Do not disturb ends with it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const node = engine();
    const chat = stubLink();
    await addChat(node, chat);
    await node.setOwnStatus({ status: { availability: "dnd", until: Date.now() + 60_000 } });
    expect(node["doNotDisturb"]).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(chat.setStatus).toHaveBeenLastCalledWith({});
    expect(node.getOwnStatus().status).toBeUndefined();
    expect(node["doNotDisturb"]).toBe(false);
    // One already past is no status.
    await node.setOwnStatus({ status: { availability: "dnd", until: Date.now() - 1 } });
    expect(node.getOwnStatus().status).toBeUndefined();
  });
});
