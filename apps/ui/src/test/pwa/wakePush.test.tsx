import { act, renderHook, waitFor, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateVapidKeys, WAKE_CALL_WAIT_MS } from "@ghostly/core";
import { groupChat, setChatMute } from "../../lib/chatMute";
import { loadSettings, saveSettings, type Language } from "../../lib/settings";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { pushPlatform, rotateWake, setPushPlatform, setWake, setWakeOnline, useStandbyPush, useWakeOn, useWakeOnline, useWakeTableSync, type PushPlatform, NO_PUSH_SERVICE_KEY, isNoPushService } from "../../lib/wakePush";
import { engineState, fakeEngine, linkView, groupView } from "../fakeEngine";
import { Settings } from "../../pages/Settings";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import type { WakeSubscription } from "@ghostly/browser/shared/types";
import { renderApp } from "../render";
import { Route, Routes } from "react-router-dom";
import { closeOnlineWakeNotices as closeOnlineInBrowser, closeWakeNotices as closeInBrowser } from "../../../../web/src/pwa/push";
import { refreshWindowAway } from "../../lib/windowAway";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { useWakeCall } from "../../hooks/useWakeCall";
import { setCallOn } from "../../../../../packages/react/src/callRegistry";
import "fake-indexeddb/auto";
import { servicesPlatform } from "../../lib/platform";

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

