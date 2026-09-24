import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostlyHttpError, createIdentity } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink } from "../src/shared/types";
// covers: settings.nickname, settings.network.relays, settings.network.turn, app.offline-switch, delivery.hold.enable, transport.preference, payments.chat.methods, chats.list.rename, chats.list.delete, chat.paired.delete-message, services.share, services.stop

/** A connected contact: what the engine calls on it, recorded. */
function stubLink(overrides: Record<string, unknown> = {}) {
  return {
    isDataLinkOpen: true, availableTransports: ["webrtc/1", "iroh/1"],
    allowsPayment: vi.fn(() => true), paymentEnabled: vi.fn(() => true),
    setDeliveryMode: vi.fn(async () => {}), setTransportPreference: vi.fn(async () => {}), setPaymentMethods: vi.fn(),
    setHoldSupport: vi.fn(), setNick: vi.fn(), setAvatar: vi.fn(), refreshServices: vi.fn(async () => {}),
    stop: vi.fn(async () => {}), wake: vi.fn(), session: { setActive: vi.fn(), pollNow: vi.fn(), setFastPoll: vi.fn() },
    request: vi.fn(async () => ({ status: 200 })), sendMessage: vi.fn(async () => null),
    ...overrides,
  };
}
type Stub = ReturnType<typeof stubLink>;

async function addChat(node: GhostlyNode, link: Stub | null, stored: Partial<StoredLink> = {}) {
  const row: StoredLink = { id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64, ...stored };
  await db.putLink(row);
  node["links"].set(row.id, { stored: row, myPubKeyZ32: "me", link: link as never, status: "online", dataLink: "open",
    presence: { online: true, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } });
  return row;
}
const saved = async (id: string) => (await db.getLinks()).find((l) => l.id === id);

const nodes: GhostlyNode[] = [];
function engine(options: ConstructorParameters<typeof GhostlyNode>[1] = {}) {
  const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() };
  const node = new GhostlyNode(events, { automaticWallets: false, ...options });
  nodes.push(node);
  return { node, events };
}
const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };

