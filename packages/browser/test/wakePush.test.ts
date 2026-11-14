import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { createIdentity, decryptPushPayload, fromBase64Url, generateVapidKeys, newWakeToken, toBase64Url, utf8Decode, WAKE_RETRY_MS, type WakeTarget } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink, WakeSubscription } from "../src/shared/types";
import { hostOf } from "./helpers/urlHost";

// covers: push.wake.exchange, push.wake.rate-limit, push.wake.send, push.wake.mute, push.wake.group, push.wake.online

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

  it("a deleted or muted chat's contact still holds the subscription: the app is asked to replace it", async () => {
    const node = engine();
    const a = stubLink(), b = stubLink(), c = stubLink();
    const chatA = await addChat(node, a), chatB = await addChat(node, b);
    const never = await addChat(node, c, { profile: undefined });
    await node.setWakeSubscription({ subscription: browserSubscription().subscription });
    await vi.waitFor(() => expect(b.sendWake).toHaveBeenCalledTimes(1));
    expect(node.getState().settings.wakeRotate).toBeUndefined();
    // A chat that never got it changes nothing.
    node.removeLink({ linkId: never.id });
    await vi.waitFor(async () => expect(await saved(never.id)).toBeUndefined());
    expect((await db.getSettings()).wakeRotate).toBeUndefined();
    node.removeLink({ linkId: chatA.id });
    await vi.waitFor(async () => expect((await db.getSettings()).wakeRotate).toBe(true));
    expect(node.getState().settings.wakeRotate).toBe(true);
    // The new subscription clears it, and the contact left gets a new token.
    const before = (await saved(chatB.id))?.wakeToken;
    await node.setWakeSubscription({ subscription: browserSubscription().subscription });
    expect((await db.getSettings()).wakeRotate).toBeUndefined();
    await vi.waitFor(async () => expect((await saved(chatB.id))?.wakeToken).toBeTruthy());
    expect((await saved(chatB.id))?.wakeToken).not.toBe(before);
    await node.setWakeMuted({ linkId: chatB.id, muted: true });
    expect((await db.getSettings()).wakeRotate).toBe(true);
    // Only the engine sets it.
    await node.setWakeSubscription({ subscription: null });
    await node.updateSettings({ settings: { wakeRotate: true } as never });
    expect(node["settings"].wakeRotate).toBeUndefined();
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
      if (hostOf(url) === "web.push.apple.com") throw new TypeError("Failed to fetch");
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

  it("a push relay address that answers 404 or 410 itself keeps the contact's subscription; the relay's own 410 forgets it", async () => {
    let relay = () => new Response("<html>Not Found</html>", { status: 404 });
    const relayed = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (hostOf(url) === "web.push.apple.com") throw new TypeError("Failed to fetch");
      relayed();
      return relay();
    }));
    const node = engine();
    await node.updateSettings({ settings: { pushRelay: "https://push-relay.example/" } });
    const chat = await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: contactTarget().target });
    for (const answer of [() => new Response("<html>Not Found</html>", { status: 404 }), () => new Response("Gone", { status: 410 })]) {
      relay = answer;
      const before = relayed.mock.calls.length;
      node["wakeLimiter"].reset(chat.id);
      await node.sendMessage({ linkId: chat.id, text: "hi" });
      await vi.waitFor(() => expect(relayed.mock.calls.length).toBe(before + 1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await saved(chat.id))?.peerWake).toBeDefined();
    }
    relay = () => new Response(JSON.stringify({ status: 410 }), { status: 200 });
    node["wakeLimiter"].reset(chat.id);
    await node.sendMessage({ linkId: chat.id, text: "hi" });
    await vi.waitFor(async () => expect((await saved(chat.id))?.peerWake).toBeUndefined());
  });

  it("a wake-up that did not reach the push service does not hold the next message's back past a short pause", async () => {
    const failures: [string, () => Response][] = [
      ["relay 429 (its own minute full)", () => new Response("Too Many Requests", { status: 429 })],
      ["relay 502 (push service did not answer)", () => new Response(JSON.stringify({ error: "The push service did not answer" }), { status: 502 })],
      ["push service 503 via relay", () => new Response(JSON.stringify({ status: 503 }), { status: 200 })],
      ["push service 429 via relay", () => new Response(JSON.stringify({ status: 429 }), { status: 200 })],
      ["relay unreachable", () => { throw new TypeError("Failed to fetch"); }],
    ];
    for (const [name, failure] of failures) {
      const posts: string[] = [];
      let relay = failure;
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (hostOf(url) === "web.push.apple.com") throw new TypeError("Failed to fetch");
        try { const answer = relay(); posts.push(answer.ok && (await answer.clone().json() as { status: number }).status === 201 ? "ok" : "fail"); return answer; }
        catch (error) { posts.push("fail"); throw error; }
      }));
      const t = Date.now();
      const now = vi.spyOn(Date, "now").mockReturnValue(t);
      const node = engine();
      await node.updateSettings({ settings: { pushRelay: "https://push-relay.example/" } });
      const chat = await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: contactTarget().target });
      await node.sendMessage({ linkId: chat.id, text: "hi" });
      await vi.waitFor(() => expect(posts, name).toEqual(["fail"]));
      await new Promise((resolve) => setTimeout(resolve, 20));
      relay = () => new Response(JSON.stringify({ status: 201 }), { status: 200 });
      // At once: the relay is not asked again yet.
      now.mockReturnValue(t + 50);
      await node.sendMessage({ linkId: chat.id, text: "are you there?" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(posts, name).toEqual(["fail"]);
      // A little later, the next message's own wake-up goes.
      now.mockReturnValue(t + WAKE_RETRY_MS);
      await node.sendMessage({ linkId: chat.id, text: "hello?" });
      await vi.waitFor(() => expect(posts, name).toEqual(["fail", "ok"]));
      // That one went out: the 5-minute limit holds from it.
      now.mockReturnValue(t + 4 * 60_000);
      await node.sendMessage({ linkId: chat.id, text: "still there?" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(posts, name).toEqual(["fail", "ok"]);
      expect((await saved(chat.id))?.peerWake, name).toBeDefined();
      now.mockRestore();
    }
  });

  it("a wake-up the push service took holds the next for five minutes, as does a subscription refused for good", async () => {
    let status = 201;
    const pushSend = vi.fn(async () => status);
    const t = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t);
    const node = engine({ pushSend });
    for (const answer of [201, 400]) {
      status = answer;
      const chat = await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: contactTarget().target });
      const before = pushSend.mock.calls.length;
      await node.sendMessage({ linkId: chat.id, text: "hi" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      now.mockReturnValue(t + WAKE_RETRY_MS);
      await node.sendMessage({ linkId: chat.id, text: "hi again" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pushSend.mock.calls.length - before).toBe(1);
      now.mockReturnValue(t);
    }
  });

  it("a push relay that answers but not as a push relay is kept in the state, with its own error text, until it forwards one", async () => {
    let relay: () => Response | Promise<Response> = () => new Response("<!doctype html><title>My site</title>", { status: 200, headers: { "Content-Type": "text/html" } });
    const relayed = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (hostOf(url) === "web.push.apple.com") throw new TypeError("Failed to fetch");
      relayed();
      return relay();
    }));
    const node = engine();
    await node.updateSettings({ settings: { pushRelay: "https://push-relay.example/" } });
    const chat = await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: contactTarget().target });
    const wake = async () => {
      const before = relayed.mock.calls.length;
      node["wakeLimiter"].reset(chat.id);
      await node.sendMessage({ linkId: chat.id, text: "hi" });
      await vi.waitFor(() => expect(relayed.mock.calls.length).toBe(before + 1));
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    expect(node.getState().pushRelayRefused).toBeUndefined();
    // A web page at that address: refused, no text of its own.
    await wake();
    expect(node.getState().pushRelayRefused).toMatchObject({ url: "https://push-relay.example/", http: 200 });
    expect(node.getState().pushRelayRefused?.text).toBeUndefined();
    // JSON, but without the push service's status.
    relay = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    await wake();
    expect(node.getState().pushRelayRefused).toMatchObject({ http: 200 });
    // The relay's own refusal: its error text, on one line and cut.
    relay = () => new Response(JSON.stringify({ error: "Origin not allowed" }), { status: 403 });
    await wake();
    expect(node.getState().pushRelayRefused).toMatchObject({ url: "https://push-relay.example/", http: 403, text: "Origin not allowed" });
    relay = () => new Response(JSON.stringify({ error: `Bad\nTTL\u202e value ${"x".repeat(300)}` }), { status: 400 });
    await wake();
    const { text } = node.getState().pushRelayRefused!;
    expect(text).toMatch(/^Bad TTL value x+…$/);
    expect([...text!]).toHaveLength(120);
    // A status the relay forwards (here the push service's own 429) is the relay working: nothing is said any more.
    relay = () => new Response(JSON.stringify({ status: 429 }), { status: 200 });
    await wake();
    expect(node.getState().pushRelayRefused).toBeUndefined();
    // The push service's 410 through the relay is not the relay's problem either; it forgets the subscription as before.
    relay = () => new Response(JSON.stringify({ status: 410 }), { status: 200 });
    await wake();
    expect(node.getState().pushRelayRefused).toBeUndefined();
    await vi.waitFor(async () => expect((await saved(chat.id))?.peerWake).toBeUndefined());
  });

  it("a push relay that cannot be reached (offline, timed out) is not said to refuse; another relay address drops what the old one said", async () => {
    let relay: () => Response | Promise<Response> = () => { throw new TypeError("Failed to fetch"); };
    const relayed = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (hostOf(url) === "web.push.apple.com") throw new TypeError("Failed to fetch");
      relayed();
      return relay();
    }));
    const node = engine();
    await node.updateSettings({ settings: { pushRelay: "https://push-relay.example/" } });
    const chat = await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: contactTarget().target });
    const wake = async () => {
      const before = relayed.mock.calls.length;
      node["wakeLimiter"].reset(chat.id);
      await node.sendMessage({ linkId: chat.id, text: "hi" });
      await vi.waitFor(() => expect(relayed.mock.calls.length).toBe(before + 1));
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    await wake();
    expect(node.getState().pushRelayRefused).toBeUndefined();
    relay = () => new Response(JSON.stringify({ error: "Too many" }), { status: 429 });
    await wake();
    expect(node.getState().pushRelayRefused).toMatchObject({ http: 429, text: "Too many" });
    // Unreachable afterwards: what it said last is kept, not taken for a fix.
    relay = () => { throw new TypeError("Failed to fetch"); };
    await wake();
    expect(node.getState().pushRelayRefused).toMatchObject({ http: 429 });
    await node.updateSettings({ settings: { pushRelay: "https://other-relay.example/" } });
    expect(node.getState().pushRelayRefused).toBeUndefined();
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

describe("online notices: a contact whose app is closed hears that this one came online", () => {
  const asked = () => { const made = contactTarget(); return { ...made, target: { ...made.target, online: true as const } }; };
  const bodies = (calls: unknown[][], secret: Uint8Array, auth: Uint8Array) =>
    calls.map(([request]) => JSON.parse(utf8Decode(decryptPushPayload((request as { body: Uint8Array }).body, secret, auth))) as Record<string, unknown>);

  it("this side asks for them by default; turned off, every live contact is told again without it", async () => {
    const node = engine();
    const a = stubLink();
    await addChat(node, a);
    await node.setWakeSubscription({ subscription: browserSubscription().subscription });
    await vi.waitFor(() => expect(a.sendWake).toHaveBeenCalledTimes(1));
    expect((a.sendWake.mock.lastCall as unknown as [WakeTarget])[0].online).toBe(true);
    await node.setWakeOnline({ on: false });
    expect(a.sendWake).toHaveBeenCalledTimes(2);
    expect((a.sendWake.mock.lastCall as unknown as [WakeTarget])[0]).not.toHaveProperty("online");
    expect((await db.getSettings()).wakeOnline).toBe(false);
    expect(node.getState().settings.wakeOnline).toBe(false);
    // The settings patch cannot turn it back on behind the contacts' backs.
    await node.updateSettings({ settings: { wakeOnline: undefined } as never });
    expect(node["settings"].wakeOnline).toBe(false);
    await node.setWakeOnline({ on: true });
    expect((a.sendWake.mock.lastCall as unknown as [WakeTarget])[0].online).toBe(true);
    expect(await db.getSettings()).not.toHaveProperty("wakeOnline");
  });

  it("is not asked for while the subscription is another device's of this profile, which shows no online notice", async () => {
    const node = engine();
    const a = stubLink();
    const chat = await addChat(node, a);
    const inside = node as unknown as { ownDeviceKey: string | null; settings: { wake?: WakeSubscription } };
    inside.ownDeviceKey = "desktop";
    await node.setWakeSubscription({ subscription: browserSubscription().subscription });
    await vi.waitFor(() => expect(a.sendWake).toHaveBeenCalledTimes(1));
    expect((a.sendWake.mock.lastCall as unknown as [WakeTarget])[0].online).toBe(true);
    // The phone's subscription, carried by this desktop while it is the active one.
    inside.settings = { ...inside.settings, wake: { ...inside.settings.wake!, device: "phone" } };
    await node["shareWake"](chat.id);
    expect((a.sendWake.mock.lastCall as unknown as [WakeTarget])[0]).not.toHaveProperty("online");
  });

  it("an away contact that asked gets one, with its token and nothing else, living five minutes", async () => {
    const pushSend = vi.fn(async () => 201);
    const node = engine({ pushSend });
    const { target, secret, auth } = asked();
    await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: target });
    node["sayOnline"]();
    expect(pushSend).toHaveBeenCalledTimes(1);
    expect(bodies(pushSend.mock.calls, secret, auth)).toEqual([{ wake: 1, k: target.token, o: 1 }]);
    expect((pushSend.mock.calls[0] as unknown as [{ headers: Record<string, string> }])[0].headers.TTL).toBe("300");
  });

  it("none to a contact that did not ask (an older app, or switched off), a live one, a muted one, a group edge, or while offline", async () => {
    const pushSend = vi.fn(async () => 201);
    const node = engine({ pushSend });
    await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: contactTarget().target });
    await addChat(node, stubLink({ isDataLinkOpen: true }), { peerWake: asked().target });
    // A chat the contact muted: its app said to forget the subscription.
    await addChat(node, stubLink({ isDataLinkOpen: false }));
    await addChat(node, stubLink({ isDataLinkOpen: false, groupsSupport: false }), { profile: undefined, group: "g", groupPeer: createIdentity().pubKeyZ32, peerWake: asked().target });
    node["sayOnline"]();
    expect(pushSend).not.toHaveBeenCalled();
    await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: asked().target });
    node["settings"] = { ...node["settings"], online: false };
    node["sayOnline"]();
    expect(pushSend).not.toHaveBeenCalled();
  });

  it("none while \"Share when I'm online\" is off; switched back on, the next start says it again", async () => {
    const pushSend = vi.fn(async () => 201);
    const node = engine({ pushSend });
    const { target, secret, auth } = asked();
    await addChat(node, stubLink({ isDataLinkOpen: false, setStatus: vi.fn() }), { peerWake: target });
    await node.updateSettings({ settings: { sharePresence: false } });
    node["sayOnline"]();
    expect(pushSend).not.toHaveBeenCalled();
    await node.updateSettings({ settings: { sharePresence: true } });
    node["sayOnline"]();
    expect(bodies(pushSend.mock.calls, secret, auth)).toEqual([{ wake: 1, k: target.token, o: 1 }]);
  });

  it("none while the host says this run is not online to its contacts (a headless profile with no presence)", async () => {
    const pushSend = vi.fn(async () => 201);
    let says = false;
    const node = engine({ pushSend, onlineNotices: () => says });
    const { target, secret, auth } = asked();
    await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: target });
    node["sayOnline"]();
    expect(pushSend).not.toHaveBeenCalled();
    says = true;
    node["sayOnline"]();
    expect(bodies(pushSend.mock.calls, secret, auth)).toEqual([{ wake: 1, k: target.token, o: 1 }]);
  });

  it("at most one per contact every 30 minutes, kept across a restart (a restart is what says it)", async () => {
    const pushSend = vi.fn(async () => 201);
    const node = engine({ pushSend });
    const chat = await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: asked().target });
    const t = Date.now();
    node["sayOnline"](t);
    node["sayOnline"](t + 60_000);
    expect(pushSend).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect((await saved(chat.id))?.onlineWokeAt).toBe(t));
    const restarted = engine({ pushSend });
    await addChat(restarted, stubLink({ isDataLinkOpen: false }), (await saved(chat.id))!);
    restarted["sayOnline"](t + 29 * 60_000);
    expect(pushSend).toHaveBeenCalledTimes(1);
    restarted["sayOnline"](t + 30 * 60_000);
    expect(pushSend).toHaveBeenCalledTimes(2);
  });

  it("never holds back a message wake-up, nor is held back by one", async () => {
    const pushSend = vi.fn(async () => 201);
    const node = engine({ pushSend });
    const { target, secret, auth } = asked();
    const chat = await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: target });
    node["sayOnline"]();
    await node.sendMessage({ linkId: chat.id, text: "hi" });
    const other = asked();
    const second = await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: other.target });
    await node.sendMessage({ linkId: second.id, text: "hi" });
    node["sayOnline"]();
    expect(bodies(pushSend.mock.calls.slice(0, 2), secret, auth)).toEqual([{ wake: 1, k: target.token, o: 1 }, { wake: 1, k: target.token }]);
    expect(bodies(pushSend.mock.calls.slice(2), other.secret, other.auth)).toEqual([{ wake: 1, k: other.target.token }, { wake: 1, k: other.target.token, o: 1 }]);
  });

  it("goes out ten a minute, so a push relay's minute (30) keeps room for message and call wake-ups", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pushSend = vi.fn(async () => 201);
      const node = engine({ pushSend });
      const chats = [];
      for (let i = 0; i < 25; i++) chats.push(await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: asked().target }));
      node["sayOnline"]();
      expect(pushSend).toHaveBeenCalledTimes(10);
      // A call right after still has the relay's room.
      const callee = await addChat(node, stubLink({ isDataLinkOpen: false }), { peerWake: contactTarget().target });
      expect(await node.wakeForCall({ linkId: callee.id })).toBe(true);
      expect(pushSend).toHaveBeenCalledTimes(11);
      vi.advanceTimersByTime(59_999);
      expect(pushSend).toHaveBeenCalledTimes(11);
      // A contact whose chat went live meanwhile is not told.
      (node["links"].get(chats[10]!.id)!.link as unknown as Stub).isDataLinkOpen = true;
      vi.advanceTimersByTime(1);
      expect(pushSend).toHaveBeenCalledTimes(21);
      vi.advanceTimersByTime(60_000);
      expect(pushSend).toHaveBeenCalledTimes(25);
      vi.advanceTimersByTime(60_000);
      expect(pushSend).toHaveBeenCalledTimes(25);
    } finally { vi.useRealTimers(); }
  });

  it("is said a little after this app starts or comes back online, to those still away then", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const node = engine({ pushSend: vi.fn(async () => 201) });
      const say = vi.spyOn(node as never, "sayOnline" as never).mockImplementation((() => {}) as never);
      node["announceOnline"]();
      node["announceOnline"]();
      vi.advanceTimersByTime(29_999);
      expect(say).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(say).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});