// covers: push.wake.notify, push.wake.mute, push.wake.group, push.wake.online, devices.push, devices.push.renew
describe("wake-ups by push", () => {
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

  /** The page as hidden (in the background, or being closed) until `show()`, which is how a page comes back. */
  function hiddenPage(): { show(): void; restore(): void } {
    let state: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    return {
      show() { state = "visible"; document.dispatchEvent(new Event("visibilitychange")); },
      restore() { delete (document as unknown as Record<string, unknown>).visibilityState; },
    };
  }
  const moment = () => new Promise((resolve) => setTimeout(resolve, 20));

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

    it("holds the name this app shows for each 1:1 chat, for the online notice; none it does not know", async () => {
      const platform = fakePlatform();
      setPushPlatform(platform);
      const named = (id: string, peer: string, names: { label?: string; nick?: string }) =>
        saveSession({ id, mySeedB64: "s", peerPubKeyB64: peer, encKeyB64: "e", createdAt: 1, messages: [], ...names } as unknown as ChatSession);
      named("chatl", "peer-l", { label: " Ana ", nick: "ana_bot" });
      named("chatn", "peer-n", { nick: "Bo" });
      session("chatu", "peer-u");
      fakeEngine.setState(engineState({
        settings: { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, wake: { ...keys, vapid: generateVapidKeys() } },
        links: [
          linkView({ id: "l-l", peerPubKeyZ32: "peer-l", wakeToken: "tokenlllllllllllllllll" }),
          linkView({ id: "l-n", peerPubKeyZ32: "peer-n", wakeToken: "tokennnnnnnnnnnnnnnnnn" }),
          linkView({ id: "l-u", peerPubKeyZ32: "peer-u", wakeToken: "tokenuuuuuuuuuuuuuuuuu" }),
        ],
      }));
      const words = { title: "Ghostly", body: "New message", online: "{name} is online", onlineUnnamed: "A contact is online" };
      renderHook(() => useWakeTableSync(words));
      await waitFor(() => expect(platform.syncTable).toHaveBeenCalled());
      expect(platform.syncTable).toHaveBeenLastCalledWith("", [
        { token: "tokenlllllllllllllllll", path: "/chat/chatl", name: "Ana" },
        { token: "tokennnnnnnnnnnnnnnnnn", path: "/chat/chatn", name: "Bo" },
        { token: "tokenuuuuuuuuuuuuuuuuu", path: "/chat/chatu" },
      ], { ...words, db: "ghostly" });
    });

    it("names no contact while the profile has a lock screen, and names them again when it is turned off (WISP 04)", async () => {
      const platform = fakePlatform();
      setPushPlatform(platform);
      saveSession({ id: "chatl", mySeedB64: "s", peerPubKeyB64: "peer-l", encKeyB64: "e", createdAt: 1, messages: [], label: "Ana" } as unknown as ChatSession);
      const settings = loadSettings();
      saveSettings({ ...settings, lockScreen: { ...settings.lockScreen, enabled: true, passwordHash: "hash" } });
      fakeEngine.setState(engineState({
        settings: { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, wake: { ...keys, vapid: generateVapidKeys() } },
        links: [linkView({ id: "l-l", peerPubKeyZ32: "peer-l", wakeToken: "tokenlllllllllllllllll" })],
      }));
      renderHook(() => useWakeTableSync({ title: "Ghostly", body: "New message", online: "{name} is online", onlineUnnamed: "A contact is online" }));
      await waitFor(() => expect(platform.syncTable).toHaveBeenCalled());
      expect(platform.syncTable.mock.lastCall![1]).toEqual([{ token: "tokenlllllllllllllllll", path: "/chat/chatl" }]);

      act(() => saveSettings({ ...settings, lockScreen: { ...settings.lockScreen, enabled: false } }));
      await waitFor(() => expect(platform.syncTable.mock.lastCall![1]).toEqual([{ token: "tokenlllllllllllllllll", path: "/chat/chatl", name: "Ana" }]));
      // Turned on again (another tab, or this one): the name leaves the table at once.
      act(() => saveSettings({ ...settings, lockScreen: { ...settings.lockScreen, enabled: true, passwordHash: "hash" } }));
      await waitFor(() => expect(platform.syncTable.mock.lastCall![1]).toEqual([{ token: "tokenlllllllllllllllll", path: "/chat/chatl" }]));
    });

    it("says when online notices are turned off, and is written again each time the switch changes", async () => {
      const platform = fakePlatform();
      setPushPlatform(platform);
      session("chata", "peer-a");
      const settings = { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, wake: { ...keys, vapid: generateVapidKeys() } };
      const links = [linkView({ id: "l-a", peerPubKeyZ32: "peer-a", wakeToken: "tokenaaaaaaaaaaaaaaaaa" })];
      fakeEngine.setState(engineState({ settings, links }));
      const words = { title: "Ghostly", body: "New message", online: "{name} is online", onlineUnnamed: "A contact is online" };
      renderHook(() => useWakeTableSync(words));
      await waitFor(() => expect(platform.syncTable).toHaveBeenCalledTimes(1));
      expect(platform.syncTable.mock.lastCall![2]).toEqual({ ...words, db: "ghostly" });
      await act(async () => { fakeEngine.setState(engineState({ settings: { ...settings, wakeOnline: false }, links })); });
      await waitFor(() => expect(platform.syncTable).toHaveBeenCalledTimes(2));
      expect(platform.syncTable.mock.lastCall![2]).toEqual({ ...words, onlineOff: true, db: "ghostly" });
      expect(platform.syncTable.mock.lastCall![1]).toEqual([{ token: "tokenaaaaaaaaaaaaaaaaa", path: "/chat/chata" }]);
      await act(async () => { fakeEngine.setState(engineState({ settings, links })); });
      await waitFor(() => expect(platform.syncTable).toHaveBeenCalledTimes(3));
      expect(platform.syncTable.mock.lastCall![2]).toEqual({ ...words, db: "ghostly" });
    });

    it("the online switch asks the engine, and reads its setting: on unless turned off", async () => {
      fakeEngine.on("setWakeOnline", () => undefined);
      await setWakeOnline(false);
      expect(fakeEngine.callsTo("setWakeOnline")).toEqual([{ on: false }]);
      const settings = { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true };
      fakeEngine.setState(engineState({ settings }));
      const { result } = renderHook(() => useWakeOnline());
      expect(result.current).toEqual({ shared: false, on: true });
      await act(async () => { fakeEngine.setState(engineState({ settings: { ...settings, wake: { ...keys, vapid: generateVapidKeys() }, wakeOnline: false } })); });
      expect(result.current).toEqual({ shared: true, on: false });
    });

    it("is written when what it holds changes, not at every state the engine builds", async () => {
      const platform = fakePlatform();
      setPushPlatform(platform);
      session("chata", "peer-a");
      const wake = { ...keys, vapid: generateVapidKeys() };
      // Every state has new `links` and `groups`, as the engine builds them (typing, a file's progress, a contact connecting).
      const state = (token: string, note: string) => engineState({
        settings: { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, wake },
        links: [linkView({ id: "l-a", peerPubKeyZ32: "peer-a", wakeToken: token, discoveryError: note })],
        groups: [{ id: "g1", name: "g1", profile: "mesh", createdAt: 1, isAdmin: false, members: [], invited: [], memberLinks: {}, lastMessageAt: Number(note), canSend: true, wakeTokens: ["tokenmember1aaaaaaaaaa"] }] as never,
      });
      fakeEngine.setState(state("tokenaaaaaaaaaaaaaaaaa", "0"));
      renderHook(() => useWakeTableSync({ title: "Ghostly", body: "New message" }));
      await waitFor(() => expect(platform.syncTable).toHaveBeenCalledTimes(1));

      for (let i = 1; i <= 20; i++) await act(async () => { fakeEngine.setState(state("tokenaaaaaaaaaaaaaaaaa", String(i))); });
      await moment();
      expect(platform.syncTable).toHaveBeenCalledTimes(1);

      // A new token (the subscription was replaced): the table follows.
      await act(async () => { fakeEngine.setState(state("tokenzzzzzzzzzzzzzzzzz", "21")); });
      await waitFor(() => expect(platform.syncTable).toHaveBeenCalledTimes(2));
      expect(platform.syncTable.mock.lastCall![1]).toEqual([{ token: "tokenzzzzzzzzzzzzzzzzz", path: "/chat/chata" }, { token: "tokenmember1aaaaaaaaaa", path: "/group/g1" }]);
      // A chat saved on this page (a first pairing gives it its contact) and a mute still write it at once.
      window.dispatchEvent(new Event("session-updated"));
      expect(platform.syncTable).toHaveBeenCalledTimes(3);
    });

    it("is not written again for what another profile's tab stores, only for this profile's keys", async () => {
      const platform = fakePlatform();
      setPushPlatform(platform);
      session("chata", "peer-a");
      fakeEngine.setState(engineState({
        settings: { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, wake: { ...keys, vapid: generateVapidKeys() } },
        links: [linkView({ id: "l-a", peerPubKeyZ32: "peer-a", wakeToken: "tokenaaaaaaaaaaaaaaaaa" })],
      }));
      renderHook(() => useWakeTableSync({ title: "Ghostly", body: "New message" }));
      await waitFor(() => expect(platform.syncTable).toHaveBeenCalledTimes(1));

      // Another profile running in another tab stores its chats as its texts come (a few keys per text), and the browser
      // tells this tab of each: none is this profile's table.
      const other = (key: string) => window.dispatchEvent(new StorageEvent("storage", { key, newValue: "x" }));
      for (let i = 0; i < 30; i++) {
        other("ghostly_k3v9q2m7xa_chatw");
        other("ghostly_k3v9q2m7xa_read_chatw");
        other("ghostly-profiles");
      }
      expect(platform.syncTable).toHaveBeenCalledTimes(1);

      // This profile's own keys (a mute), and the whole storage cleared, still write it.
      other("ghostly_mute_chata");
      expect(platform.syncTable).toHaveBeenCalledTimes(2);
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
      expect(platform.syncTable).toHaveBeenCalledTimes(3);
    });

    it("a message that came looks through the stored chats once, not once or twice per chat", async () => {
      const platform = fakePlatform();
      setPushPlatform(platform);
      const links = [];
      for (let i = 0; i < 40; i++) {
        saveSession({ id: `chat${i}`, mySeedB64: "s", peerPubKeyB64: `peer-${i}`, encKeyB64: "e", createdAt: 1, messages: [], label: `Contact ${i}` } as unknown as ChatSession);
        links.push(linkView({ id: `l-${i}`, peerPubKeyZ32: `peer-${i}`, wakeToken: `token${String(i).padStart(17, "a")}` }));
      }
      fakeEngine.setState(engineState({
        settings: { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, wake: { ...keys, vapid: generateVapidKeys() } },
        links,
      }));
      renderHook(() => useWakeTableSync({ title: "Ghostly", body: "New message" }));
      await waitFor(() => expect(platform.syncTable).toHaveBeenCalledTimes(1));

      // Each message that came, each tick and each reaction says `session-updated`: the table is built again, and each
      // look through the stored chats walks every key of the page's storage (its chats, mutes, drafts, settings...).
      const real = localStorage;
      let walked = 0;
      vi.stubGlobal("localStorage", {
        get length() { return real.length; },
        key: (i: number) => { walked++; return real.key(i); },
        getItem: (key: string) => real.getItem(key),
        setItem: (key: string, value: string) => real.setItem(key, value),
        removeItem: (key: string) => real.removeItem(key),
        clear: () => real.clear(),
      });
      window.dispatchEvent(new Event("session-updated"));
      vi.unstubAllGlobals();
      expect(platform.syncTable).toHaveBeenCalledTimes(2);
      expect(walked).toBeLessThanOrEqual(2 * real.length);
      expect(platform.syncTable.mock.lastCall![1]).toHaveLength(40);
      expect(platform.syncTable.mock.lastCall![1][39]).toEqual({ token: `token${"39".padStart(17, "a")}`, path: "/chat/chat39", name: "Contact 39" });
    });

    it("a mute that ends by itself: the contact is told to wake the chat again, with no new state to wait for", async () => {
      const platform = fakePlatform();
      setPushPlatform(platform);
      session("chatm", "peer-m");
      setChatMute("chatm", Date.now() + 150);
      fakeEngine.on("setWakeMuted", () => undefined);
      fakeEngine.setState(engineState({
        settings: { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, wake: { ...keys, vapid: generateVapidKeys() } },
        links: [linkView({ id: "l-m", peerPubKeyZ32: "peer-m", wakeToken: "tokenmmmmmmmmmmmmmmmmm", wakeMuted: true })],
      }));
      renderHook(() => useWakeTableSync({ title: "Ghostly", body: "New message" }));
      await waitFor(() => expect(platform.syncTable).toHaveBeenCalled());
      expect(fakeEngine.callsTo("setWakeMuted")).toEqual([]);
      await waitFor(() => expect(fakeEngine.callsTo("setWakeMuted")).toEqual([{ linkId: "l-m", muted: false }]));
      expect(platform.syncTable.mock.lastCall![1]).toEqual([{ token: "tokenmmmmmmmmmmmmmmmmm", path: "/chat/chatm" }]);
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

    it("a hidden page that reads notifications as refused (one being closed does, whatever the person chose) turns nothing off: the new subscription is made when it shows", async () => {
      const old = generateVapidKeys();
      const platform = fakePlatform();
      setPushPlatform(platform);
      const page = hiddenPage();
      vi.stubGlobal("Notification", { permission: "denied" });
      fakeEngine.on("setWakeSubscription", () => undefined);
      fakeEngine.setState(engineState({ settings: { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, wake: { ...keys, vapid: old }, wakeRotate: true } }));
      renderHook(() => useWakeTableSync({ title: "Ghostly", body: "New message" }));
      await moment();
      expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([]);
      expect(platform.subscribe).not.toHaveBeenCalled();
      expect(platform.unsubscribe).not.toHaveBeenCalled();

      // It was the page going away, not the person: shown again, it reads what was chosen and makes the new subscription.
      vi.stubGlobal("Notification", { permission: "granted" });
      page.show();
      await waitFor(() => expect(fakeEngine.callsTo("setWakeSubscription")).toHaveLength(1));
      const subscription = fakeEngine.callsTo("setWakeSubscription")[0]!.subscription!;
      expect(subscription.vapid.publicKey).not.toBe(old.publicKey);
      expect(platform.unsubscribe).not.toHaveBeenCalled();
      page.restore();
      vi.unstubAllGlobals();
    });

    it("a hidden page whose notifications were really taken away turns wake-ups off once it shows", async () => {
      const platform = fakePlatform();
      setPushPlatform(platform);
      const page = hiddenPage();
      vi.stubGlobal("Notification", { permission: "denied" });
      fakeEngine.on("setWakeSubscription", () => undefined);
      fakeEngine.setState(engineState({ settings: { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, wake: { ...keys, vapid: generateVapidKeys() }, wakeRotate: true } }));
      const rotated = rotateWake();
      await moment();
      expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([]);
      page.show();
      await rotated;
      expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([{ subscription: null }]);
      expect(platform.unsubscribe).toHaveBeenCalledWith("");
      page.restore();
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

    it("a dropped subscription on a hidden page that reads notifications as refused is left as it is, and made again when the page shows", async () => {
      const vapid = generateVapidKeys();
      const platform = fakePlatform({ current: vi.fn(async () => null) });
      setPushPlatform(platform);
      const page = hiddenPage();
      vi.stubGlobal("Notification", { permission: "denied" });
      fakeEngine.on("setWakeSubscription", () => undefined);
      fakeEngine.setState(engineState({ settings: { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, wake: { ...keys, endpoint: "https://fcm.googleapis.com/old", vapid } } }));
      renderHook(() => useWakeTableSync({ title: "Ghostly", body: "New message" }));
      await waitFor(() => expect(platform.current).toHaveBeenCalled());
      await moment();
      expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([]);

      vi.stubGlobal("Notification", { permission: "granted" });
      page.show();
      await waitFor(() => expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([{ subscription: { ...keys, vapid } }]));
      page.restore();
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

    it("a standby's hidden page that reads notifications as refused keeps its subscription until it shows", async () => {
      const platform = fakePlatform({ current: vi.fn(async () => null), syncText: vi.fn(async () => {}) });
      setPushPlatform(platform);
      const page = hiddenPage();
      vi.stubGlobal("Notification", { permission: "denied" });
      fakeEngine.on("devicePushState", () => ({ endpoint: keys.endpoint, vapidPublic: generateVapidKeys().publicKey }));
      fakeEngine.on("devicePushSet", () => undefined);
      renderHook(() => useStandbyPush({ title: "Ghostly", body: "New message" }, true));
      await waitFor(() => expect(platform.current).toHaveBeenCalled());
      await moment();
      expect(fakeEngine.callsTo("devicePushSet")).toEqual([]);
      page.show();
      await waitFor(() => expect(fakeEngine.callsTo("devicePushSet")).toEqual([{ subscription: null }]));
      page.restore();
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
});

// covers: push.wake.notify
describe("wake-ups where the browser has no push service", () => {
  /*
   * A browser with no push service (GrapheneOS's Vanadium: Chromium without Google Play services). `PushManager` is
   * there, so the switch is offered, but every subscription is refused with "AbortError: Registration failed - push
   * service not available". The switch goes back off with why, in the person's language, for as long as it is so: kept
   * for the browser, the next visit reads it as unavailable, with a Try again.
   */

  const keys = { endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "p", auth: "a" };
  const noService = () => new DOMException("Registration failed - push service not available", "AbortError");
  const denied = () => new DOMException("Registration failed - permission denied", "NotAllowedError");

  function platform(subscribe: PushPlatform["subscribe"]) {
    const fake = { supported: () => true, subscribe: vi.fn(subscribe), current: vi.fn(async () => null), unsubscribe: vi.fn(async () => {}), syncTable: vi.fn(async () => {}) };
    setPushPlatform(fake as unknown as PushPlatform);
    return fake;
  }
  const settings = (language?: Language) => renderApp(<LockScreenProvider><UpdateProvider><Settings /></UpdateProvider></LockScreenProvider>, { language });
  const hint = () => screen.getByTestId("settings-wake-hint");
  const wakeSwitch = () => screen.getByTestId("settings-wake");

  beforeEach(() => fakeEngine.on("setWakeSubscription", () => undefined));
  afterEach(() => { setPushPlatform(null); vi.useRealTimers(); });

  describe("a browser with no push service", () => {
    it("turned on: the switch goes back off, and why stays on screen in the person's language", async () => {
      const fake = platform(async () => { throw noService(); });
      const { user } = settings("pt");
      await user.click(await screen.findByTestId("settings-wake"));
      await waitFor(() => expect(fake.subscribe).toHaveBeenCalledTimes(1));
      const why = "Este navegador não tem serviço de push, então o Ghostly não pode ser acordado com o app fechado. No GrapheneOS, instale o Google Play em sandbox ou use outro navegador.";
      await waitFor(() => expect(hint()).toHaveTextContent(why));
      expect(wakeSwitch()).toHaveAttribute("aria-checked", "false");
      // Still there long after: nothing takes it away but the next try.
      vi.useFakeTimers();
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(hint()).toHaveTextContent(why);
      expect(wakeSwitch()).toHaveAttribute("aria-checked", "false");
      // Unavailable, with why as its description, and a way to try again.
      expect(wakeSwitch()).toHaveAttribute("aria-disabled", "true");
      expect(wakeSwitch()).toHaveAttribute("aria-describedby", hint().id);
      expect(screen.getByTestId("settings-wake-retry")).toHaveTextContent("Tentar de novo");
      expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([]);
    });

    it("is kept for the browser: the next visit reads it as unavailable at once, and tapping the switch tries nothing", async () => {
      const fake = platform(async () => { throw noService(); });
      const first = settings();
      await first.user.click(await screen.findByTestId("settings-wake"));
      await waitFor(() => expect(wakeSwitch()).toHaveAttribute("aria-disabled", "true"));
      expect(localStorage.getItem(NO_PUSH_SERVICE_KEY)).toBe("1");
      first.unmount();

      const { user } = settings();
      expect(await screen.findByTestId("settings-wake-hint")).toHaveTextContent("This browser has no push service, so Ghostly can't be woken while it's closed. On GrapheneOS, install sandboxed Google Play or use another browser.");
      expect(wakeSwitch()).toHaveAttribute("aria-disabled", "true");
      await user.click(wakeSwitch());
      await act(async () => { await Promise.resolve(); });
      expect(fake.subscribe).toHaveBeenCalledTimes(1);
      expect(wakeSwitch()).toHaveAttribute("aria-checked", "false");
    });

    it("Try again tries again: still none keeps it so; one found since (sandboxed Google Play installed) turns it on", async () => {
      localStorage.setItem(NO_PUSH_SERVICE_KEY, "1");
      let found = false;
      const fake = platform(async () => { if (!found) throw noService(); return keys; });
      const { user } = settings();
      await user.click(await screen.findByTestId("settings-wake-retry"));
      await waitFor(() => expect(fake.subscribe).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByTestId("settings-wake-retry")).not.toHaveAttribute("aria-busy"));
      expect(hint()).toHaveTextContent("This browser has no push service");
      expect(wakeSwitch()).toHaveAttribute("aria-disabled", "true");
      expect(localStorage.getItem(NO_PUSH_SERVICE_KEY)).toBe("1");

      found = true;
      await user.click(screen.getByTestId("settings-wake-retry"));
      await waitFor(() => expect(fakeEngine.callsTo("setWakeSubscription")).toHaveLength(1));
      expect(localStorage.getItem(NO_PUSH_SERVICE_KEY)).toBeNull();
      await waitFor(() => expect(screen.queryByTestId("settings-wake-retry")).toBeNull());
      expect(wakeSwitch()).not.toHaveAttribute("aria-disabled");
      expect(hint()).not.toHaveTextContent("no push service");
    });

    it("a refusal of notifications (NotAllowedError) is not that: its own line, the switch stays available, nothing kept", async () => {
      const fake = platform(async () => { throw denied(); });
      const { user } = settings();
      await user.click(await screen.findByTestId("settings-wake"));
      await waitFor(() => expect(fake.subscribe).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(hint()).toHaveTextContent("permission denied"));
      expect(hint()).not.toHaveTextContent("no push service");
      expect(wakeSwitch()).toHaveAttribute("aria-checked", "false");
      expect(wakeSwitch()).not.toHaveAttribute("aria-disabled");
      expect(screen.queryByTestId("settings-wake-retry")).toBeNull();
      expect(localStorage.getItem(NO_PUSH_SERVICE_KEY)).toBeNull();
    });
  });

  /*
   * New token while wake-ups are on: the web platform ends the old subscription before it makes the new one (a browser
   * refuses a second key while one is held), so a refused new one leaves contacts holding an endpoint that is gone.
   */
  describe("New token refused", () => {
    const settingsWith = (wake?: WakeSubscription) => ({ online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, ...(wake && { wake }) });
    const wakeOn = { ...keys, vapid: generateVapidKeys() };
    beforeEach(() => {
      fakeEngine.setState(engineState({ settings: settingsWith(wakeOn) }));
      fakeEngine.on("setWakeSubscription", ({ subscription }) => fakeEngine.setState(engineState({ settings: settingsWith(subscription ?? undefined) })));
    });

    it("for no push service, after the old subscription ended: wake-ups are off, and the row says why", async () => {
      const fake = platform(async () => { throw noService(); });
      const { user } = settings();
      await user.click(await screen.findByTestId("settings-wake-rotate"));
      await waitFor(() => expect(fake.subscribe).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(wakeSwitch()).toHaveAttribute("aria-checked", "false"));
      expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([{ subscription: null }]);
      expect(hint()).toHaveTextContent("This browser has no push service");
      expect(wakeSwitch()).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByTestId("settings-wake-retry")).toBeEnabled();
    });

    it("for another reason, after the old subscription ended: wake-ups are off, with the refusal's line", async () => {
      const fake = platform(async () => { throw new Error("Registration failed - storage error"); });
      const { user } = settings();
      await user.click(await screen.findByTestId("settings-wake-rotate"));
      await waitFor(() => expect(fake.subscribe).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(wakeSwitch()).toHaveAttribute("aria-checked", "false"));
      expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([{ subscription: null }]);
      expect(hint()).toHaveTextContent("storage error");
      expect(wakeSwitch()).not.toHaveAttribute("aria-disabled");
    });

    it("before the old subscription was touched (notifications refused): wake-ups stay on, with the refusal's line", async () => {
      const fake = platform(async () => { throw denied(); });
      fake.current.mockImplementation(async () => keys as never);
      const { user } = settings();
      await user.click(await screen.findByTestId("settings-wake-rotate"));
      await waitFor(() => expect(fake.subscribe).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(hint()).toHaveTextContent("permission denied"));
      expect(wakeSwitch()).toHaveAttribute("aria-checked", "true");
      expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([]);
    });

    it("for no push service with the old subscription still there: wake-ups stay on, and the line says why", async () => {
      const fake = platform(async () => { throw noService(); });
      fake.current.mockImplementation(async () => keys as never);
      const { user } = settings();
      await user.click(await screen.findByTestId("settings-wake-rotate"));
      await waitFor(() => expect(fake.subscribe).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByTestId("settings-wake-rotate")).not.toHaveAttribute("aria-busy"));
      expect(hint()).toHaveTextContent("This browser has no push service");
      expect(wakeSwitch()).toHaveAttribute("aria-checked", "true");
      expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([]);
    });
  });

  /*
   * Settings is not drawn again on a change of Language: a refusal's line under a switch is written in the language on
   * screen, not the one it was said in (it stayed in English under a page all in Portuguese until the switch was tapped).
   */
  describe("a refusal's line, after a change of Language further up the page", () => {
    const noRoom = () => new Error("Not enough space on this device (QuotaExceededError)");
    const choosePortuguese = async (user: ReturnType<typeof settings>["user"]) => {
      await user.click(screen.getByTestId("settings-language"));
      await user.click(await screen.findByRole("option", { name: /Português/ }));
      await screen.findByRole("heading", { name: "Aparência" });
    };

    it("Wake me while closed: in the new language", async () => {
      platform(async () => { throw noRoom(); });
      const { user } = settings();
      await user.click(await screen.findByTestId("settings-wake"));
      await waitFor(() => expect(hint()).toHaveTextContent("Not enough space on this device"));
      await choosePortuguese(user);
      expect(hint()).toHaveTextContent("Não há espaço suficiente neste dispositivo");
    });

    it("Notify me when a contact comes online: in the new language", async () => {
      platform(async () => keys);
      fakeEngine.on("setWakeOnline", () => { throw noRoom(); });
      fakeEngine.setState(engineState({ settings: { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, wake: { ...keys, vapid: generateVapidKeys() } } }));
      const { user } = settings();
      await user.click(await screen.findByTestId("settings-wake-online"));
      const line = () => screen.getByTestId("settings-wake-online-row");
      await waitFor(() => expect(line()).toHaveTextContent("Not enough space on this device"));
      await choosePortuguese(user);
      expect(line()).toHaveTextContent("Não há espaço suficiente neste dispositivo");
    });
  });

  describe("which refusals mean no push service", () => {
    it("AbortError, NotSupportedError or the words; never NotAllowedError or another error", () => {
      expect(isNoPushService(noService())).toBe(true);
      expect(isNoPushService(new DOMException("Push is not supported", "NotSupportedError"))).toBe(true);
      expect(isNoPushService(new Error("Registration failed - push service not available"))).toBe(true);
      expect(isNoPushService(denied())).toBe(false);
      expect(isNoPushService(new Error("Notifications are off for Ghostly in this browser. Allow them, then try again."))).toBe(false);
      expect(isNoPushService(undefined)).toBe(false);
    });

    it("a later refusal of another kind (notifications turned off) forgets it: it says nothing of the push service", async () => {
      localStorage.setItem(NO_PUSH_SERVICE_KEY, "1");
      platform(async () => { throw new Error("Notifications are off for Ghostly in this browser. Allow them, then try again."); });
      await expect(setWake(true)).rejects.toThrow("Notifications are off");
      expect(localStorage.getItem(NO_PUSH_SERVICE_KEY)).toBeNull();
    });
  });
});

// covers: push.wake.online
describe("the online notice switch", () => {
  /*
   * Settings → Notifications, "Notify me when a contact comes online" (WISP 401 § Wake-up push, revision 2026-10-27):
   * right under "Wake me while closed", shown while a subscription is shared (it rides on it), on by default, and it
   * can be turned off.
   */

  const settings = { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true };
  const keys = { endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "p", auth: "a" };
  const platform = () => ({ supported: () => true, subscribe: vi.fn(), current: vi.fn(async () => keys), unsubscribe: vi.fn(), syncTable: vi.fn(async () => {}) }) as unknown as PushPlatform;
  const renderSettings = () => renderApp(<LockScreenProvider><UpdateProvider><Settings /></UpdateProvider></LockScreenProvider>);

  afterEach(() => setPushPlatform(null));

  it("is not there while this profile is not woken", async () => {
    setPushPlatform(platform());
    fakeEngine.setState(engineState({ settings }));
    renderSettings();
    await screen.findByTestId("settings-wake");
    expect(screen.queryByTestId("settings-wake-online")).toBeNull();
  });

  it("is found by the search only while this profile is woken, as the switch is there only then", async () => {
    setPushPlatform(platform());
    fakeEngine.setState(engineState({ settings }));
    const { user } = renderSettings();
    const search = await screen.findByTestId("settings-index-search");
    await user.type(search, "comes online");
    expect(screen.getByTestId("settings-search-empty")).toBeInTheDocument();
    await act(async () => { fakeEngine.setState(engineState({ settings: { ...settings, wake: { ...keys, vapid: generateVapidKeys() } } })); });
    expect(screen.getAllByTestId("settings-search-result").map((row) => row.textContent)).toEqual(["Notify me when a contact comes onlineNotifications"]);
  });

  it("sits right under Wake me while closed, on by default, and turns off through the engine", async () => {
    setPushPlatform(platform());
    fakeEngine.on("setWakeSubscription", () => undefined);
    fakeEngine.on("wakeConfirm", () => undefined);
    fakeEngine.on("setWakeOnline", () => undefined);
    const wake = { ...keys, vapid: generateVapidKeys() };
    fakeEngine.setState(engineState({ settings: { ...settings, wake } }));
    const { user } = renderSettings();
    const toggle = await screen.findByTestId("settings-wake-online");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleName("Notify me when a contact comes online");
    // Right under the wake-up row, in the same section.
    const wakeRow = screen.getByTestId("settings-wake-row"), onlineRow = screen.getByTestId("settings-wake-online-row");
    expect(wakeRow.parentElement).toBe(onlineRow.parentElement);
    expect(wakeRow.compareDocumentPosition(onlineRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(toggle);
    await waitFor(() => expect(fakeEngine.callsTo("setWakeOnline")).toEqual([{ on: false }]));
    await act(async () => { fakeEngine.setState(engineState({ settings: { ...settings, wake, wakeOnline: false } })); });
    expect(screen.getByTestId("settings-wake-online")).toHaveAttribute("aria-checked", "false");
  });
});

// covers: push.wake.notify, push.wake.online
describe("the page closes its profile's stale wake-up notices", () => {
  /*
   * Wake-up notices of the installed web app used to stay in the system's list after the app was opened and the chat
   * read: no page code closed them (only the Android and Linux apps took a chat's notification back). Now the app in
   * front closes its profile's quiet notice, and a chat on screen closes it and that chat's "New message" and online notice,
   * through the profile's own push worker registration. A ringing call's notice stays, and so does every other
   * profile's notice: each profile's notices belong to its own worker.
   */

  interface Notice { tag: string; closed: boolean }

  /** The browser's push registrations, one per profile scope, each with the notices its worker shows. */
  function fakeBrowser(byProfile: Record<string, string[]>) {
    const registrations = new Map<string, { scope: string; notices: Notice[]; getNotifications(filter?: { tag?: string }): Promise<{ tag: string; close(): void }[]> }>();
    for (const [scopeName, tags] of Object.entries(byProfile)) {
      const notices = tags.map((tag) => ({ tag, closed: false }));
      const scope = new URL(`/push/${scopeName}/`, location.origin).href;
      registrations.set(scope, {
        scope, notices,
        async getNotifications(filter) {
          return notices.filter((notice) => !notice.closed && (!filter?.tag || notice.tag === filter.tag)).map((notice) => ({ tag: notice.tag, close: () => { notice.closed = true; } }));
        },
      });
    }
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async (scope: string) => registrations.get(scope) } });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    const open = (scopeName: string) => registrations.get(new URL(`/push/${scopeName}/`, location.origin).href)!.notices.filter((notice) => !notice.closed).map((notice) => notice.tag);
    return { open };
  }

  function platform(overrides: Partial<PushPlatform> = {}): PushPlatform {
    return {
      supported: () => true, subscribe: vi.fn(), current: vi.fn(async () => null), unsubscribe: vi.fn(), syncTable: vi.fn(async () => {}),
      closeNotices: closeInBrowser, closeOnlineNotices: closeOnlineInBrowser, ...overrides,
    } as PushPlatform;
  }

  const PEER = "a".repeat(52);
  let focused = true;
  const blur = (next: boolean) => act(() => { focused = !next; window.dispatchEvent(new Event(next ? "blur" : "focus")); });
  const moment = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });

  const DEFAULT_NOTICES = [
    "quiet:", "wake::/chat/chat-1", "wake-online::/chat/chat-1", "wake-call::/chat/chat-1",
    "wake::/chat/chat-2", "wake-online::/chat/chat-2", "wake::/group/group-1",
  ];
  const WORK_NOTICES = ["quiet:work1", "wake:work1:/chat/chat-1", "wake-online:work1:/chat/chat-1"];

  beforeEach(() => {
    focused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    refreshWindowAway();
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: Date.now() - 1000 });
    fakeEngine.update({ links: [linkView({ id: "link-a", peerPubKeyZ32: PEER })] });
  });
  afterEach(() => {
    setPushPlatform(null);
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    delete (window as unknown as Record<string, unknown>).isSecureContext;
    vi.restoreAllMocks();
    refreshWindowAway();
  });

  it("a chat's: its message and online notices go; another chat's, a ringing call's and another profile's stay", async () => {
    const browser = fakeBrowser({ default: DEFAULT_NOTICES, work1: WORK_NOTICES });
    await closeInBrowser("", "/chat/chat-1");
    expect(browser.open("default")).toEqual(["wake-call::/chat/chat-1", "wake::/chat/chat-2", "wake-online::/chat/chat-2", "wake::/group/group-1"]);
    expect(browser.open("work1")).toEqual(WORK_NOTICES);
    // With no chat: the quiet notice alone.
    await closeInBrowser("work1");
    expect(browser.open("work1")).toEqual(["wake:work1:/chat/chat-1", "wake-online:work1:/chat/chat-1"]);
  });

  it("a profile with no push worker, or a browser without one: nothing to close, nothing thrown", async () => {
    fakeBrowser({ default: DEFAULT_NOTICES });
    await expect(closeInBrowser("never-woken", "/chat/chat-1")).resolves.toBeUndefined();
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    await expect(closeInBrowser("", "/chat/chat-1")).resolves.toBeUndefined();
  });

  it("opening a chat in a window that has the focus closes that chat's notices; behind another app's window they stay until it gets the focus", async () => {
    const browser = fakeBrowser({ default: DEFAULT_NOTICES, work1: WORK_NOTICES });
    setPushPlatform(platform());
    blur(true);
    renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    await moment();
    expect(browser.open("default")).toEqual(DEFAULT_NOTICES);
    blur(false);
    await waitFor(() => expect(browser.open("default")).toEqual(["wake-call::/chat/chat-1", "wake::/chat/chat-2", "wake-online::/chat/chat-2", "wake::/group/group-1"]));
    expect(browser.open("work1")).toEqual(WORK_NOTICES);
  });

  it("a group on screen closes the group's notice", async () => {
    const browser = fakeBrowser({ default: DEFAULT_NOTICES });
    setPushPlatform(platform());
    fakeEngine.on("groupMessages", () => []);
    fakeEngine.update({ groups: [groupView({ status: "active", epoch: 1 })] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    await waitFor(() => expect(browser.open("default")).not.toContain("wake::/group/group-1"));
    expect(browser.open("default")).toEqual(["wake::/chat/chat-1", "wake-online::/chat/chat-1", "wake-call::/chat/chat-1", "wake::/chat/chat-2", "wake-online::/chat/chat-2"]);
  });

  it("the app in front closes the profile's quiet notice, at start and when it comes back; away, it stays", async () => {
    const browser = fakeBrowser({ default: DEFAULT_NOTICES, work1: WORK_NOTICES });
    const closeNotices = vi.fn(closeInBrowser);
    setPushPlatform(platform({ closeNotices }));
    blur(true);
    renderHook(() => useWakeTableSync({ title: "Ghostly", body: "New message" }));
    await moment();
    expect(closeNotices).not.toHaveBeenCalled();
    blur(false);
    await waitFor(() => expect(browser.open("default")).not.toContain("quiet:"));
    expect(closeNotices).toHaveBeenCalledWith("", undefined);
    expect(browser.open("default")).toEqual(DEFAULT_NOTICES.filter((tag) => tag !== "quiet:"));
    expect(browser.open("work1")).toEqual(WORK_NOTICES);
  });

  it("turning the lock screen on closes the profile's online notices, which name a contact (WISP 04); the others stay", async () => {
    const browser = fakeBrowser({ default: DEFAULT_NOTICES, work1: WORK_NOTICES });
    setPushPlatform(platform());
    blur(true);
    renderHook(() => useWakeTableSync({ title: "Ghostly", body: "New message" }));
    await moment();
    expect(browser.open("default")).toEqual(DEFAULT_NOTICES);
    const settings = loadSettings();
    act(() => saveSettings({ ...settings, lockScreen: { ...settings.lockScreen, enabled: true, passwordHash: "hash" } }));
    await waitFor(() => expect(browser.open("default")).toEqual(DEFAULT_NOTICES.filter((tag) => !tag.startsWith("wake-online:"))));
    expect(browser.open("work1")).toEqual(WORK_NOTICES);
  });
});

// covers: push.wake.call
describe("calling a contact whose app is closed", () => {
  afterEach(() => vi.useRealTimers());

  it("wakes it, then places the call (with video if asked) once the chat can call", async () => {
    fakeEngine.on("wakeForCall", () => true);
    const place = vi.fn();
    const { result, rerender } = renderHook(({ possible }) => useWakeCall("link-1", possible, place), { initialProps: { possible: false } });
    await act(() => result.current.ring(true));
    expect(fakeEngine.callsTo("wakeForCall")).toEqual([{ linkId: "link-1" }]);
    expect(result.current.waking).toBe(true);
    expect(place).not.toHaveBeenCalled();
    rerender({ possible: true });
    await waitFor(() => expect(place).toHaveBeenCalledWith(true));
    expect(result.current.waking).toBe(false);
  });

  it("gives up after the wait, and cancel stops it", async () => {
    vi.useFakeTimers();
    fakeEngine.on("wakeForCall", () => true);
    const place = vi.fn();
    const { result } = renderHook(() => useWakeCall("link-1", false, place));
    await act(() => result.current.ring(false));
    expect(result.current.waking).toBe(true);
    act(() => { vi.advanceTimersByTime(WAKE_CALL_WAIT_MS + 10); });
    expect(result.current.waking).toBe(false);
    expect(result.current.gaveUp).toBe(true);
    await act(() => result.current.ring(false));
    act(() => result.current.cancel());
    expect(result.current.waking).toBe(false);
    expect(place).not.toHaveBeenCalled();
  });

  it("a call taken in another chat meanwhile cancels the wake: nothing is placed behind it", async () => {
    fakeEngine.on("wakeForCall", () => true);
    // As `startCall` does while another call is on: it returns at once, nothing rings.
    const place = vi.fn();
    const { result, rerender } = renderHook(({ possible }) => useWakeCall("link-1", possible, place), { initialProps: { possible: false } });
    await act(() => result.current.ring(false));
    expect(result.current.waking).toBe(true);
    const other = Symbol("other chat");
    try {
      act(() => setCallOn(other, () => {}));
      expect(result.current.waking).toBe(false);
      rerender({ possible: true });
      expect(place).not.toHaveBeenCalled();
    } finally {
      act(() => setCallOn(other, null));
    }
  });

  it("a contact that cannot be woken: it says so at once", async () => {
    fakeEngine.on("wakeForCall", () => false);
    const { result } = renderHook(() => useWakeCall("link-1", false, vi.fn()));
    await act(() => result.current.ring(false));
    expect(result.current.waking).toBe(false);
    expect(result.current.gaveUp).toBe(true);
  });
});

// covers: push.wake.call
describe("a call that wakes a contact who is away", () => {
  const PEER = "peer".padEnd(52, "p");

  /**
   * Calling a contact whose app is closed waits up to a minute for it to wake. The wait lived in the chat, which `App`
   * keeps loaded only while it is on a call: leaving the chat meanwhile dropped it without a word, no call was ever
   * placed, and the contact's phone had already said "Incoming call". Now waking counts as a call on its way: the chat
   * stays loaded, and its notice, with Cancel, shows wherever the person is, as a call's own window does.
   */
  describe("waking a contact for a call, then leaving the chat", () => {
    it("keeps the chat loaded, and shows the wait with its Cancel over what is on screen", async () => {
      saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
      const layer = document.createElement("div");
      document.body.append(layer);
      const onCallChange = vi.fn();
      const props = { sessionId: "chat-1", onCallChange, callLayer: layer };
      const { user, engine, rerender } = renderApp(<Chat {...props} visible />);
      engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("wakeForCall", () => true);
      // Its app is closed: no live session, but it shared how to wake it.
      act(() => engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "connecting" }, dataLink: "idle", peerWakes: true } as never)] }));

      await user.click(await screen.findByTestId("call-audio"));
      expect(engine.callsTo("wakeForCall")).toEqual([{ linkId: "link-1" }]);
      expect(await screen.findByTestId("wake-call")).toHaveAttribute("data-state", "waking");
      // A call on its way: `App` keeps the chat loaded for it.
      expect(onCallChange).toHaveBeenLastCalledWith("chat-1", true);

      // The person opens another chat: this one's column is hidden, and the wait shows over what is there.
      rerender(<Chat {...props} visible={false} />);
      expect(onCallChange).toHaveBeenLastCalledWith("chat-1", true);
      const notice = within(layer).getByTestId("wake-call");
      expect(notice).toHaveAttribute("data-state", "waking");
      expect(notice).toHaveTextContent("Ana");
      await user.click(within(layer).getByTestId("wake-call-cancel"));
      expect(within(layer).queryByTestId("wake-call")).toBeNull();
      // Cancelled: nothing on its way any more, and the chat may go.
      expect(onCallChange).toHaveBeenLastCalledWith("chat-1", false);
      layer.remove();
    });
  });

  /**
   * With Ghostly offline (its own switch) no wake-up can go out: the engine refuses it at once. The call buttons said
   * nothing of it, and a press put up "Ana did not open Ghostly." as if the contact had been woken and stayed away.
   */
  describe("calling a contact whose app is closed, with Ghostly offline", () => {
    it("leaves the call buttons off with the reason, and says nothing about the contact", async () => {
      saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
      const { user, engine } = renderApp(<Chat sessionId="chat-1" onCallChange={vi.fn()} callLayer={null} visible />);
      engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("wakeForCall", () => false);
      act(() => engine.update({
        settings: { online: false },
        links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "connecting" }, dataLink: "idle", peerWakes: true } as never)],
      }));

      const call = await screen.findByTestId("call-audio");
      expect(call).toHaveAttribute("aria-disabled", "true");
      expect(call).toHaveAccessibleDescription("Calls need a live connection");
      await user.click(call);
      expect(engine.callsTo("wakeForCall")).toEqual([]);
      expect(screen.queryByTestId("wake-call")).toBeNull();
    });

    it("or with this app unable to call at all: the contact is not woken for a call that cannot start", async () => {
      saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
      const { user, engine } = renderApp(<Chat sessionId="chat-1" onCallChange={vi.fn()} callLayer={null} visible />);
      engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("wakeForCall", () => true);
      // The Linux Desktop without GStreamer's plugins: the engine names what to install, live or not.
      const missing = "Calls need GStreamer's good plugins: install gst-plugins-good.";
      act(() => engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "connecting" }, dataLink: "idle", peerWakes: true, callsUnavailable: missing } as never)] }));

      const call = await screen.findByTestId("call-audio");
      expect(call).toHaveAttribute("aria-disabled", "true");
      expect(call).toHaveAccessibleDescription(missing);
      await user.click(call);
      expect(engine.callsTo("wakeForCall")).toEqual([]);
      expect(screen.queryByTestId("wake-call")).toBeNull();
      expect(await screen.findByTestId("call-blocked")).toHaveTextContent(missing);
    });

    it("or with Hide my IP on and call media that cannot keep to the relay: the buttons say calls are off, and nobody is woken", async () => {
      // The Linux Desktop's own call engine (desktop/nativeCalls.ts): it gathers this device's addresses.
      const native = { createPeerConnection: vi.fn(), getUserMedia: vi.fn() };
      const platform = servicesPlatform as { callMedia?: () => unknown };
      platform.callMedia = () => native;
      try {
        saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
        const { user, engine } = renderApp(<Chat sessionId="chat-1" onCallChange={vi.fn()} callLayer={null} visible />);
        engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("wakeForCall", () => true);
        // Not live yet, as a chat whose transports are off with Hide my IP stays: the engine's reason is the live one.
        act(() => engine.update({
          settings: { relayOnly: true },
          links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "connecting" }, dataLink: "idle", peerWakes: true, callsUnavailable: "Calls need a live connection" } as never)],
        }));

        const call = await screen.findByTestId("call-audio");
        expect(call).toHaveAttribute("aria-disabled", "true");
        expect(call).toHaveAccessibleDescription("Calls are off while Hide my IP is on");
        await user.click(call);
        expect(engine.callsTo("wakeForCall")).toEqual([]);
        expect(screen.queryByTestId("wake-call")).toBeNull();
        expect(native.createPeerConnection).not.toHaveBeenCalled();
        expect(await screen.findByTestId("call-blocked")).toHaveTextContent("Calls are off while Hide my IP is on");
      } finally {
        delete platform.callMedia;
      }
    });

    it("or with the device offline: no minute's wait for a wake-up that cannot go", async () => {
      const offline = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
      try {
        saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
        const { user, engine } = renderApp(<Chat sessionId="chat-1" onCallChange={vi.fn()} callLayer={null} visible />);
        engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("wakeForCall", () => true);
        act(() => engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "connecting" }, dataLink: "idle", peerWakes: true } as never)] }));

        const call = await screen.findByTestId("call-audio");
        expect(call).toHaveAttribute("aria-disabled", "true");
        await user.click(call);
        expect(engine.callsTo("wakeForCall")).toEqual([]);
        expect(screen.queryByTestId("wake-call")).toBeNull();
      } finally {
        offline.mockRestore();
      }
    });
  });
});