beforeEach(async () => {
  await transact([STORES.settings, STORES.links, STORES.messages, STORES.services], (s) => { for (const name of [STORES.settings, STORES.links, STORES.messages, STORES.services]) s[name].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("settings", () => {
  it("refuses a TURN server a browser would reject and a relay list with no relay, changing nothing", async () => {
    const { node } = engine();
    const before = structuredClone(node["settings"]);
    await expect(node.updateSettings({ settings: { nick: "changed", iceServers: [{ urls: "turn:turn.example" }] } })).rejects.toThrow();
    await expect(node.updateSettings({ settings: { nick: "changed", relays: ["not a relay", "ftp://x"] } })).rejects.toThrow("at least one relay");
    expect(node["settings"]).toEqual(before);
    expect(await db.getSettings()).toEqual({});
  });

  it("keeps only valid relays, and saves what changed", async () => {
    const { node } = engine();
    await node.updateSettings({ settings: { relays: ["https://relay.example/", "not a relay"] } });
    expect(node["settings"].relays).toEqual(node.getState().transport.relays);
    expect(node["settings"].relays).not.toContain("not a relay");
    expect((await db.getSettings()).relays).toEqual(node["settings"].relays);
  });

  it("where relays are not the transport, a relay list is not checked", async () => {
    const { node } = engine({ transport: fixture });
    await node.updateSettings({ settings: { relays: ["anything"] } });
    expect(node["settings"].relays).toEqual(["anything"]);
  });

  it("stores the Nostr settings in their one shape: only an explicit yes turns a switch on", async () => {
    const { node } = engine();
    await node.updateSettings({ settings: { nostr: { relays: ["wss://relay.example"], autoLoadProfiles: "yes" as never, publish: true } } });
    expect((await db.getSettings()).nostr).toMatchObject({ autoLoadProfiles: false, publish: true });
  });

  it("tells every open chat a new nick, and an empty one as none", async () => {
    const { node } = engine();
    const link = stubLink();
    await addChat(node, link);
    await node.updateSettings({ settings: { nick: "Ghost" } });
    await node.updateSettings({ settings: { nick: "" } });
    expect(link.setNick.mock.calls).toEqual([["Ghost"], [undefined]]);
  });

  it("a profile that stops sharing its name and picture tells every chat there is none, and sharing again restores both", async () => {
    const { node } = engine();
    const link = stubLink();
    await addChat(node, link);
    const avatar = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/wAARCABAAEADASIAAhEBAxEB/9oACAEBAAA/ANk=";
    await node.updateSettings({ settings: { nick: "Ghost" } });
    link.setNick.mockClear();
    await node.updateSettings({ settings: { shareProfile: false } });
    expect(link.setNick).toHaveBeenLastCalledWith(undefined);
    expect(link.setAvatar).toHaveBeenLastCalledWith(undefined);
    expect((await db.getSettings()).shareProfile).toBe(false);
    // While off, a new name or picture stays here.
    link.setNick.mockClear(); link.setAvatar.mockClear();
    await node.updateSettings({ settings: { nick: "Ghost 2" } });
    await node.updateSettings({ settings: { avatar } }).catch(() => {});
    expect(link.setNick.mock.calls.flat().filter(Boolean)).toEqual([]);
    expect(link.setAvatar.mock.calls.flat().filter(Boolean)).toEqual([]);
    await node.updateSettings({ settings: { shareProfile: true } });
    expect(link.setNick).toHaveBeenLastCalledWith("Ghost 2");
    // On is the default: it is not stored.
    expect(await db.getSettings()).not.toHaveProperty("shareProfile");
  });

  it("removing the held-message storage removes it from the saved settings", async () => {
    const { node } = engine();
    const changed = vi.spyOn(node["hold"], "storageChanged");
    await node.updateSettings({ settings: { holdStorage: { space: "a".repeat(16) } as never } });
    await node.updateSettings({ settings: { holdStorage: undefined as never } });
    await node.updateSettings({ settings: { holdStorage: null as never } });
    expect(await db.getSettings()).not.toHaveProperty("holdStorage");
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("going offline stops every chat; going online again starts the background work", async () => {
    const { node } = engine({ transport: fixture });
    const link = stubLink();
    const chat = await addChat(node, link);
    const holdStop = vi.spyOn(node["hold"], "stop"), holdStart = vi.spyOn(node["hold"], "start").mockImplementation(() => {});
    await node.updateSettings({ settings: { online: false } });
    expect(link.stop).toHaveBeenCalledWith(true);
    expect(node.getState().links.find((l) => l.id === chat.id)).toMatchObject({ status: "offline", dataLink: "idle" });
    expect(holdStop).toHaveBeenCalledOnce();
    node["links"].delete(chat.id);
    await node.updateSettings({ settings: { online: true } });
    expect(holdStart).toHaveBeenCalledOnce();
    expect(node["groupEntryTimer"]).not.toBeNull();
  });
});

describe("one chat's choices", () => {
  it("a delivery method is only set on a connected paired chat, and only to one that exists", async () => {
    const { node } = engine();
    const link = stubLink();
    const chat = await addChat(node, link), legacy = await addChat(node, stubLink(), { profile: undefined }), away = await addChat(node, null);
    for (const [linkId, mode] of [[chat.id, "carrier-pigeon"], [legacy.id, "dht"], [away.id, "dht"], ["missing", "dht"]] as const)
      await expect(node.setDeliveryMode({ linkId, mode: mode as never })).rejects.toThrow("Delivery method unavailable");
    await node.setDeliveryMode({ linkId: chat.id, mode: "dht" });
    await node.setDeliveryMode({ linkId: chat.id, mode: "stream" });
    expect(link.setDeliveryMode.mock.calls).toEqual([["dht"], ["stream"]]);
    expect((await saved(chat.id))?.deliveryMode).toBe("stream");
  });

  it("a transport is preferred only when the chat has it, and the choice is saved", async () => {
    const { node } = engine();
    const link = stubLink();
    const chat = await addChat(node, link);
    await expect(node.setTransportPreference({ linkId: chat.id, preferred: "hyperdht/1", fallback: true })).rejects.toThrow("Transport unavailable");
    await expect(node.setTransportPreference({ linkId: chat.id, preferred: "iroh/1", fallback: "no" as never })).rejects.toThrow("Transport unavailable");
    await node.setTransportPreference({ linkId: chat.id, preferred: "iroh/1", fallback: false });
    expect(link.setTransportPreference).toHaveBeenCalledWith("iroh/1", false);
    expect(await saved(chat.id)).toMatchObject({ preferredTransport: "iroh/1", transportFallback: false });
  });

  it("ways of paying: only known methods and yes/no, merged, saved and told to the contact", async () => {
    const { node } = engine();
    const link = stubLink();
    const chat = await addChat(node, link);
    await expect(node.setChatPaymentMethods({ linkId: chat.id, methods: { dogecoin: true } as never })).rejects.toThrow();
    await expect(node.setChatPaymentMethods({ linkId: chat.id, methods: { cashu: "off" } as never })).rejects.toThrow();
    await expect(node.setChatPaymentMethods({ linkId: "missing", methods: { cashu: false } })).rejects.toThrow();
    await node.setChatPaymentMethods({ linkId: chat.id, methods: { cashu: false } });
    await node.setChatPaymentMethods({ linkId: chat.id, methods: { bark: false } });
    expect(link.setPaymentMethods).toHaveBeenLastCalledWith({ cashu: false, bark: false });
    expect((await saved(chat.id))?.paymentMethods).toEqual({ cashu: false, bark: false });
    expect(node.getState().links.find((l) => l.id === chat.id)?.paymentMethods).toMatchObject({ cashu: false, bark: false, lightning: true });
  });

  it("a method switched off in a chat refuses a payment there", async () => {
    const { node } = engine();
    const methods: Record<string, boolean> = {};
    const link = stubLink({ requirePaymentSupport: vi.fn(async () => {}), allowsPayment: vi.fn((m: string) => methods[m] !== false),
      setPaymentMethods: vi.fn((m: Record<string, boolean>) => Object.assign(methods, m)) });
    const chat = await addChat(node, link);
    await node.setChatPaymentMethods({ linkId: chat.id, methods: { cashu: false } });
    await expect(node.sendPayment({ linkId: chat.id, amount: 5, timestamp: 1 })).rejects.toThrow("Cashu is off in this chat");
  });

  it("held messages are a choice of paired chats only", async () => {
    const { node } = engine();
    const link = stubLink();
    const chat = await addChat(node, link), legacy = await addChat(node, stubLink(), { profile: undefined });
    await expect(node.setChatHold({ linkId: legacy.id, enabled: true })).rejects.toThrow("paired chat");
    await expect(node.setChatHold({ linkId: chat.id, enabled: "yes" as never })).rejects.toThrow("paired chat");
    const wake = vi.spyOn(node["hold"], "wake").mockImplementation(() => {});
    await node.setChatHold({ linkId: chat.id, enabled: true });
    expect(link.setHoldSupport).toHaveBeenCalledWith(true, 0);
    expect((await saved(chat.id))?.hold).toMatchObject({ enabled: true });
    expect(wake).toHaveBeenCalledWith(chat.id);
  });
});

describe("links", () => {
  it("renames with a trimmed, bounded label, and an empty one clears it", async () => {
    const { node } = engine();
    const chat = await addChat(node, stubLink());
    node.renameLink({ linkId: chat.id, label: `  ${"x".repeat(60)}  ` });
    expect(node.getState().links[0].label).toBe("x".repeat(48));
    node.renameLink({ linkId: chat.id, label: "   " });
    node.renameLink({ linkId: "missing", label: "ignored" });
    expect(node.getState().links[0].label).toBeUndefined();
    await vi.waitFor(async () => expect((await saved(chat.id))?.label).toBeUndefined());
  });

  it("removing a chat stops it and forgets its history; ecash still reclaimable stays", async () => {
    const { node } = engine();
    const link = stubLink();
    const chat = await addChat(node, link);
    await db.addMessage({ linkId: chat.id, id: "m1", text: "hello", sender: "peer", timestamp: 1, via: "datalink" });
    node["desk"]["payments"].set("reclaimable", { id: "reclaimable", linkId: chat.id, kind: "payment", direction: "out", amount: 5, unit: "sat", state: "pending", createdAt: 1, token: "t" });
    node["desk"]["payments"].set("done", { id: "done", linkId: chat.id, kind: "payment", direction: "out", amount: 5, unit: "sat", state: "settled", createdAt: 1 });
    node.removeLink({ linkId: chat.id });
    node.removeLink({ linkId: chat.id });
    expect(link.stop).toHaveBeenCalledOnce();
    expect(node.getState().links).toEqual([]);
    await vi.waitFor(async () => expect(await saved(chat.id)).toBeUndefined());
    await vi.waitFor(async () => expect(await db.getMessages(chat.id)).toEqual([]));
    await vi.waitFor(() => expect(Object.keys(node.getState().payments)).toEqual(["reclaimable"]));
  });

  it("opening a chat makes it the active one and reconnects it now", async () => {
    const { node } = engine();
    const a = stubLink(), b = stubLink();
    const chatA = await addChat(node, a, { deliveryMode: "dht" });
    await addChat(node, b);
    const wake = vi.spyOn(node["hold"], "wake").mockImplementation(() => {});
    node.setActiveLink({ linkId: chatA.id });
    expect(a.session.setActive).toHaveBeenCalledWith(true);
    expect(b.session.setActive).toHaveBeenCalledWith(false);
    expect(a.wake).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledWith(chatA.id);
    node.setActiveLink({ linkId: null });
    expect(a.session.setActive).toHaveBeenLastCalledWith(false);
    node.wake();
    expect(b.wake).toHaveBeenCalledOnce();
  });

  it("exports the chats a person has, not the edges of a group nor any participation secret", async () => {
    const { node } = engine();
    const chat = await addChat(node, null, { label: "Alice" });
    await addChat(node, null, { group: "g", groupPeer: "p" });
    const exported = node.exportLinks();
    expect(exported).toEqual([{ profile: "paired-chat/1", deliveryMode: undefined, seedB64: chat.seedB64, peerPubKeyZ32: chat.peerPubKeyZ32,
      encKeyB64: chat.encKeyB64, createdAt: 1, inviteCode: undefined, label: "Alice" }]);
    expect(JSON.stringify(exported)).not.toContain(chat.participationSeed);
  });

  it("an invite is joined once; a different profile under the same seed is refused, and garbage is not an invite", async () => {
    const { node } = engine({ transport: fixture });
    node["settings"] = { ...node["settings"], online: false };
    const { inviteCode } = await node.createLink();
    const { linkId } = await node.joinLink({ inviteCode });
    expect(await node.joinLink({ inviteCode })).toEqual({ linkId });
    expect(node.getState().links).toHaveLength(2);
    await expect(node.joinLink({ inviteCode: "hello" })).rejects.toThrow("does not look like a Ghostly invite");
    const existing = node["links"].get(linkId)!;
    existing.stored = { ...existing.stored, profile: undefined };
    await expect(node.joinLink({ inviteCode })).rejects.toThrow("profile does not match");
    expect(await saved(linkId)).toMatchObject({ profile: "paired-chat/1" });
    expect(node.getState().links).toHaveLength(2);
  });
});

describe("messages", () => {
  it("a deleted message stays deleted when the contact sends it again", async () => {
    const { node, events } = engine();
    const chat = await addChat(node, stubLink());
    const message = { linkId: chat.id, id: "peer_1", text: "hi", sender: "peer" as const, timestamp: 1, via: "datalink" as const };
    await node["storeMessage"](message);
    node.deleteMessage({ linkId: chat.id, messageId: "peer_1" });
    await vi.waitFor(async () => expect(await db.getMessages(chat.id)).toEqual([]));
    await node["storeMessage"](message);
    expect(await db.getMessages(chat.id)).toEqual([]);
    expect((await saved(chat.id))?.deletedIds).toEqual(["peer_1"]);
    expect(events.onMessages).toHaveBeenLastCalledWith(chat.id, []);
  });

  it("a retry is for paired chats; a held message needs somewhere to be held", async () => {
    const { node } = engine();
    const legacy = await addChat(node, stubLink(), { profile: undefined }), chat = await addChat(node, stubLink({ isDataLinkOpen: false }));
    await expect(node.retryMessage({ linkId: legacy.id, messageId: "x" })).rejects.toThrow("only available for paired chat");
    await db.addMessage({ linkId: chat.id, id: "me_1", text: "later", sender: "me", timestamp: 1, via: "hold", delivery: "failed" });
    await expect(node.retryMessage({ linkId: chat.id, messageId: "me_1" })).rejects.toThrow("need S3 storage");
    vi.spyOn(node["hold"], "retry").mockResolvedValue(true);
    await expect(node.retryMessage({ linkId: chat.id, messageId: "me_1" })).resolves.toBeUndefined();
  });

  it("a failed message is sent again over the open chat", async () => {
    const { node } = engine();
    const link = stubLink();
    const chat = await addChat(node, link);
    await db.addMessage({ linkId: chat.id, id: "me_w1", wireId: "w1", text: "again", sender: "me", timestamp: 1, via: "datalink", delivery: "failed" });
    await node.retryMessage({ linkId: chat.id, messageId: "me_w1" });
    expect(link.sendMessage).toHaveBeenCalledWith("again", 1, "w1");
  });

  it("nothing is sent while offline, and an empty text is not a message", async () => {
    const { node } = engine();
    const away = await addChat(node, null), chat = await addChat(node, stubLink({ canSendText: false }));
    expect(await node.sendMessage({ linkId: away.id, text: "hi" })).toEqual({ error: "You are offline" });
    expect((await node.sendMessage({ linkId: chat.id, text: "hi" })).error).toContain("compatible delivery methods");
    const open = await addChat(node, stubLink({ canSendText: true }));
    expect(await node.sendMessage({ linkId: open.id, text: "   " })).toEqual({ error: null });
    expect(await db.getMessages(open.id)).toEqual([]);
  });
});

describe("shared services", () => {
  it("adds a named service with a normalized target and a unique id, and refuses a nameless or unreachable one", async () => {
    const { node } = engine();
    const link = stubLink();
    await addChat(node, link);
    expect(() => node.addService({ name: "   ", target: "localhost:3000" })).toThrow("Give the service a name");
    expect(() => node.addService({ name: "App", target: "https://example.com" })).toThrow();
    const first = node.addService({ name: "App", target: "localhost:3000" });
    const second = node.addService({ name: "App", target: "127.0.0.1:4000" });
    expect(first.serviceId).not.toBe(second.serviceId);
    expect(link.refreshServices).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => expect((await db.getServices()).map((s) => s.id).sort()).toEqual([first.serviceId, second.serviceId].sort()));
    node.removeService({ serviceId: first.serviceId });
    expect(node.getState().services.map((s) => s.id)).toEqual([second.serviceId]);
  });

  it("a contact is served only a running service it was granted", async () => {
    const { node } = engine();
    const { serviceId } = node.addService({ name: "App", target: "localhost:3000" });
    const alice = createIdentity().pubKeyZ32, bob = createIdentity().pubKeyZ32;
    expect(node["hostedService"](serviceId, alice), "nobody by default").toBeUndefined();
    node.setServiceShared({ serviceId, peerPubKeyZ32: alice, shared: true });
    expect(node["hostedService"](serviceId, alice)).toMatchObject({ id: serviceId });
    expect(node["hostedService"](serviceId, bob)).toBeUndefined();
    expect(node["advertisedServices"](bob).map((s) => s.id)).not.toContain(serviceId);
    node.setServiceEnabled({ serviceId, enabled: false });
    expect(node["hostedService"](serviceId, alice)).toBeUndefined();
    node.setServiceEnabled({ serviceId, enabled: true });
    node.setServiceShared({ serviceId, peerPubKeyZ32: alice, shared: false });
    expect(node["hostedService"](serviceId, alice)).toBeUndefined();
    expect(node.getState().services[0]).toMatchObject({ requests: 1, sharedWith: [] });
  });

  it("sharing twice or switching to the same state writes nothing", async () => {
    const { node } = engine();
    const { serviceId } = node.addService({ name: "App", target: "localhost:3000" });
    const put = vi.spyOn(db, "putService");
    node.setServiceShared({ serviceId, peerPubKeyZ32: "k", shared: true });
    node.setServiceShared({ serviceId, peerPubKeyZ32: "k", shared: true });
    node.setServiceShared({ serviceId: "missing", peerPubKeyZ32: "k", shared: true });
    node.setServiceEnabled({ serviceId, enabled: true });
    node.setServiceEnabled({ serviceId: "missing", enabled: false });
    expect(put).toHaveBeenCalledOnce();
  });

  it("a request to a peer goes only through a link to that peer", async () => {
    const { node } = engine();
    const link = stubLink();
    const chat = await addChat(node, link), away = await addChat(node, null);
    await expect(node.request("nobody", "app", { method: "GET", path: "/" } as never)).rejects.toMatchObject({ code: "unknown-peer" });
    await expect(node.request(away.peerPubKeyZ32, "app", { method: "GET", path: "/" } as never)).rejects.toBeInstanceOf(GhostlyHttpError);
    await node.request(chat.peerPubKeyZ32, "app", { method: "GET", path: "/" } as never);
    expect(link.request).toHaveBeenCalledWith("app", { method: "GET", path: "/" });
  });
});

describe("identity proofs in a chat", () => {
  it("are refused in this release, whatever is submitted", async () => {
    const { node } = engine();
    const chat = await addChat(node, stubLink());
    await expect(node.submitPeerProof({ linkId: chat.id, challenge: { adapter: "nostr" } as never, event: {} as never })).rejects.toThrow("unavailable in this release");
    await expect(node.preparePeerProof({ linkId: chat.id, externalKey: "a".repeat(64) })).rejects.toThrow("unavailable in this release");
  });
});
