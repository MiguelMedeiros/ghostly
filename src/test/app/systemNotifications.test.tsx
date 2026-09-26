import { act, screen, waitFor } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionEvent } from "@ghostly/browser/shared/rpc";
import { AttentionFeedback } from "../../components/AttentionFeedback";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { loadSettings, saveSettings } from "../../lib/settings";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Settings } from "../../pages/Settings";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.attention.notifications, desktop.notifications

/*
 * System notifications on each platform: whether the Settings switch is available, what asking for permission
 * does (default, granted, denied), where a notification goes (the web API, the extension's, the Desktop app's
 * native command or the plugin) and what a click on one opens.
 */

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined),
  /** The Desktop app's `notification-open` listener, once the page listens. */
  opened: undefined as ((event: { payload: string }) => void) | undefined,
  plugin: { isPermissionGranted: vi.fn(async () => true), requestPermission: vi.fn(async () => "granted"), sendNotification: vi.fn() },
}));
// The UI tests alias every `@tauri-apps/api/*` to one stand-in (packages/browser/src/platform/tauri.ts): one mock.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  listen: async (_name: string, handler: (event: { payload: string }) => void) => { tauri.opened = handler; return () => {}; },
  getVersion: async () => "0.4.0",
}));
vi.mock("@tauri-apps/plugin-notification", () => tauri.plugin);

/** The web Notification API, scripted: its permission, what asking answers, and the notifications shown. */
class FakeNotification {
  static permission: NotificationPermission = "default";
  static answer: NotificationPermission = "granted";
  static shown: FakeNotification[] = [];
  static requestPermission = vi.fn(async () => (FakeNotification.permission = FakeNotification.answer));
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(public title: string, public options: NotificationOptions) { FakeNotification.shown.push(this); }
}

type Lib = typeof import("../../lib/notifications");
/** A fresh copy of the module: which clicks it listens to is decided once per page, as in the app. */
async function lib(): Promise<Lib> {
  vi.resetModules();
  return import("../../lib/notifications");
}

/**
 * Runs as the Desktop app on `os` (the page sees `__TAURI_INTERNALS__`), with the native commands answering `answers`.
 * `commands()` lists the calls made since.
 */
function desktop(os: "MacIntel" | "Win32" | "Linux x86_64", answers: Record<string, unknown> = {}) {
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  vi.spyOn(navigator, "platform", "get").mockReturnValue(os);
  tauri.invoke.mockClear();
  tauri.invoke.mockImplementation(async (command: string) => {
    const answer = answers[command];
    if (answer instanceof Error) throw answer;
    return answer;
  });
}
const commands = () => tauri.invoke.mock.calls.map(([command, args]) => (args === undefined ? [command] : [command, args]));

beforeEach(() => {
  FakeNotification.permission = "default";
  FakeNotification.answer = "granted";
  FakeNotification.shown = [];
  vi.stubGlobal("Notification", FakeNotification);
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  delete (globalThis as { chrome?: unknown }).chrome;
  vi.unstubAllGlobals();
  tauri.invoke.mockReset();
  tauri.opened = undefined;
  for (const fn of Object.values(tauri.plugin)) fn.mockClear();
});

describe("availability and the permission, by platform", () => {
  it("web: follows the browser's permission, and is unavailable without the Notification API", async () => {
    const { notificationPermission, requestNotifications, noticeSettings } = await lib();
    expect(await notificationPermission()).toBe("default");
    FakeNotification.answer = "denied";
    expect(await requestNotifications()).toBe("denied");
    expect(await notificationPermission()).toBe("denied");
    expect(noticeSettings()).toBeUndefined();
    vi.stubGlobal("Notification", undefined);
    expect(await notificationPermission()).toBe("unavailable");
    expect(await requestNotifications()).toBe("unavailable");
  });

  it("Desktop on macOS: asks the native command, never the web API, and knows its settings pane", async () => {
    const { notificationPermission, requestNotifications, noticeSettings } = await lib();
    desktop("MacIntel", { native_notification_permission: "default" });
    expect(await notificationPermission()).toBe("default");
    desktop("MacIntel", { native_notification_permission: "granted" });
    expect(await requestNotifications()).toBe("granted");
    desktop("MacIntel", { native_notification_permission: "denied" });
    expect(await requestNotifications()).toBe("denied");
    expect(commands()).toEqual([["native_notification_permission", { request: true }]]);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(noticeSettings()).toBe("macos");
  });

  it("Desktop on Windows and Linux: the plugin decides; Windows has a settings page to open, Linux none", async () => {
    const { notificationPermission, requestNotifications, noticeSettings } = await lib();
    desktop("Win32", { native_notification_permission: null });
    expect(await notificationPermission()).toBe("granted");
    expect(await requestNotifications()).toBe("granted");
    expect(tauri.plugin.requestPermission).toHaveBeenCalledTimes(1);
    expect(noticeSettings()).toBe("windows");
    desktop("Linux x86_64", { native_notification_permission: null });
    expect(noticeSettings()).toBeUndefined();
  });

  it("Desktop: a native command that fails reads as unavailable, not as a crash", async () => {
    const { notificationPermission, requestNotifications } = await lib();
    desktop("MacIntel", { native_notification_permission: new Error("Notification authorization unavailable") });
    expect(await notificationPermission()).toBe("unavailable");
    expect(await requestNotifications()).toBe("unavailable");
  });

  it("Desktop: opens the system's notification settings through its own command", async () => {
    const { openNoticeSettings } = await lib();
    desktop("MacIntel", { open_notification_settings: undefined });
    await openNoticeSettings();
    expect(commands()).toEqual([["open_notification_settings"]]);
    // Nothing to open (Linux): the button is not shown, and a failure is quiet.
    desktop("Linux x86_64", { open_notification_settings: new Error("No notification settings to open") });
    await expect(openNoticeSettings()).resolves.toBeUndefined();
  });
});

