import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WAKE_CALL_WAIT_MS } from "@ghostly/core";
import { useWakeCall } from "../../hooks/useWakeCall";
import { fakeEngine } from "../fakeEngine";

// covers: push.wake.call

afterEach(() => vi.useRealTimers());

describe("calling a contact whose app is closed", () => {
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

  it("a contact that cannot be woken: it says so at once", async () => {
    fakeEngine.on("wakeForCall", () => false);
    const { result } = renderHook(() => useWakeCall("link-1", false, vi.fn()));
    await act(() => result.current.ring(false));
    expect(result.current.waking).toBe(false);
    expect(result.current.gaveUp).toBe(true);
  });
});
