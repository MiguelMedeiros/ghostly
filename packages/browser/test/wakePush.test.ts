import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { createIdentity, decryptPushPayload, fromBase64Url, generateVapidKeys, newWakeToken, toBase64Url, utf8Decode, type WakeTarget } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink, WakeSubscription } from "../src/shared/types";

// covers: push.wake.exchange, push.wake.rate-limit, push.wake.send, push.wake.mute, push.wake.group

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

describe("private groups: a mention wakes a member whose app is closed", () => {
  const memberKey = () => createIdentity().pubKeyZ32;
  async function addEdge(node: GhostlyNode, group: string, peer: string, link: Stub | null, stored: Partial<StoredLink> = {}) {
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
