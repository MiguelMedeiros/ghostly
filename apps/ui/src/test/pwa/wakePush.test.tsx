import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateVapidKeys } from "@ghostly/core";
import { groupChat, setChatMute } from "../../lib/chatMute";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { pushPlatform, rotateWake, setPushPlatform, setWake, useStandbyPush, useWakeOn, useWakeTableSync, type PushPlatform } from "../../lib/wakePush";
import { engineState, fakeEngine, linkView } from "../fakeEngine";

// covers: push.wake.notify, push.wake.mute, push.wake.group, devices.push, devices.push.renew

const keys = { endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "p", auth: "a" };
type Fake = PushPlatform & { [K in keyof PushPlatform]: PushPlatform[K] & ReturnType<typeof vi.fn> };
function fakePlatform(overrides: Partial<PushPlatform> = {}): Fake {
  return {
    supported: vi.fn(() => true),
    subscribe: vi.fn(async () => keys),
    current: vi.fn(async () => keys),
    unsubscribe: vi.fn(async () => {}),
    syncTable: vi.fn(async () => {}),
    ...overrides,
  } as never;
}

beforeEach(() => setPushPlatform(null));
afterEach(() => setPushPlatform(null));

describe("where it can be turned on", () => {
  it("only where the host registered a way that works: the installed web app", () => {
    expect(pushPlatform()).toBeNull();
    setPushPlatform(fakePlatform({ supported: vi.fn(() => false) }));
    expect(pushPlatform()).toBeNull();
    setPushPlatform(fakePlatform());
    expect(pushPlatform()).not.toBeNull();
  });
});

describe("turning it on and off", () => {
  it("on: a fresh key pair, a subscription made with it, then the engine shares it", async () => {
    const platform = fakePlatform();
    setPushPlatform(platform);
    fakeEngine.on("setWakeSubscription", () => undefined);
    await setWake(true);
    const [, vapid] = platform.subscribe.mock.calls[0]!;
    expect(vapid).toMatchObject({ publicKey: expect.any(String), privateKey: expect.any(String) });
    expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([{ subscription: { ...keys, vapid } }]);
  });

  it("off: contacts are told first, then the subscription ends", async () => {
    const order: string[] = [];
    const platform = fakePlatform({ unsubscribe: vi.fn(async () => { order.push("unsubscribe"); }) });
    setPushPlatform(platform);
    fakeEngine.on("setWakeSubscription", () => { order.push("engine"); });
    await setWake(false);
    expect(order).toEqual(["engine", "unsubscribe"]);
    expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([{ subscription: null }]);
  });

  it("a refusal is a sentence to show", async () => {
    setPushPlatform(fakePlatform({ subscribe: vi.fn(async () => { throw new Error("Notifications are off"); }) }));
    await expect(setWake(true)).rejects.toThrow("Notifications are off");
  });
});