describe("where a notification goes, and what a click opens", () => {
  it("web: one private notification, and a click focuses the page and opens its chat", async () => {
    const { showPrivateNotification, onNotificationOpen } = await lib();
    const opened = vi.fn();
    onNotificationOpen(opened);
    FakeNotification.permission = "granted";
    await showPrivateNotification("event-1", "New message", "chat-a");
    expect(FakeNotification.shown).toHaveLength(1);
    expect(FakeNotification.shown[0]).toMatchObject({ title: "Ghostly", options: { body: "New message", tag: "event-1", silent: true } });
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    FakeNotification.shown[0]!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(opened).toHaveBeenCalledWith("chat-a");
    expect(FakeNotification.shown[0]!.close).toHaveBeenCalled();
  });

  it("web: shows nothing without the permission", async () => {
    const { showPrivateNotification } = await lib();
    FakeNotification.permission = "denied";
    await showPrivateNotification("event-1", "New message", "chat-a");
    expect(FakeNotification.shown).toEqual([]);
  });

  it("Desktop on macOS: the native command shows it; a click names the notification and opens its chat", async () => {
    const { showPrivateNotification, onNotificationOpen } = await lib();
    desktop("MacIntel", { native_notification_permission: "granted", native_private_notification: true });
    const opened = vi.fn();
    const stop = onNotificationOpen(opened);
    await showPrivateNotification("event-1", "New message", "group:g1");
    await showPrivateNotification("event-2", "New message");
    expect(commands()).toContainEqual(["native_private_notification", { id: "event-1", body: "New message" }]);
    expect(tauri.plugin.sendNotification).not.toHaveBeenCalled();
    expect(FakeNotification.shown).toEqual([]);
    await waitFor(() => expect(tauri.opened).toBeDefined());
    // One without a chat, or one from before a restart: the app comes forward (Rust), no chat opens.
    tauri.opened!({ payload: "event-2" });
    tauri.opened!({ payload: "event-9" });
    expect(opened).not.toHaveBeenCalled();
    tauri.opened!({ payload: "event-1" });
    expect(opened).toHaveBeenCalledWith("group:g1");
    // Opened once: a second click on the same one does nothing more.
    tauri.opened!({ payload: "event-1" });
    expect(opened).toHaveBeenCalledTimes(1);
    stop();
  });

  it("Desktop on Windows and Linux: the plugin shows it", async () => {
    const { showPrivateNotification } = await lib();
    desktop("Win32", { native_notification_permission: null, native_private_notification: false });
    await showPrivateNotification("event-1", "New message", "chat-a");
    expect(tauri.plugin.sendNotification).toHaveBeenCalledWith({ title: "Ghostly", body: "New message", silent: true });
  });

  it("extension: chrome.notifications, and a click on one of this page's opens its chat", async () => {
    let clicked: ((id: string) => void) | undefined;
    const chrome = {
      runtime: { id: "ext", getURL: (path: string) => `chrome-extension://ext/${path}` },
      permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
      notifications: { create: vi.fn(async (id: string) => id), clear: vi.fn(async () => true), onClicked: { addListener: (listener: (id: string) => void) => { clicked = listener; } } },
    };
    (globalThis as { chrome?: unknown }).chrome = chrome;
    const { showPrivateNotification, onNotificationOpen } = await lib();
    const opened = vi.fn();
    onNotificationOpen(opened);
    vi.spyOn(window, "focus").mockImplementation(() => {});
    await showPrivateNotification("event-1", "New message", "chat-a");
    expect(chrome.notifications.create).toHaveBeenCalledWith("event-1", expect.objectContaining({ title: "Ghostly", message: "New message", silent: true }));
    // Another page's notification: this page does nothing.
    clicked!("event-other");
    expect(opened).not.toHaveBeenCalled();
    expect(chrome.notifications.clear).not.toHaveBeenCalled();
    clicked!("event-1");
    expect(opened).toHaveBeenCalledWith("chat-a");
    expect(chrome.notifications.clear).toHaveBeenCalledWith("event-1");
  });
});

