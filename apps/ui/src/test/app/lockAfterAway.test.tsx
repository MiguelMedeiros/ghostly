import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";
import { renderApp } from "../render";

// covers: settings.lock.idle

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function Probe() {
  const { isLocked } = useLockScreen();
  return <p data-testid="locked">{String(isLocked)}</p>;
}

const locked = () => screen.getByTestId("locked").textContent;

/** The app open and unlocked, "lock after 5 minutes" on. */
function open() {
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", timeoutMinutes: 5 } }));
  handOverUnlock(activeProfileId(), "x");
  renderApp(<LockScreenProvider><Probe /></LockScreenProvider>);
  expect(locked()).toBe("false");
}

/** What a sleeping device looks like to the page: the clock moves on, its timers do not. */
const sleep = (ms: number) => vi.setSystemTime(Date.now() + ms);
/** Time with the page running: clock and timers together. */
const awake = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe("lock after the chosen time, whatever kept the page from counting it", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); });

  it("locks after the time with the page awake and nobody touching it, and not before", () => {
    open();
    awake(5 * MINUTE - 1000);
    expect(locked()).toBe("false");
    awake(1000);
    expect(locked()).toBe("true");
  });

  it("activity starts the time again", () => {
    open();
    awake(4 * MINUTE);
    act(() => { fireEvent.keyDown(window); });
    awake(4 * MINUTE);
    expect(locked()).toBe("false");
    awake(MINUTE);
    expect(locked()).toBe("true");
  });

  it("the first touch after hours asleep locks, and does not start the time again", () => {
    open();
    sleep(8 * HOUR);
    expect(locked()).toBe("false");
    act(() => { fireEvent.touchStart(window); });
    expect(locked()).toBe("true");
  });

  it.each(["visibilitychange", "focus", "pageshow"])("coming back after hours asleep locks before any touch (%s)", (event) => {
    open();
    sleep(8 * HOUR);
    act(() => { (event === "visibilitychange" ? document : window).dispatchEvent(new Event(event)); });
    expect(locked()).toBe("true");
  });

  it("a device that woke with nobody touching it locks within half a minute", () => {
    open();
    awake(MINUTE);
    sleep(8 * HOUR);
    awake(30_000);
    expect(locked()).toBe("true");
  });

  it("coming back sooner than the chosen time keeps it open, and is not activity", () => {
    open();
    sleep(3 * MINUTE);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(locked()).toBe("false");
    awake(2 * MINUTE);
    expect(locked()).toBe("true");
  });

  it("a clock set back does not make the wait longer than the chosen time", () => {
    open();
    vi.setSystemTime(Date.now() - 8 * HOUR);
    act(() => { window.dispatchEvent(new Event("focus")); });
    awake(5 * MINUTE);
    expect(locked()).toBe("true");
  });
});
