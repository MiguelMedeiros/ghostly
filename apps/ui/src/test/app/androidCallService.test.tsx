import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallState } from "@ghostly/core";
import { callHoldsService, useCallService, type CallNotice } from "../../lib/callService";

// covers: android.calls.background

/*
 * The Android app keeps a call going out of sight: while it is on, Rust's `call_service` holds a foreground service of
 * type microphone (camera too while the call sends its picture) with a "Call with …" notification (CallService.kt).
 * Without it Android silenced the microphone 6-10 s after Home or the screen off, and the call ended by itself.
 */

const tauri = vi.hoisted(() => ({
  permission: "granted",
  invoke: vi.fn(async (command: string, _args?: unknown): Promise<unknown> => {
    if (command === "native_notification_permission") return tauri.permission;
    if (command === "call_service") return true;
    return undefined;
  }),
  /** The page's `call-hang-up` listener, while it listens. */
  hangUp: undefined as (() => void) | undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  listen: async (name: string, handler: () => void) => {
    if (name !== "call-hang-up") return () => {};
    tauri.hangUp = handler;
    return () => { if (tauri.hangUp === handler) tauri.hangUp = undefined; };
  },
  getVersion: async () => "0.4.0",
}));

const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36";
const told = () => tauri.invoke.mock.calls.filter(([command]) => command === "call_service").map(([, args]) => (args as { call: CallNotice | null }).call);
const asked = () => tauri.invoke.mock.calls.filter(([command, args]) => command === "native_notification_permission" && (args as { request: boolean }).request).length;

function android(on: boolean) {
  if (on) (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(on ? ANDROID : "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36");
}

beforeEach(() => {
  tauri.permission = "granted";
  tauri.hangUp = undefined;
  tauri.invoke.mockClear();
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("which call holds the service", () => {
  it("one placed or answered, once its microphone is there, until it ends; never one that only rings", () => {
    const stream = {} as MediaStream;
    for (const state of ["offering", "answering", "connecting", "connected"] as CallState[]) {
      expect(callHoldsService(state, stream), state).toBe(true);
      // Before the microphone is ours, Android 14 and up would end the app for a microphone service.
      expect(callHoldsService(state, null), `${state} with no stream`).toBe(false);
    }
    for (const state of ["idle", "incoming", "ended"] as CallState[]) expect(callHoldsService(state, stream), state).toBe(false);
  });
});

describe("the Android call service", () => {
  it("is held from the call's start to its end, told again of a camera or a name, never stopped in between", async () => {
    android(true);
    const { rerender, unmount } = renderHook(({ call }: { call: CallNotice | null }) => useCallService(call, vi.fn()), { initialProps: { call: null as CallNotice | null } });
    expect(told()).toEqual([]);

    rerender({ call: { name: "Ana", video: false } });
    await waitFor(() => expect(told()).toEqual([{ name: "Ana", video: false }]));
    // The camera turned on, then the contact's name changed: told again, with no stop, which from the background
    // would leave the call with nothing held (Android refuses the start again).
    rerender({ call: { name: "Ana", video: true } });
    rerender({ call: { name: "Ana B.", video: true } });
    rerender({ call: { name: "Ana B.", video: true } });
    await waitFor(() => expect(told()).toEqual([{ name: "Ana", video: false }, { name: "Ana", video: true }, { name: "Ana B.", video: true }]));

    rerender({ call: null });
    await waitFor(() => expect(told()[told().length - 1]).toBeNull());
    unmount();
    expect(told()).toHaveLength(4);
  });

  it("stops when the chat goes with its call on", async () => {
    android(true);
    const { unmount } = renderHook(() => useCallService({ name: "Ana", video: false }, vi.fn()));
    await waitFor(() => expect(told()).toHaveLength(1));
    unmount();
    expect(told()).toEqual([{ name: "Ana", video: false }, null]);
  });

  it("the notification's Hang up ends the call; after the call, nothing listens", async () => {
    android(true);
    const hangUp = vi.fn();
    const { rerender } = renderHook(({ call }: { call: CallNotice | null }) => useCallService(call, hangUp), { initialProps: { call: { name: "Ana", video: false } as CallNotice | null } });
    await waitFor(() => expect(tauri.hangUp).toBeDefined());
    tauri.hangUp!();
    expect(hangUp).toHaveBeenCalledTimes(1);

    rerender({ call: null });
    await waitFor(() => expect(tauri.hangUp).toBeUndefined());
  });

  it("asks for notifications once the call is on when they were never asked for, and not when they were", async () => {
    android(true);
    tauri.permission = "default";
    const first = renderHook(() => useCallService({ name: "Ana", video: false }, vi.fn()));
    await waitFor(() => expect(asked()).toBe(1));
    first.unmount();

    tauri.invoke.mockClear();
    tauri.permission = "denied";
    const second = renderHook(() => useCallService({ name: "Ana", video: false }, vi.fn()));
    await waitFor(() => expect(told()).toHaveLength(1));
    await new Promise((done) => setTimeout(done, 20));
    expect(asked()).toBe(0);
    second.unmount();
  });

  it("holds nothing outside the Android app", async () => {
    android(false);
    const { unmount } = renderHook(() => useCallService({ name: "Ana", video: true }, vi.fn()));
    await new Promise((done) => setTimeout(done, 20));
    unmount();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});
