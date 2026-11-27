import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCallOn, setRingingIn } from "../../../../../packages/react/src/callRegistry";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";
import { renderApp } from "../render";

// covers: settings.lock.idle, calls.lock

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function Probe() {
  const { isLocked, lock } = useLockScreen();
  return <button data-testid="locked" onClick={lock}>{String(isLocked)}</button>;
}

const locked = () => screen.getByTestId("locked").textContent;
/** Time with the page running: clock and timers together. */
const awake = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
/** What a sleeping device looks like to the page: the clock moves on, its timers do not. */
const sleep = (ms: number) => vi.setSystemTime(Date.now() + ms);

/** The app open and unlocked, "Lock after 1 minute" on. */
function open() {
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", timeoutMinutes: 1 } }));
  handOverUnlock(activeProfileId(), "x");
  renderApp(<LockScreenProvider><Probe /></LockScreenProvider>);
  expect(locked()).toBe("false");
}

/** A call placed or answered in a chat (`useWebRTC`) or a group's joined (`GroupCallButton`): on until `end`. */
function callOn() {
  const key = Symbol("call");
  act(() => { setCallOn(key, () => {}); });
  return { key, end: () => act(() => { setCallOn(key, null); }) };
}

describe("a call on keeps the idle lock away", () => {
  const keys: symbol[] = [];
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    for (const key of keys.splice(0)) { setCallOn(key, null); setRingingIn(key, false); }
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("a three-minute call with nobody touching anything does not lock; the time counts again from its end", () => {
    open();
    awake(30_000);
    const call = callOn();
    keys.push(call.key);
    awake(3 * MINUTE);
    expect(locked()).toBe("false");
    call.end();
    awake(59_000);
    expect(locked()).toBe("false");
    awake(2_000);
    expect(locked()).toBe("true");
  });

  it("Lock Now still locks during the call", () => {
    open();
    const call = callOn();
    keys.push(call.key);
    awake(MINUTE / 2);
    act(() => { fireEvent.click(screen.getByTestId("locked")); });
    expect(locked()).toBe("true");
  });

  it("a call only ringing in does not keep it away: the lock screen shows it instead", () => {
    open();
    const key = Symbol("ringing");
    keys.push(key);
    act(() => { setRingingIn(key, true); });
    awake(MINUTE);
    expect(locked()).toBe("true");
  });

  it("a device that slept during the call locks when it wakes, as without one", () => {
    open();
    const call = callOn();
    keys.push(call.key);
    awake(MINUTE);
    sleep(8 * HOUR);
    awake(30_000);
    expect(locked()).toBe("true");
  });

  it("a call that ends as the device wakes from a long sleep does not start the time again", () => {
    open();
    const call = callOn();
    keys.push(call.key);
    awake(MINUTE);
    sleep(8 * HOUR);
    call.end();
    expect(locked()).toBe("true");
  });
});