// covers: push.wake.call, app.i18n
describe("the wake-up notice of a call, in Arabic", () => {
  /**
   * Calling a contact whose app is closed, in Arabic: "Waking Ana (2) for the call…" and "Ana (2) did not open Ghostly."
   * put the contact's name in plainly, so its bracket group took the sentence's right-to-left direction and was drawn on
   * the other side of the Latin name ("(2) Ana"), and a Latin name ran into "Ghostly" after it as one left-to-right run.
   * Each is its own <bdi> now, as the call's other notices have it.
   */

  const PEER = "peer".padEnd(52, "p");

  it.each([
    [true, "waking", "جارٍ إيقاظ Ana (2) للمكالمة…"],
    [false, "gave-up", "لم يفتح Ana (2) Ghostly."],
  ])("isolates the contact's name (woken: %s)", async (woken, state, text) => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana (2)", messages: [], createdAt: 1_700_000_000_000 });
    const { user, engine } = renderApp(<Chat sessionId="chat-1" onCallChange={vi.fn()} callLayer={null} visible />, { language: "ar" });
    engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("wakeForCall", () => woken);
    act(() => engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "connecting" }, dataLink: "idle", peerWakes: true } as never)] }));

    await user.click(await screen.findByTestId("call-audio"));
    const notice = await screen.findByTestId("wake-call");
    expect(notice).toHaveAttribute("data-state", state);
    expect(notice).toHaveTextContent(text);
    expect([...notice.querySelectorAll("bdi")].map((bdi) => bdi.textContent)).toEqual(["Ana (2)"]);
  });
});
