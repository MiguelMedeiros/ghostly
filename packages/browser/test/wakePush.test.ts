import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { createIdentity, decryptPushPayload, fromBase64Url, generateVapidKeys, newWakeToken, toBase64Url, utf8Decode, type WakeTarget } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink, WakeSubscription } from "../src/shared/types";

// covers: push.wake.exchange, push.wake.rate-limit, push.wake.send, push.wake.mute

function stubLink(overrides: Record<string, unknown> = {}) {
  const session = { setActive: vi.fn(), pollNow: vi.fn(), setFastPoll: vi.fn() };
  return {
    setChatActive: (active: boolean) => session.setActive(active),
    isDataLinkOpen: true, supportsWake: true, sendWake: vi.fn(() => true), textDelivery: "unavailable", availableTransports: ["webrtc/1"],
    allowsPayment: vi.fn(() => true), paymentEnabled: vi.fn(() => true), setHoldSupport: vi.fn(), refreshServices: vi.fn(async () => {}),
    request: vi.fn(async () => ({ status: 200 })), sendMessage: vi.fn(async () => null), validateText: vi.fn(() => null),
    setNick: vi.fn(), setAvatar: vi.fn(), stop: vi.fn(async () => {}), depart: vi.fn(async () => {}), wake: vi.fn(), setTyping: vi.fn(), session,
    ...overrides,
  };
}
type Stub = ReturnType<typeof stubLink>;

async function addChat(node: GhostlyNode, link: Stub | null, stored: Partial<StoredLink> = {}) {
  const row: StoredLink = { id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64, ...stored };
  await db.putLink(row);
  node["links"].set(row.id, { stored: row, myPubKeyZ32: "me", link: link as never, status: "online", dataLink: link?.isDataLinkOpen ? "open" : "closed",
    presence: { online: true, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } } as never);
  return row;
}
const saved = async (id: string) => (await db.getLinks()).find((l) => l.id === id);

const nodes: GhostlyNode[] = [];
function engine(options: ConstructorParameters<typeof GhostlyNode>[1] = {}) {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() } as never, { automaticWallets: false, ...options });
  nodes.push(node);
  return node;
}

/** A browser's push subscription, with the private halves a push service stand-in needs to read what arrives. */
function browserSubscription(): { subscription: WakeSubscription; secret: Uint8Array; auth: Uint8Array } {
  const secret = p256.utils.randomSecretKey();
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: toBase64Url(p256.getPublicKey(secret, false)), auth: toBase64Url(auth), vapid: generateVapidKeys() },
    secret, auth,
  };
}
function contactTarget() {
  const { subscription, secret, auth } = browserSubscription();
  const target: WakeTarget = { ...subscription, endpoint: "https://web.push.apple.com/QAB", token: newWakeToken() };
  return { target, secret, auth };
}