describe("Settings → System notifications", () => {
  function renderSettings() {
    return renderApp(
      <LockScreenProvider><UpdateProvider><Routes><Route path="/settings" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>,
      { route: "/settings" },
    );
  }
  const row = () => screen.getByTestId("settings-system-notifications-row");
  const toggle = () => screen.getByTestId("settings-system-notifications");

  it("Desktop on macOS: available; turning it on asks macOS, and granted turns it on", async () => {
    desktop("MacIntel", { native_notification_permission: "default" });
    const { user } = renderSettings();
    await waitFor(() => expect(row()).toHaveTextContent("While Ghostly is open"));
    expect(toggle()).toBeEnabled();
    tauri.invoke.mockImplementation(async (command: string, args?: unknown) =>
      command === "native_notification_permission" ? ((args as { request: boolean }).request ? "granted" : "default") : undefined);
    await user.click(toggle());
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"));
    expect(commands()).toContainEqual(["native_notification_permission", { request: true }]);
    expect(loadSettings().notifications.systemEnabled).toBe(true);
    expect(screen.queryByTestId("settings-notification-settings")).toBeNull();
  });

  it("Desktop on macOS, denied: one line saying where to allow them, and a button that opens that pane", async () => {
    desktop("MacIntel", { native_notification_permission: "default" });
    const { user } = renderSettings();
    await waitFor(() => expect(row()).toHaveTextContent("While Ghostly is open"));
    desktop("MacIntel", { native_notification_permission: "denied" });
    await user.click(toggle());
    await waitFor(() => expect(row()).toHaveTextContent("Allow them in macOS Settings → Notifications → Ghostly"));
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(loadSettings().notifications.systemEnabled).toBe(false);
    await user.click(screen.getByTestId("settings-notification-settings"));
    expect(commands()).toContainEqual(["open_notification_settings"]);
  });

  it("Desktop on Windows, denied: its own settings; on Linux the general line and no button", async () => {
    desktop("Win32", { native_notification_permission: "denied" });
    const { unmount } = renderSettings();
    await waitFor(() => expect(row()).toHaveTextContent("Allow them in Windows Settings → Notifications"));
    expect(screen.getByTestId("settings-notification-settings")).toBeInTheDocument();
    unmount();
    desktop("Linux x86_64", { native_notification_permission: "denied" });
    renderSettings();
    await waitFor(() => expect(row()).toHaveTextContent("Blocked. Allow them in device or browser settings."));
    expect(screen.queryByTestId("settings-notification-settings")).toBeNull();
  });

  it("web: blocked in the browser has no button; no Notification API says so", async () => {
    FakeNotification.permission = "denied";
    const { unmount } = renderSettings();
    await waitFor(() => expect(row()).toHaveTextContent("Blocked. Allow them in device or browser settings."));
    expect(screen.queryByTestId("settings-notification-settings")).toBeNull();
    unmount();
    vi.stubGlobal("Notification", undefined);
    renderSettings();
    await waitFor(() => expect(row()).toHaveTextContent("Not available here"));
  });
});

describe("AttentionFeedback: which chat a notification opens", () => {
  const key = (c: string) => c.repeat(52);
  const chat = (id: string): ChatSession => ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", messages: [], createdAt: Date.now() });
  let n = 0;
  const event = (patch: Partial<AttentionEvent>): AttentionEvent => ({ id: `note-${++n}`, type: "message", at: Date.now(), ...patch });
  function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }

  it("a click on a message's notification opens its 1:1 chat or its group", async () => {
    FakeNotification.permission = "granted";
    saveSettings({ ...loadSettings(), notifications: { ...loadSettings().notifications, soundEnabled: false, systemEnabled: true } });
    saveSession(chat("a"));
    fakeEngine.update({ links: [linkView({ id: "link-a", peerPubKeyZ32: key("a") })] });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    renderApp(<><AttentionFeedback /><Routes><Route path="*" element={<Where />} /></Routes></>);
    const first = event({ linkId: "link-a" }), second = event({ linkId: "group:g1" });
    act(() => { fakeEngine.emit({ kind: "attention", event: first }); fakeEngine.emit({ kind: "attention", event: second }); });
    await waitFor(() => expect(FakeNotification.shown).toHaveLength(2));
    // The text is private; the chat stays in the page.
    expect(FakeNotification.shown.map(n => [n.options.tag, n.options.body])).toEqual([[first.id, "New message"], [second.id, "New message"]]);
    vi.spyOn(window, "focus").mockImplementation(() => {});
    act(() => FakeNotification.shown[0]!.onclick!());
    expect(screen.getByTestId("where")).toHaveTextContent("/chat/a");
    act(() => FakeNotification.shown[1]!.onclick!());
    expect(screen.getByTestId("where")).toHaveTextContent("/group/g1");
  });
});
