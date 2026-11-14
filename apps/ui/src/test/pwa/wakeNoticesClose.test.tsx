import { act, renderHook, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOnlineWakeNotices as closeOnlineInBrowser, closeWakeNotices as closeInBrowser } from "../../../../web/src/pwa/push";
import { loadSettings, saveSettings } from "../../lib/settings";
import { saveSession } from "../../lib/storage";
import { setPushPlatform, useWakeTableSync, type PushPlatform } from "../../lib/wakePush";
import { refreshWindowAway } from "../../lib/windowAway";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: push.wake.notify, push.wake.online

/*
 * Wake-up notices of the installed web app used to stay in the system's list after the app was opened and the chat
 * read: no page code closed them (only the Android and Linux apps took a chat's notification back). Now the app in
 * front closes its profile's quiet notice, and a chat on screen closes it and that chat's "New message" and online notice,
 * through the profile's own push worker registration. A ringing call's notice stays, and so does every other
 * profile's notice: each profile's notices belong to its own worker.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

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

describe("the page closes its profile's stale wake-up notices", () => {
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