beforeEach(async () => {
  await transact([STORES.settings, STORES.links, STORES.messages, STORES.services], (s) => { for (const name of [STORES.settings, STORES.links, STORES.messages, STORES.services]) s[name].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("sharing this profile's subscription", () => {
  it("each paired chat gets its own token and the subscription; a group edge never does", async () => {
    const node = engine();
    const a = stubLink(), b = stubLink(), edge = stubLink();
    const chatA = await addChat(node, a), chatB = await addChat(node, b);
    await addChat(node, edge, { group: { id: "g", role: "member" } as never });
    const { subscription } = browserSubscription();
    await node.setWakeSubscription({ subscription });
    await vi.waitFor(() => expect(b.sendWake).toHaveBeenCalled());
    const [sentA] = a.sendWake.mock.calls[0]! as unknown as [WakeTarget];
    const [sentB] = b.sendWake.mock.calls[0]! as unknown as [WakeTarget];
    expect(sentA).toMatchObject({ endpoint: subscription.endpoint, vapid: subscription.vapid });
    expect(sentA.token).not.toBe(sentB.token);
    expect(edge.sendWake).not.toHaveBeenCalled();
    expect((await saved(chatA.id))?.wakeToken).toBe(sentA.token);
    expect(node.getState().links.find((l) => l.id === chatB.id)?.wakeToken).toBe(sentB.token);
    expect((await db.getSettings()).wake).toEqual(subscription);
  });

  it("a new subscription is a new token everywhere; stopping tells every live contact to forget it", async () => {
    const node = engine();
    const a = stubLink();
    const chat = await addChat(node, a);
    await node.setWakeSubscription({ subscription: browserSubscription().subscription });
    await vi.waitFor(() => expect(a.sendWake).toHaveBeenCalledTimes(1));
    const first = (await saved(chat.id))?.wakeToken;
    await node.setWakeSubscription({ subscription: browserSubscription().subscription });
    await vi.waitFor(() => expect(a.sendWake).toHaveBeenCalledTimes(2));
    expect((await saved(chat.id))?.wakeToken).not.toBe(first);
    await node.setWakeSubscription({ subscription: null });
    expect(a.sendWake).toHaveBeenLastCalledWith(null);
    await vi.waitFor(async () => expect((await saved(chat.id))?.wakeToken).toBeUndefined());
    expect(node.getState().links[0]?.wakeToken).toBeUndefined();
    expect(await db.getSettings()).not.toHaveProperty("wake");
  });

  it("a muted chat's contact is told to forget it (on every session while muted); unmuted, it gets a new token", async () => {
    const node = engine();
    const a = stubLink();
    const chat = await addChat(node, a);
    await node.setWakeSubscription({ subscription: browserSubscription().subscription });
    await vi.waitFor(() => expect(a.sendWake).toHaveBeenCalledTimes(1));
    const before = (await saved(chat.id))?.wakeToken;
    await node.setWakeMuted({ linkId: chat.id, muted: true });
    expect(a.sendWake).toHaveBeenLastCalledWith(null);
    expect((await saved(chat.id))).toMatchObject({ wakeMuted: true });
    expect((await saved(chat.id))?.wakeToken).toBeUndefined();
    expect(node.getState().links[0]).toMatchObject({ wakeMuted: true });
    // A new session while muted: told again, never shared.
    await node["shareWake"](chat.id);
    expect(a.sendWake).toHaveBeenLastCalledWith(null);
    await node.setWakeMuted({ linkId: chat.id, muted: false });
    const [target] = a.sendWake.mock.lastCall! as unknown as [WakeTarget];
    expect(target.token).toBeTruthy();
    expect(target.token).not.toBe(before);
    expect((await saved(chat.id))?.wakeMuted).toBeUndefined();
  });

  it("refuses what is not a subscription, changing nothing", async () => {
    const node = engine();
    const { subscription } = browserSubscription();
    await expect(node.setWakeSubscription({ subscription: { ...subscription, endpoint: "http://fcm.googleapis.com/x" } })).rejects.toThrow();
    await expect(node.setWakeSubscription({ subscription: { ...subscription, endpoint: "https://192.168.1.2/push" } })).rejects.toThrow();
    await expect(node.setWakeSubscription({ subscription: { ...subscription, vapid: { ...subscription.vapid, privateKey: generateVapidKeys().privateKey } } })).rejects.toThrow("pair");
    await expect(node.setWakeSubscription({ subscription: { ...subscription, auth: "x" } })).rejects.toThrow();
    expect(await db.getSettings()).not.toHaveProperty("wake");
  });

  it("the settings patch cannot set it; the push relay is checked and kept only when set", async () => {
    const node = engine();
    await node.updateSettings({ settings: { wake: browserSubscription().subscription } as never });
    expect(node["settings"].wake).toBeUndefined();
    await expect(node.updateSettings({ settings: { pushRelay: "http://relay.example" } })).rejects.toThrow("https");
    await node.updateSettings({ settings: { pushRelay: " https://push-relay.example/ " } });
    expect((await db.getSettings()).pushRelay).toBe("https://push-relay.example/");
    await node.updateSettings({ settings: { pushRelay: "" } });
    expect(await db.getSettings()).not.toHaveProperty("pushRelay");
  });
});

describe("waking a contact whose app is closed", () => {
  it("a message while it is away posts one encrypted wake-up with its token; a burst is one push", async () => {
    const pushSend = vi.fn(async () => 201);
    const node = engine({ pushSend });
    const { target, secret, auth } = contactTarget();
    const chat = await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: target });
    await node.sendMessage({ linkId: chat.id, text: "are you there?" });
    await node.sendMessage({ linkId: chat.id, text: "hello?" });
    expect(pushSend).toHaveBeenCalledTimes(1);
    const [request] = pushSend.mock.calls[0]! as unknown as [{ url: string; headers: Record<string, string>; body: Uint8Array }];
    expect(request.url).toBe(target.endpoint);
    expect(request.headers.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(JSON.parse(utf8Decode(decryptPushPayload(request.body, secret, auth)))).toEqual({ wake: 1, k: target.token });
    // Nothing of the message is in it.
    expect(utf8Decode(decryptPushPayload(request.body, secret, auth))).not.toContain("there");
  });

  it("never while the chat is live, nor to a contact that shared nothing, nor while this app is offline", async () => {
    const pushSend = vi.fn(async () => 201);
    const node = engine({ pushSend });
    const live = await addChat(node, stubLink({ isDataLinkOpen: true, validateText: () => "stop", textDelivery: "stream" }), { peerWake: contactTarget().target });
    const silent = await addChat(node, stubLink({ isDataLinkOpen: false }));
    await node.sendMessage({ linkId: live.id, text: "hi" }).catch(() => {});
    await node.sendMessage({ linkId: silent.id, text: "hi" });
    node["settings"] = { ...node["settings"], online: false };
    const away = await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: contactTarget().target });
    node["wakePeer"](node["links"].get(away.id));
    expect(pushSend).not.toHaveBeenCalled();
  });

  it("a subscription the push service says is gone (410) is forgotten", async () => {
    const node = engine({ pushSend: vi.fn(async () => 410) });
    const chat = await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: contactTarget().target });
    await node.sendMessage({ linkId: chat.id, text: "hi" });
    await vi.waitFor(async () => expect((await saved(chat.id))?.peerWake).toBeUndefined());
    expect(node.getState().links.find((l) => l.id === chat.id)?.peerWakes).toBe(false);
  });

  it("a page the push service refuses (CORS) hands it to the push relay, when one is set", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body });
      if (url.startsWith("https://web.push.apple.com")) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ status: 201 }), { status: 200 });
    }));
    const node = engine();
    const { target, secret, auth } = contactTarget();
    const chat = await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: target });
    await node.sendMessage({ linkId: chat.id, text: "hi" });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // No relay: it stops there, and the message still waits.
    node["wakeLimiter"].reset(chat.id);
    await node.updateSettings({ settings: { pushRelay: "https://push-relay.example/" } });
    await node.sendMessage({ linkId: chat.id, text: "again" });
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]!.url).toBe("https://push-relay.example/");
    const relayed = JSON.parse(calls[2]!.body as string) as { endpoint: string; headers: Record<string, string>; body: string };
    expect(relayed.endpoint).toBe(target.endpoint);
    expect(relayed.headers.Authorization).toMatch(/^vapid /);
    expect(JSON.parse(utf8Decode(decryptPushPayload(fromBase64Url(relayed.body), secret, auth))).k).toBe(target.token);
  });

  it("a call to a closed app: one call wake-up, limited apart from messages; none while live or without a target", async () => {
    const pushSend = vi.fn(async () => 201);
    const node = engine({ pushSend });
    const { target, secret, auth } = contactTarget();
    const away = await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: target });
    await node.sendMessage({ linkId: away.id, text: "hi" });
    expect(pushSend).toHaveBeenCalledTimes(1);
    // A message wake-up just went: a call still wakes it.
    await expect(node.wakeForCall({ linkId: away.id })).resolves.toBe(true);
    expect(pushSend).toHaveBeenCalledTimes(2);
    const [call] = pushSend.mock.calls[1]! as unknown as [{ headers: Record<string, string>; body: Uint8Array }];
    expect(JSON.parse(utf8Decode(decryptPushPayload(call.body, secret, auth)))).toEqual({ wake: 1, k: target.token, c: 1 });
    expect(call.headers.TTL).toBe("60");
    // Pressed again at once: it still waits (true), but no second push.
    await expect(node.wakeForCall({ linkId: away.id })).resolves.toBe(true);
    expect(pushSend).toHaveBeenCalledTimes(2);
    const live = await addChat(node, stubLink({ isDataLinkOpen: true }), { peerWake: contactTarget().target });
    const silent = await addChat(node, stubLink({ isDataLinkOpen: false }));
    await expect(node.wakeForCall({ linkId: live.id })).resolves.toBe(false);
    await expect(node.wakeForCall({ linkId: silent.id })).resolves.toBe(false);
    expect(pushSend).toHaveBeenCalledTimes(2);
  });

  it("deleting the chat forgets the contact's subscription with it", async () => {
    const node = engine({ pushSend: vi.fn(async () => 201) });
    const chat = await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: contactTarget().target });
    node.removeLink({ linkId: chat.id });
    await vi.waitFor(async () => expect(await saved(chat.id)).toBeUndefined());
  });
});
