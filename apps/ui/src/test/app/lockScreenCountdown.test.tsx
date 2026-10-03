import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockScreen } from "../../components/LockScreen";
import { renderApp } from "../render";

// covers: app.idle, profiles.lock

const lock = vi.hoisted(() => ({ retryAt: null as number | null }));
vi.mock("../../contexts/LockScreenContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../contexts/LockScreenContext")>()),
  useLockScreen: () => ({ isLocked: true, hasPassword: true, unlock: async () => false, lock: () => {}, retryAt: lock.retryAt }),
}));

describe("the lock screen's wait after too many wrong passwords", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); lock.retryAt = null; });

  it("counts down, then runs no timer: a locked app left alone is idle", () => {
    lock.retryAt = Date.now() + 3_000;
    renderApp(<LockScreen />);
    expect(screen.getByRole("alert")).toHaveTextContent("3");
    act(() => { vi.advanceTimersByTime(1_250); });
    expect(screen.getByRole("alert")).toHaveTextContent("2");
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts no timer for a wait that is already over, or when there is none", () => {
    lock.retryAt = Date.now() - 1_000;
    const { unmount } = renderApp(<LockScreen />);
    expect(vi.getTimerCount()).toBe(0);
    unmount();
    lock.retryAt = null;
    renderApp(<LockScreen />);
    expect(vi.getTimerCount()).toBe(0);
  });
});