describe("the push worker's table", () => {
  const session = (id: string, peer: string) => saveSession({ id, mySeedB64: "s", peerPubKeyB64: peer, encKeyB64: "e", createdAt: 1, messages: [] } as unknown as ChatSession);

  it("a token per chat that shared one, its route, and its mute; nothing while it is off", async () => {
    const platform = fakePlatform();
    setPushPlatform(platform);
    session("chata", "peer-a");
    session("chatb", "peer-b");
    setChatMute("chatb", "forever");
    fakeEngine.on("setWakeMuted", () => undefined);
    fakeEngine.setState(engineState({
      settings: { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, wake: { ...keys, vapid: generateVapidKeys() } },
      links: [
        linkView({ id: "l-a", peerPubKeyZ32: "peer-a", wakeToken: "tokenaaaaaaaaaaaaaaaaa" }),
        linkView({ id: "l-b", peerPubKeyZ32: "peer-b", wakeToken: "tokenbbbbbbbbbbbbbbbbb" }),
        linkView({ id: "l-c", peerPubKeyZ32: "peer-c" }),
      ],
    }));
    renderHook(() => useWakeTableSync({ title: "Ghostly", body: "New message" }));
    await waitFor(() => expect(platform.syncTable).toHaveBeenCalled());
    expect(platform.syncTable).toHaveBeenLastCalledWith("", [
      { token: "tokenaaaaaaaaaaaaaaaaa", path: "/chat/chata" },
      { token: "tokenbbbbbbbbbbbbbbbbb", path: "/chat/chatb", mutedUntil: "forever" },
    // With the profile's database name: where the worker finds the device state (WISP 06 § Push and the phone).
    ], { title: "Ghostly", body: "New message", db: "ghostly" });

    // The muted chat's contact is told not to wake it at all.
    expect(fakeEngine.callsTo("setWakeMuted")).toContainEqual({ linkId: "l-b", muted: true });
    // Unmuted: the table follows at once.
    setChatMute("chatb", undefined);
    await waitFor(() => expect(platform.syncTable.mock.lastCall![1]).toEqual([
      { token: "tokenaaaaaaaaaaaaaaaaa", path: "/chat/chata" }, { token: "tokenbbbbbbbbbbbbbbbbb", path: "/chat/chatb" },
    ]));
  });

  it("a contact that held it was deleted or muted: a new subscription with a new key pair, or off without notifications", async () => {
    const old = generateVapidKeys();
    const platform = fakePlatform();
    setPushPlatform(platform);
    vi.stubGlobal("Notification", { permission: "granted" });
    fakeEngine.on("setWakeSubscription", () => undefined);
    fakeEngine.setState(engineState({ settings: { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, wake: { ...keys, vapid: old }, wakeRotate: true } }));
    renderHook(() => useWakeTableSync({ title: "Ghostly", body: "New message" }));
    await waitFor(() => expect(fakeEngine.callsTo("setWakeSubscription")).toHaveLength(1));
    const subscription = fakeEngine.callsTo("setWakeSubscription")[0]!.subscription!;
    expect(subscription.vapid.publicKey).not.toBe(old.publicKey);
    expect(platform.subscribe).toHaveBeenCalledWith("", subscription.vapid);

    vi.stubGlobal("Notification", { permission: "denied" });
    await rotateWake();
    const calls = fakeEngine.callsTo("setWakeSubscription");
    expect(calls[calls.length - 1]).toEqual({ subscription: null });
    expect(platform.unsubscribe).toHaveBeenCalledWith("");
    vi.unstubAllGlobals();
  });

  it("a private group: a token per member, all opening the group; its mute tells the engine; a community has none", async () => {
    const platform = fakePlatform();
    setPushPlatform(platform);
    setChatMute(groupChat("g2"), "forever");
    fakeEngine.on("setWakeMuted", () => undefined);
    const group = (id: string, extra: Record<string, unknown>) => ({ id, name: id, createdAt: 1, isAdmin: false, members: [], invited: [], memberLinks: {}, lastMessageAt: 0, canSend: true, ...extra });
    fakeEngine.setState(engineState({
      settings: { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, wake: { ...keys, vapid: generateVapidKeys() } },
      groups: [
        group("g1", { profile: "mesh", wakeTokens: ["tokenmember1aaaaaaaaaa", "tokenmember2aaaaaaaaaa"] }),
        group("g2", { profile: "mesh", wakeTokens: ["tokenmutedaaaaaaaaaaaa"] }),
        group("c1", { profile: "community", wakeTokens: ["tokencommunityaaaaaaaa"] }),
      ] as never,
    }));
    renderHook(() => useWakeTableSync({ title: "Ghostly", body: "New message" }));
    await waitFor(() => expect(platform.syncTable).toHaveBeenCalled());
    expect(platform.syncTable.mock.lastCall![1]).toEqual([
      { token: "tokenmember1aaaaaaaaaa", path: "/group/g1" },
      { token: "tokenmember2aaaaaaaaaa", path: "/group/g1" },
      { token: "tokenmutedaaaaaaaaaaaa", path: "/group/g2", mutedUntil: "forever" },
    ]);
    expect(fakeEngine.callsTo("setWakeMuted")).toEqual([{ linkId: "group:g2", muted: true }]);
    setChatMute(groupChat("g2"), undefined);
  });

  it("a subscription the browser dropped while closed is made again with the same key pair", async () => {
    const vapid = generateVapidKeys();
    const platform = fakePlatform({ current: vi.fn(async () => null) });
    setPushPlatform(platform);
    vi.stubGlobal("Notification", { permission: "granted" });
    fakeEngine.on("setWakeSubscription", () => undefined);
    fakeEngine.setState(engineState({ settings: { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, wake: { ...keys, endpoint: "https://fcm.googleapis.com/old", vapid } } }));
    renderHook(() => useWakeTableSync({ title: "Ghostly", body: "New message" }));
    await waitFor(() => expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([{ subscription: { ...keys, vapid } }]));
    expect(platform.subscribe).toHaveBeenCalledWith("", vapid);
    vi.unstubAllGlobals();
  });
});

