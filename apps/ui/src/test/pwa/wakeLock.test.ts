import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWakeLock } from "../../hooks/useWakeLock";

// covers: calls.wake-lock

let sentinels: { released: boolean; release: ReturnType<typeof vi.fn> }[] = [];
const request = vi.fn(async () => {
  const sentinel = { released: false, release: vi.fn(async () => { sentinel.released = true; }) };
  sentinels.push(sentinel);
  return sentinel;
});
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  sentinels = [];
  request.mockClear();
  visibility = "visible";
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  Reflect.deleteProperty(navigator, "wakeLock");
  Reflect.deleteProperty(document, "visibilityState");
});

describe("the screen stays on during a call", () => {
  it("asks while on a call, again when the page comes back, and lets go after", async () => {
    const { rerender, unmount } = renderHook(({ active }) => useWakeLock(active), { initialProps: { active: false } });
    expect(request).not.toHaveBeenCalled();
    rerender({ active: true });
    await act(async () => {});
    expect(request).toHaveBeenCalledWith("screen");

    // Hidden: the system lets go of it; back: asked again.
    sentinels[0]!.released = true;
    visibility = "hidden";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(request).toHaveBeenCalledTimes(1);
    visibility = "visible";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(request).toHaveBeenCalledTimes(2);

    rerender({ active: false });
    expect(sentinels[1]!.release).toHaveBeenCalled();
    unmount();
  });

  it("does nothing where there is no Wake Lock", () => {
    Reflect.deleteProperty(navigator, "wakeLock");
    expect(() => renderHook(() => useWakeLock(true)).unmount()).not.toThrow();
  });
});
