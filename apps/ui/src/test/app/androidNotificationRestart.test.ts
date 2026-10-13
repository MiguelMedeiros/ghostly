import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// covers: app.attention.notifications

/*
 * The Android app's page keeps a chat's notification tag, and which chat a tag opens, in memory only. Android keeps
 * the notifications when the app's process ends (swiped from Recents, ended in the background, an update): the page
 * that starts next could not replace them, take them away or open their chat, so the chat got a second one and a tap
 * on the old one opened no chat. A page start now takes away every message notification an earlier page left.
 */

const tauri = vi.hoisted(() => ({
  calls: [] as string[],
  /** Holds `native_clear_notifications` until let go. */
  sweep: undefined as Promise<void> | undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    tauri.calls.push(command);
    if (command === "native_notification_permission") return "granted";
    if (command === "native_private_notification") return true;
    if (command === "native_clear_notifications") await tauri.sweep;
    return undefined;
  },
  listen: async () => () => {},
  getVersion: async () => "0.4.0",
}));

const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36";
/** A page start: the module as a new page loads it. */
const page = async () => {
  vi.resetModules();
  return await import("../../lib/notifications");
};
const sweeps = () => tauri.calls.filter(command => command === "native_clear_notifications").length;

beforeEach(() => {
  tauri.calls.length = 0;
  tauri.sweep = undefined;
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID);
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("Android: the notifications an earlier page left", () => {
  it("go when the page starts, once, and before its own first one is posted", async () => {
    let release!: () => void;
    tauri.sweep = new Promise(resolve => { release = resolve; });
    const run = await page();
    expect(sweeps()).toBe(1);
    const shown = run.showPrivateNotification("message:link-a:m1", "New message", "chat-1", true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(tauri.calls).not.toContain("native_private_notification");
    release();
    await shown;
    await run.showPrivateNotification("message:link-a:m2", "New message", "chat-1", true);
    expect(tauri.calls.filter(command => command === "native_private_notification")).toHaveLength(2);
    expect(sweeps()).toBe(1);
  });

  it("a page whose app cannot take them (an older app) still posts", async () => {
    tauri.sweep = Promise.reject(new Error("unknown command"));
    tauri.sweep.catch(() => {});
    const run = await page();
    await run.showPrivateNotification("message:link-a:m1", "New message", "chat-1", true);
    expect(tauri.calls).toContain("native_private_notification");
  });

  it("only in the Android app: macOS takes its own away, and a browser's page has none left", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15");
    await page();
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID);
    await page();
    expect(sweeps()).toBe(0);
  });
});