describe("a profile on several devices (WISP 06 § Push and the phone)", () => {
  const settings = (wake: object, extra: object = {}) => ({ online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, wake, ...extra });

  it("another device's subscription (the phone's, on the active desktop) is neither made again here, nor turned off, nor rotated; the switch is off", async () => {
    const vapid = generateVapidKeys();
    const platform = fakePlatform({ current: vi.fn(async () => null) });
    setPushPlatform(platform);
    vi.stubGlobal("Notification", { permission: "denied" });
    fakeEngine.on("setWakeSubscription", () => undefined);
    fakeEngine.setState({ ...engineState({ settings: settings({ ...keys, vapid, device: "P".repeat(43) }, { wakeRotate: true }) as never }), wakeOwner: "away" });
    const { result } = renderHook(() => { useWakeTableSync({ title: "Ghostly", body: "New message" }); return useWakeOn(); });
    await waitFor(() => expect(platform.current).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toBe(false);
    expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([]);
    expect(platform.subscribe).not.toHaveBeenCalled();
    expect(platform.unsubscribe).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("this browser's own subscription, made before the profile had a device set: the engine is told it is this device's", async () => {
    const platform = fakePlatform();
    setPushPlatform(platform);
    fakeEngine.on("wakeConfirm", () => undefined);
    fakeEngine.setState(engineState({ settings: settings({ ...keys, vapid: generateVapidKeys() }) as never }));
    renderHook(() => useWakeTableSync({ title: "Ghostly", body: "New message" }));
    await waitFor(() => expect(fakeEngine.callsTo("wakeConfirm")).toEqual([{ endpoint: keys.endpoint }]));
  });

  it("a standby writes the worker's words and where its device state is, and keeps its subscription: a replaced one goes to the record, with the same key", async () => {
    const vapid = generateVapidKeys();
    const fresh = { ...keys, endpoint: "https://fcm.googleapis.com/fcm/send/new" };
    const platform = fakePlatform({ current: vi.fn(async () => null), subscribe: vi.fn(async () => fresh), syncText: vi.fn(async () => {}) });
    setPushPlatform(platform);
    vi.stubGlobal("Notification", { permission: "granted" });
    fakeEngine.on("devicePushState", () => ({ endpoint: keys.endpoint, vapidPublic: vapid.publicKey }));
    fakeEngine.on("devicePushSet", () => undefined);
    renderHook(() => useStandbyPush({ title: "Ghostly", body: "New message", standby: "New message. Active on {device}." }, true));
    await waitFor(() => expect(fakeEngine.callsTo("devicePushSet")).toEqual([{ subscription: fresh }]));
    expect(platform.subscribe).toHaveBeenCalledWith("", { publicKey: vapid.publicKey });
    expect(platform.syncText).toHaveBeenCalledWith("", { title: "Ghostly", body: "New message", standby: "New message. Active on {device}.", db: "ghostly" });
    vi.unstubAllGlobals();
  });

  it("a standby asked for a new subscription makes one with a new key pair, though the browser's is the stored one", async () => {
    const old = generateVapidKeys();
    const fresh = { ...keys, endpoint: "https://fcm.googleapis.com/fcm/send/renewed" };
    const platform = fakePlatform({ current: vi.fn(async () => keys), subscribe: vi.fn(async () => fresh), syncText: vi.fn(async () => {}) });
    setPushPlatform(platform);
    vi.stubGlobal("Notification", { permission: "granted" });
    fakeEngine.on("devicePushState", () => ({ endpoint: keys.endpoint, vapidPublic: old.publicKey, renew: true }));
    fakeEngine.on("devicePushSet", () => undefined);
    renderHook(() => useStandbyPush({ title: "Ghostly", body: "New message" }, true));
    await waitFor(() => expect(fakeEngine.callsTo("devicePushSet")).toHaveLength(1));
    const [{ subscription }] = fakeEngine.callsTo("devicePushSet") as unknown as [{ subscription: { endpoint: string; vapid: { publicKey: string } } }];
    expect(subscription.endpoint).toBe(fresh.endpoint);
    expect(subscription.vapid.publicKey).not.toBe(old.publicKey);
    expect(platform.subscribe).toHaveBeenCalledWith("", subscription.vapid);
    vi.unstubAllGlobals();
  });

  it("a standby with notifications turned off has no subscription any more, and says so", async () => {
    const platform = fakePlatform({ current: vi.fn(async () => null), syncText: vi.fn(async () => {}) });
    setPushPlatform(platform);
    vi.stubGlobal("Notification", { permission: "denied" });
    fakeEngine.on("devicePushState", () => ({ endpoint: keys.endpoint, vapidPublic: generateVapidKeys().publicKey }));
    fakeEngine.on("devicePushSet", () => undefined);
    renderHook(() => useStandbyPush({ title: "Ghostly", body: "New message" }, true));
    await waitFor(() => expect(fakeEngine.callsTo("devicePushSet")).toEqual([{ subscription: null }]));
    expect(platform.subscribe).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
