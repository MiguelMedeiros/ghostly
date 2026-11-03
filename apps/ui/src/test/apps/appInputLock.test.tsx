import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";
import { createBroker } from "../../lib/apps/broker";
import { appInput } from "../../lib/apps/open";
import { memoryHost } from "../../lib/apps/memoryHost";
import { renderApp } from "../render";

// covers: settings.lock.idle

/**
 * A person playing a mini-app is using Ghostly: their taps and keys in the app's frame (web) or window (Desktop) never
 * reach the Ghostly page, so the runner says `activity` and the lock counts it, but only while the app has the focus.
 * Leaving the app (another window, another page) lets the lock come as before.
 */
const MINUTE = 60_000;

function brokerWith(inUse: () => boolean | Promise<boolean>) {
  const posted: Record<string, unknown>[] = [];
  const onInput = vi.fn();
  const broker = createBroker({
    host: memoryHost(),
    launch: { ref: "pubkeyalpha/chess", digest: "d", version: "1.0.0", title: "Chess", permissions: [], entry: "<p>app</p>", chat: null },
    view: { theme: () => "dark", locale: () => "en" },
    post: (message) => posted.push(message as Record<string, unknown>),
    stopped: () => {},
    inUse,
    onInput,
  });
  broker.load();
  broker.message({ id: 0, type: "writing", args: [] });
  broker.load();
  return { broker, posted, onInput };
}

describe("the runner's `activity`", () => {
  it("is the person's input while the app has the focus, and is answered", async () => {
    const { broker, posted, onInput } = brokerWith(() => true);
    broker.message({ id: 1, type: "activity", args: [] });
    await vi.waitFor(() => expect(onInput).toHaveBeenCalledOnce());
    expect(posted).toContainEqual({ id: 1, ok: true });
  });

  it("counts for nothing from an app the person is not in, and is answered the same", async () => {
    const { broker, posted, onInput } = brokerWith(async () => false);
    broker.message({ id: 1, type: "activity", args: [] });
    await vi.waitFor(() => expect(posted).toContainEqual({ id: 1, ok: true }));
    await Promise.resolve();
    expect(onInput).not.toHaveBeenCalled();
  });
});

function Probe() {
  const { isLocked } = useLockScreen();
  return <p data-testid="locked">{String(isLocked)}</p>;
}

const locked = () => screen.getByTestId("locked").textContent;
const awake = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe("the lock, with an app in use", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", timeoutMinutes: 1 } }));
    handOverUnlock(activeProfileId(), "x");
    renderApp(<LockScreenProvider><Probe /></LockScreenProvider>);
    expect(locked()).toBe("false");
  });
  afterEach(() => { vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); });

  it("input in the app starts the time again: a game longer than the lock time goes on", () => {
    for (let i = 0; i < 5; i++) {
      awake(50_000);
      act(() => { appInput(); });
    }
    expect(locked()).toBe("false");
    awake(MINUTE);
    expect(locked()).toBe("true");
  });

  it("the first input in the app after the time is up locks, and does not start the time again", () => {
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    act(() => { appInput(); });
    expect(locked()).toBe("true");
  });
});