describe("private groups: a mention wakes a member whose app is closed", () => {
  const memberKey = () => createIdentity().pubKeyZ32;
  async function addEdge(node: GhostlyNode, group: string, peer: string, link: Stub | null, stored: Partial<StoredLink> = {}) {
    // The edges here stand for members the roster has (no group session runs in these tests): a group's traffic goes to those only.
    vi.spyOn(node["groups"], "inRoster").mockReturnValue(true);
    return addChat(node, link, { profile: undefined, group, groupPeer: peer, ...stored });
  }
  const edgeLink = (overrides: Record<string, unknown> = {}) => stubLink({ groupsSupport: true, sendGroupFrame: vi.fn(), ...overrides });
  type Frame = { t: string; g: string; w: { k: string; e: string } | null };
  const framesOf = (link: Stub) => (link as unknown as { sendGroupFrame: ReturnType<typeof vi.fn> }).sendGroupFrame.mock.calls.map(([f]) => f as Frame);
  /** A group message naming these members, as the composer sends it. */
  function mentioning(...keys: string[]) {
    let text = "";
    const mentions = keys.map(k => { const o = Array.from(text).length; text += "@Name "; return { k, o, l: 5 }; });
    return { text: `${text}are you in?`, mentions };
  }
  function sender(node: GhostlyNode, reachable: (key: string) => boolean = () => false) {
    const groups = node["groups"] as unknown as { send: unknown; reachable: unknown };
    groups.send = vi.fn(async () => ({ error: null, messageId: "m" }));
    groups.reachable = vi.fn((_: string, key: string) => reachable(key));
  }

  it("each member of a private group gets its own token on its edge; a community's members do not get one", async () => {
    const node = engine();
    const chat = stubLink(), b = edgeLink(), c = edgeLink(), hub = edgeLink();
    await addChat(node, chat);
    const edgeB = await addEdge(node, "g", memberKey(), b);
    await addEdge(node, "g", memberKey(), c);
    await addEdge(node, "community", memberKey(), hub);
    vi.spyOn(node["groups"], "isCommunityGroup").mockImplementation(id => id === "community");
    const { subscription } = browserSubscription();
    await node.setWakeSubscription({ subscription });
    await vi.waitFor(() => expect(framesOf(c)).toHaveLength(1));
    const [toB] = framesOf(b), [toC] = framesOf(c);
    expect(toB).toMatchObject({ t: "group-wake", g: "g", w: { e: subscription.endpoint, vp: subscription.vapid.publicKey } });
    expect(toB!.w!.k).not.toBe(toC!.w!.k);
    expect((chat.sendWake.mock.calls[0] as unknown as [WakeTarget])[0].token).not.toBe(toB!.w!.k);
    expect(framesOf(hub)).toHaveLength(0);
    expect((await saved(edgeB.id))?.wakeToken).toBe(toB!.w!.k);
    expect(node["groupWakeView"]({ id: "g", profile: "mesh" } as never).wakeTokens?.sort()).toEqual([toB!.w!.k, toC!.w!.k].sort());
    expect(node["groupWakeView"]({ id: "community", profile: "community" } as never)).toEqual({});
    await node.setWakeSubscription({ subscription: null });
    expect(framesOf(b).at(-1)).toEqual({ t: "group-wake", g: "g", w: null });
    await vi.waitFor(async () => expect((await saved(edgeB.id))?.wakeToken).toBeUndefined());
  });

  it("a muted group tells every member to forget it (again whenever an edge opens); unmuted, new tokens", async () => {
    const node = engine();
    const b = edgeLink();
    const edge = await addEdge(node, "g", memberKey(), b);
    await node.setWakeSubscription({ subscription: browserSubscription().subscription });
    await vi.waitFor(() => expect(framesOf(b)).toHaveLength(1));
    const before = framesOf(b)[0]!.w!.k;
    await node.setWakeMuted({ linkId: "group:g", muted: true });
    expect(framesOf(b).at(-1)).toEqual({ t: "group-wake", g: "g", w: null });
    expect((await saved(edge.id))?.wakeToken).toBeUndefined();
    expect((await db.getSettings()).wakeMutedGroups).toEqual(["g"]);
    // A member may keep it anyway: the app is to replace the subscription, as for a muted chat.
    expect((await db.getSettings()).wakeRotate).toBe(true);
    expect(node["groupWakeView"]({ id: "g", profile: "mesh" } as never)).toEqual({ wakeMuted: true });
    await node["shareGroupWake"](edge.id);
    expect(framesOf(b).at(-1)!.w).toBeNull();
    // The settings patch cannot unmute it behind the engine's back.
    await node.updateSettings({ settings: { wakeMutedGroups: [] } as never });
    expect(node["settings"].wakeMutedGroups).toEqual(["g"]);
    await node.setWakeMuted({ linkId: "group:g", muted: false });
    expect(framesOf(b).at(-1)!.w!.k).toBeTruthy();
    expect(framesOf(b).at(-1)!.w!.k).not.toBe(before);
    expect((await db.getSettings()).wakeMutedGroups).toBeUndefined();
  });

  it("a group left, removed or deleted takes its mute with it: joined again under the id, it is not muted", async () => {
    const node = engine();
    const b = edgeLink();
    await addEdge(node, "g", memberKey(), b);
    await addEdge(node, "other", memberKey(), edgeLink());
    await node.setWakeSubscription({ subscription: browserSubscription().subscription });
    await vi.waitFor(() => expect(framesOf(b)).toHaveLength(1));
    await node.setWakeMuted({ linkId: "group:g", muted: true });
    await node.setWakeMuted({ linkId: "group:other", muted: true });
    const said = framesOf(b).length;
    // Every way out of a group (leave, removed, deleted) tells the engine by this.
    (node["groups"] as unknown as { host: { historyGone(groupId: string): void } }).host.historyGone("g");
    expect(node["groupWakeView"]({ id: "g", profile: "mesh" } as never)).toEqual({});
    await vi.waitFor(async () => expect((await db.getSettings()).wakeMutedGroups).toEqual(["other"]));
    // A group just left hands its members no new token.
    expect(framesOf(b)).toHaveLength(said);
  });

  it("an edge whose member held a token closes: replaced when the member is out of the group, not when a group on hubs only drops the edge", async () => {
    const node = engine();
    const [kept, removed] = [memberKey(), memberKey()];
    const edgeKept = await addEdge(node, "g", kept, edgeLink());
    const edgeRemoved = await addEdge(node, "g", removed, edgeLink());
    await node.setWakeSubscription({ subscription: browserSubscription().subscription });
    await vi.waitFor(async () => expect((await saved(edgeRemoved.id))?.wakeToken).toBeTruthy());
    node["membership"] = vi.fn(() => ({ me: "me", members: new Set([kept]) }));
    await node["closeGroupLink"](edgeKept.id);
    expect(node["settings"].wakeRotate).toBeUndefined();
    await node["closeGroupLink"](edgeRemoved.id);
    await vi.waitFor(() => expect(node["settings"].wakeRotate).toBe(true));
  });

  it("a member whose edge a group on hubs dropped still holds the subscription: replaced when it leaves the roster later", async () => {
    const node = engine();
    const [held, other] = [memberKey(), memberKey()];
    const edge = await addEdge(node, "g", held, edgeLink());
    await node.setWakeSubscription({ subscription: browserSubscription().subscription });
    await vi.waitFor(async () => expect((await saved(edge.id))?.wakeToken).toBeTruthy());
    let members = new Set([held, other]);
    node["membership"] = vi.fn(() => ({ me: "me", members }));
    // The hubs take over: the edge goes, the member stays.
    await node["closeGroupLink"](edge.id);
    expect(node["settings"].wakeRotate).toBeUndefined();
    // Someone else leaves: nothing to replace.
    members = new Set([held]);
    node["groupMembersChanged"]("g");
    expect(node["settings"].wakeRotate).toBeUndefined();
    // The member it shared with is removed, with no edge left to close.
    members = new Set();
    node["groupMembersChanged"]("g");
    await vi.waitFor(() => expect(node["settings"].wakeRotate).toBe(true));
    // A new subscription: nobody holds it any more.
    await node.setWakeSubscription({ subscription: browserSubscription().subscription });
    expect((await db.getSettings()).wakeHeldBy).toBeUndefined();
  });

  /** A member of group `g` got a token on its edge, which a group on hubs then dropped. */
  async function heldWithoutEdge() {
    const node = engine();
    const held = memberKey();
    const edge = await addEdge(node, "g", held, edgeLink());
    await node.setWakeSubscription({ subscription: browserSubscription().subscription });
    await vi.waitFor(async () => expect((await saved(edge.id))?.wakeToken).toBeTruthy());
    node["membership"] = vi.fn(() => ({ me: "me", members: new Set([held]) }));
    await node["closeGroupLink"](edge.id);
    expect(node["settings"].wakeRotate).toBeUndefined();
    return node;
  }

  it("muting a group whose members hold the subscription without an edge replaces it", async () => {
    const node = await heldWithoutEdge();
    await node.setWakeMuted({ linkId: "group:g", muted: true });
    expect(node["settings"].wakeRotate).toBe(true);
  });

  it("leaving or forgetting a group whose members hold the subscription without an edge replaces it", async () => {
    const node = await heldWithoutEdge();
    node["membership"] = vi.fn(() => undefined);
    node["groupMembersChanged"]("g");
    await vi.waitFor(() => expect(node["settings"].wakeRotate).toBe(true));
  });

  it("keeps what a member shares on its edge, for its group only, a handful a minute; null forgets it", async () => {
    const node = engine();
    const edge = await addEdge(node, "g", memberKey(), edgeLink());
    const { target } = contactTarget();
    const frame = { t: "group-wake", g: "g", w: { e: target.endpoint, p: target.p256dh, a: target.auth, vp: target.vapid.publicKey, vk: target.vapid.privateKey, k: target.token } };
    const peerWake = () => node["links"].get(edge.id)!.stored.peerWake;
    node["receiveGroupWake"](edge.id, { ...frame, g: "other" });
    expect(peerWake()).toBeUndefined();
    node["receiveGroupWake"](edge.id, frame);
    expect(peerWake()).toEqual(target);
    await vi.waitFor(async () => expect((await saved(edge.id))?.peerWake).toEqual(target));
    node["receiveGroupWake"](edge.id, { t: "group-wake", g: "g", w: null });
    expect(peerWake()).toBeUndefined();
    for (let i = 0; i < 10; i++) node["receiveGroupWake"](edge.id, frame);
    node["receiveGroupWake"](edge.id, { t: "group-wake", g: "g", w: null });
    // Past six a minute, frames are dropped: the target said within the window stands.
    expect(peerWake()).toEqual(target);
  });

  it("a message naming an away member wakes it with its token and nothing else; no mention, a live member or a muted group wakes nobody", async () => {
    const pushSend = vi.fn(async () => 201);
    const node = engine({ pushSend });
    const [away, live, muted, quiet] = [memberKey(), memberKey(), memberKey(), memberKey()];
    const { target, secret, auth } = contactTarget();
    const closed = () => edgeLink({ isDataLinkOpen: false, groupsSupport: false });
    await addEdge(node, "g", away, closed(), { peerWake: target });
    await addEdge(node, "g", live, edgeLink(), { peerWake: contactTarget().target });
    const mutedEdge = await addEdge(node, "g", muted, closed(), { peerWake: contactTarget().target });
    await addEdge(node, "g", quiet, closed());
    sender(node, key => key === live);
    // The muted member's app said to forget it.
    node["receiveGroupWake"](mutedEdge.id, { t: "group-wake", g: "g", w: null });

    await node.sendGroupMessage({ groupId: "g", text: "nobody named here" });
    expect(pushSend).not.toHaveBeenCalled();
    await node.sendGroupMessage({ groupId: "g", ...mentioning(live, muted, quiet) });
    expect(pushSend).not.toHaveBeenCalled();
    const named = mentioning(away, "*");
    await node.sendGroupMessage({ groupId: "g", text: `  ${named.text}  `, mentions: named.mentions });
    expect(pushSend).toHaveBeenCalledTimes(1);
    const [request] = pushSend.mock.calls[0]! as unknown as [{ url: string; body: Uint8Array }];
    expect(request.url).toBe(target.endpoint);
    const plain = utf8Decode(decryptPushPayload(request.body, secret, auth));
    expect(JSON.parse(plain)).toEqual({ wake: 1, k: target.token });
    expect(plain).not.toContain("are you in");
    // A second mention within 5 minutes is not a second push.
    await node.sendGroupMessage({ groupId: "g", ...mentioning(away) });
    expect(pushSend).toHaveBeenCalledTimes(1);
  });

  it("a message naming sixteen away members wakes four; a failed send, a community or this app offline wakes nobody", async () => {
    const pushSend = vi.fn(async () => 201);
    const node = engine({ pushSend });
    const members = Array.from({ length: 16 }, memberKey);
    for (const key of members) await addEdge(node, "g", key, edgeLink({ isDataLinkOpen: false, groupsSupport: false }), { peerWake: contactTarget().target });
    sender(node);
    await node.sendGroupMessage({ groupId: "g", ...mentioning(...members) });
    expect(pushSend).toHaveBeenCalledTimes(4);

    const otherSend = vi.fn(async () => 201);
    const other = engine({ pushSend: otherSend });
    const key = memberKey();
    await addEdge(other, "c", key, edgeLink({ isDataLinkOpen: false, groupsSupport: false }), { peerWake: contactTarget().target });
    sender(other);
    (other["groups"] as unknown as { send: ReturnType<typeof vi.fn> }).send.mockResolvedValueOnce({ error: "You are not in this group yet" });
    await other.sendGroupMessage({ groupId: "c", ...mentioning(key) });
    vi.spyOn(other["groups"], "isCommunityGroup").mockReturnValue(true);
    await other.sendGroupMessage({ groupId: "c", ...mentioning(key) });
    vi.spyOn(other["groups"], "isCommunityGroup").mockReturnValue(false);
    other["settings"] = { ...other["settings"], online: false };
    await other.sendGroupMessage({ groupId: "c", ...mentioning(key) });
    expect(otherSend).not.toHaveBeenCalled();
  });
});
