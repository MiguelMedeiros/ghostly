import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIncomingCallNotice } from "../../hooks/useIncomingCallNotice";
import { loadSettings, saveSettings } from "../../lib/settings";

// covers: calls.ring-elsewhere

/*
 * "Incoming call" used to stay in the desktop's notification list (and in Android's shade) after the call was
 * answered, declined or given up: nothing took it back. It now goes when the ring ends.
 */

const tauri = vi.hoisted(() => ({
  /** Held back while set: the host has not shown the notification yet. */
  showing: undefined as Promise<void> | undefined,
  invoke: vi.fn(async (command: string, _args?: unknown): Promise<unknown> => {
    if (command === "native_notification_permission") return "granted";
    if (command === "native_private_notification") { await tauri.showing; return true; }
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, listen: async () => () => {}, getVersion: async () => "0.4.0" }));

const ids = (command: string) => tauri.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => (args as { id: string }).id);
const posted = () => ids("native_private_notification");
const cleared = () => ids("native_clear_notification");

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const settings = loadSettings();
  saveSettings({ ...settings, notifications: { ...settings.notifications, systemEnabled: true } });
  tauri.invoke.mockClear();
  tauri.showing = undefined;
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("the notification of a call that rang out of sight", () => {
  it("stays while it rings and goes when the ring ends", async () => {
    const { rerender } = renderHook(({ ringing }) => useIncomingCallNotice(ringing, "chat-a", "Incoming call"), { initialProps: { ringing: true } });
    await waitFor(() => expect(posted()).toHaveLength(1));
    rerender({ ringing: true });
    expect(cleared()).toEqual([]);
    // Answered, declined or given up: the call is no longer incoming.
    rerender({ ringing: false });
    await waitFor(() => expect(cleared()).toEqual(posted()));
    // The next ring has its own, which goes with it.
    rerender({ ringing: true });
    await waitFor(() => expect(posted()).toHaveLength(2));
    expect(posted()[1]).not.toBe(posted()[0]);
    rerender({ ringing: false });
    await waitFor(() => expect(cleared()).toEqual(posted()));
  });

  it("goes too when the ring ended before the host had shown it", async () => {
    let show = () => {};
    tauri.showing = new Promise<void>((resolve) => { show = resolve; });
    const { rerender } = renderHook(({ ringing }) => useIncomingCallNotice(ringing, "chat-a", "Incoming call"), { initialProps: { ringing: true } });
    await waitFor(() => expect(posted()).toHaveLength(1));
    rerender({ ringing: false });
    expect(cleared()).toEqual([]);
    show();
    await waitFor(() => expect(cleared()).toEqual(posted()));
  });

  it("goes from the extension's notifications too", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    const notifications = { create: vi.fn(async (id: string) => id), clear: vi.fn(async (_id: string) => true) };
    vi.stubGlobal("chrome", { runtime: { id: "ghostly", getURL: (path: string) => path }, permissions: { contains: async () => true, request: async () => true }, notifications });
    const { rerender } = renderHook(({ ringing }) => useIncomingCallNotice(ringing, "chat-a", "Incoming call"), { initialProps: { ringing: true } });
    await waitFor(() => expect(notifications.create).toHaveBeenCalledTimes(1));
    expect(notifications.clear).not.toHaveBeenCalled();
    rerender({ ringing: false });
    await waitFor(() => expect(notifications.clear.mock.calls).toEqual([[notifications.create.mock.calls[0]![0]]]));
    vi.unstubAllGlobals();
  });

  it("asks for nothing when no notification was shown", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { rerender } = renderHook(({ ringing }) => useIncomingCallNotice(ringing, "chat-a", "Incoming call"), { initialProps: { ringing: true } });
    rerender({ ringing: false });
    expect(posted()).toEqual([]);
    expect(cleared()).toEqual([]);
  });
});
