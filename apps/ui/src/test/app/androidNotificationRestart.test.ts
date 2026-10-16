import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// covers: app.attention.notifications

/*
 * Android keeps the app's notifications when its process ends (swiped from Recents, ended in the background, an
 * update), and a tap on one is what starts the next page. That page now reads which chat each of its chats' tags opens
 * (kept in the profile's storage, never in the notification), opens the chat of the tap that started it (Rust keeps it
 * until the page listens), and takes away only the notifications it cannot map: the other chats' stay, and it replaces
 * and takes them away as its own.
 */

const tauri = vi.hoisted(() => ({
  calls: [] as { command: string; args?: Record<string, unknown> }[],
  /** Holds `native_clear_notifications` until let go. */
  sweep: undefined as Promise<void> | undefined,
  /** The tap Rust keeps for the page (`native_notification_tap`). */
  tap: null as string | null,
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    tauri.calls.push({ command, args });
    if (command === "native_notification_permission") return "granted";
    if (command === "native_private_notification") return true;
    if (command === "native_clear_notifications") await tauri.sweep;
    if (command === "native_notification_tap") {
      const tap = tauri.tap;
      tauri.tap = null;
      return tap;
    }
    return undefined;
  },
  // The UI config aliases @tauri-apps/api/event to the same stub as core: one mock serves both.
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    tauri.handlers.set(event, handler);
    return () => tauri.handlers.delete(event);
  },
  getVersion: async () => "0.4.0",
}));

const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36";
/** A page start: the module as a new page loads it. */
const page = async () => {
  vi.resetModules();
  tauri.handlers.clear();
  return await import("../../lib/notifications");
};
const calls = (command: string) => tauri.calls.filter(call => call.command === command);
const sweeps = () => calls("native_clear_notifications").length;
const posted = () => calls("native_private_notification").map(call => call.args!.id as string);
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

beforeEach(() => {
  tauri.calls.length = 0;
  tauri.sweep = undefined;
  tauri.tap = null;
  localStorage.clear();
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID);
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("Android: the notifications an earlier page left", () => {
  it("go once, before the page's own first one is posted", async () => {
    let release!: () => void;
    tauri.sweep = new Promise(resolve => { release = resolve; });
    const run = await page();
    const shown = run.showPrivateNotification("message:link-a:m1", "New message", "chat-1", true);
    await tick();
    expect(sweeps()).toBe(1);
    expect(posted()).toEqual([]);
    release();
    await shown;
    await run.showPrivateNotification("message:link-a:m2", "New message", "chat-1", true);
    expect(posted()).toHaveLength(2);
    expect(sweeps()).toBe(1);
  });

  it("a page whose app cannot take them (an older app) still posts", async () => {
    tauri.sweep = Promise.reject(new Error("unknown command"));
    tauri.sweep.catch(() => {});
    const run = await page();
    await run.showPrivateNotification("message:link-a:m1", "New message", "chat-1", true);
    expect(posted()).toHaveLength(1);
  });

  it("only in the Android and Linux apps: macOS takes its own away, and a browser's page has none left", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15");
    const mac = await page();
    mac.onNotificationOpen(() => {});
    await mac.showPrivateNotification("message:link-a:m1", "New message", "chat-1", true);
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID);
    (await page()).onNotificationOpen(() => {});
    await tick();
    expect(sweeps()).toBe(0);
  });

  it("a tap on one, which starts the next page, opens its chat, and the other chats' stay", async () => {
    const first = await page();
    await first.showPrivateNotification("message:link-a:m1", "New message", "chat-1", true);
    await first.showPrivateNotification("message:link-b:m1", "New message", "chat-2", true);
    await first.showPrivateNotification("call:chat-3:1", "Incoming call", "chat-3");
    const [one, two] = posted();
    // The process ends; the person taps chat-1's notification, which Android kept: the next page starts.
    tauri.tap = one;
    const next = await page();
    const opened: string[] = [];
    next.onNotificationOpen(chat => opened.push(chat));
    await tick();
    expect(opened).toEqual(["chat-1"]);
    // The first page swept as it posted; the next one keeps both chats' (the call's goes).
    expect(calls("native_clear_notifications").map(call => call.args)).toEqual([{ keep: [one] }, { keep: [one, two] }]);
    // Its next message replaces chat-2's notification, and reading chat-1 takes the tapped one's tag away.
    await next.showPrivateNotification("message:link-b:m2", "New message", "chat-2", true);
    expect(posted().slice(-1)).toEqual([two]);
    next.clearChatNotification("chat-1");
    expect(calls("native_clear_notification").map(call => call.args)).toEqual([{ id: one }]);
  });

  it("a tap while the page runs is taken from Rust once", async () => {
    const run = await page();
    const opened: string[] = [];
    run.onNotificationOpen(chat => opened.push(chat));
    await run.showPrivateNotification("message:link-a:m1", "New message", "chat-1", true);
    await tick();
    tauri.tap = posted()[0];
    tauri.handlers.get("notification-open")!({ payload: posted()[0] });
    await tick();
    expect(opened).toEqual(["chat-1"]);
    // Taken: the next page does not open it again.
    const next = await page();
    next.onNotificationOpen(chat => opened.push(chat));
    await tick();
    expect(opened).toEqual(["chat-1"]);
  });

  it("another profile's tags are its own: a page of this profile takes them away and opens none of them", async () => {
    const other = await page();
    // The page's storage module, as the profile's start sets it (a page start loads it anew: the default profile).
    (await import("../../lib/storage")).setStorageProfile("abcdefghij");
    await other.showPrivateNotification("message:link-a:m1", "New message", "chat-1", true);
    const [tag] = posted();
    tauri.tap = tag;
    const next = await page();
    const opened: string[] = [];
    next.onNotificationOpen(chat => opened.push(chat));
    await tick();
    expect(opened).toEqual([]);
    expect(calls("native_clear_notifications").slice(-1).map(call => call.args)).toEqual([{ keep: [] }]);
  });
});

/*
 * The Linux app's page that loads again (a reload, or the app opened again) knew none of its chats' notifications: they
 * stayed in the desktop's list, reading the chat closed none, its next message added a second one and a click on the
 * old one opened nothing. Its chats' tags are kept as the Android app's now, and the rest the earlier page left goes.
 */
describe("Linux: a page that loads again", () => {
  beforeEach(() => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15");
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  });

  it("replaces, closes and opens its chats' notifications from before, and takes back the rest", async () => {
    const first = await page();
    await first.showPrivateNotification("message:link-a:m1", "New message", "chat-1", true);
    await first.showPrivateNotification("message:link-b:m1", "New message", "chat-2", true);
    await first.showPrivateNotification("call:chat-3:1", "Incoming call", "chat-3");
    const [one, two] = posted();

    const next = await page();
    const opened: string[] = [];
    next.onNotificationOpen(chat => opened.push(chat));
    await tick();
    expect(calls("native_clear_notifications").slice(-1).map(call => call.args)).toEqual([{ keep: [one, two] }]);
    // A click on chat-2's from before opens it, its next message replaces it, and reading chat-1 closes chat-1's.
    tauri.handlers.get("notification-open")!({ payload: two });
    expect(opened).toEqual(["chat-2"]);
    await next.showPrivateNotification("message:link-b:m2", "New message", "chat-2", true);
    expect(posted().slice(-1)).toEqual([two]);
    next.clearChatNotification("chat-1");
    expect(calls("native_clear_notification").map(call => call.args)).toEqual([{ id: one }]);
  });
});
