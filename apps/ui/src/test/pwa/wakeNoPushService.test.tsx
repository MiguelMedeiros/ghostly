import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "../../pages/Settings";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { NO_PUSH_SERVICE_KEY, isNoPushService, setPushPlatform, setWake, type PushPlatform } from "../../lib/wakePush";
import type { Language } from "../../lib/settings";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: push.wake.notify

/*
 * A browser with no push service (GrapheneOS's Vanadium: Chromium without Google Play services). `PushManager` is
 * there, so the switch is offered, but every subscription is refused with "AbortError: Registration failed - push
 * service not available". The switch goes back off with why, in the person's language, for as long as it is so: kept
 * for the browser, the next visit reads it as unavailable, with a Try again.
 */

const keys = { endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "p", auth: "a" };
const noService = () => new DOMException("Registration failed - push service not available", "AbortError");
const denied = () => new DOMException("Registration failed - permission denied", "NotAllowedError");

function platform(subscribe: PushPlatform["subscribe"]) {
  const fake = { supported: () => true, subscribe: vi.fn(subscribe), current: vi.fn(async () => null), unsubscribe: vi.fn(async () => {}), syncTable: vi.fn(async () => {}) };
  setPushPlatform(fake as unknown as PushPlatform);
  return fake;
}
const settings = (language?: Language) => renderApp(<LockScreenProvider><UpdateProvider><Settings /></UpdateProvider></LockScreenProvider>, { language });
const hint = () => screen.getByTestId("settings-wake-hint");
const wakeSwitch = () => screen.getByTestId("settings-wake");

beforeEach(() => fakeEngine.on("setWakeSubscription", () => undefined));
afterEach(() => { setPushPlatform(null); vi.useRealTimers(); });

describe("a browser with no push service", () => {
  it("turned on: the switch goes back off, and why stays on screen in the person's language", async () => {
    const fake = platform(async () => { throw noService(); });
    const { user } = settings("pt");
    await user.click(await screen.findByTestId("settings-wake"));
    await waitFor(() => expect(fake.subscribe).toHaveBeenCalledTimes(1));
    const why = "Este navegador não tem serviço de push, então o Ghostly não pode ser acordado com o app fechado. No GrapheneOS, instale o Google Play em sandbox ou use outro navegador.";
    await waitFor(() => expect(hint()).toHaveTextContent(why));
    expect(wakeSwitch()).toHaveAttribute("aria-checked", "false");
    // Still there long after: nothing takes it away but the next try.
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(hint()).toHaveTextContent(why);
    expect(wakeSwitch()).toHaveAttribute("aria-checked", "false");
    // Unavailable, with why as its description, and a way to try again.
    expect(wakeSwitch()).toHaveAttribute("aria-disabled", "true");
    expect(wakeSwitch()).toHaveAttribute("aria-describedby", hint().id);
    expect(screen.getByTestId("settings-wake-retry")).toHaveTextContent("Tentar de novo");
    expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([]);
  });

  it("is kept for the browser: the next visit reads it as unavailable at once, and tapping the switch tries nothing", async () => {
    const fake = platform(async () => { throw noService(); });
    const first = settings();
    await first.user.click(await screen.findByTestId("settings-wake"));
    await waitFor(() => expect(wakeSwitch()).toHaveAttribute("aria-disabled", "true"));
    expect(localStorage.getItem(NO_PUSH_SERVICE_KEY)).toBe("1");
    first.unmount();

    const { user } = settings();
    expect(await screen.findByTestId("settings-wake-hint")).toHaveTextContent("This browser has no push service, so Ghostly can't be woken while it's closed. On GrapheneOS, install sandboxed Google Play or use another browser.");
    expect(wakeSwitch()).toHaveAttribute("aria-disabled", "true");
    await user.click(wakeSwitch());
    await act(async () => { await Promise.resolve(); });
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    expect(wakeSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("Try again tries again: still none keeps it so; one found since (sandboxed Google Play installed) turns it on", async () => {
    localStorage.setItem(NO_PUSH_SERVICE_KEY, "1");
    let found = false;
    const fake = platform(async () => { if (!found) throw noService(); return keys; });
    const { user } = settings();
    await user.click(await screen.findByTestId("settings-wake-retry"));
    await waitFor(() => expect(fake.subscribe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("settings-wake-retry")).toBeEnabled());
    expect(hint()).toHaveTextContent("This browser has no push service");
    expect(wakeSwitch()).toHaveAttribute("aria-disabled", "true");
    expect(localStorage.getItem(NO_PUSH_SERVICE_KEY)).toBe("1");

    found = true;
    await user.click(screen.getByTestId("settings-wake-retry"));
    await waitFor(() => expect(fakeEngine.callsTo("setWakeSubscription")).toHaveLength(1));
    expect(localStorage.getItem(NO_PUSH_SERVICE_KEY)).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("settings-wake-retry")).toBeNull());
    expect(wakeSwitch()).not.toHaveAttribute("aria-disabled");
    expect(hint()).not.toHaveTextContent("no push service");
  });

  it("a refusal of notifications (NotAllowedError) is not that: its own line, the switch stays available, nothing kept", async () => {
    const fake = platform(async () => { throw denied(); });
    const { user } = settings();
    await user.click(await screen.findByTestId("settings-wake"));
    await waitFor(() => expect(fake.subscribe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hint()).toHaveTextContent("permission denied"));
    expect(hint()).not.toHaveTextContent("no push service");
    expect(wakeSwitch()).toHaveAttribute("aria-checked", "false");
    expect(wakeSwitch()).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByTestId("settings-wake-retry")).toBeNull();
    expect(localStorage.getItem(NO_PUSH_SERVICE_KEY)).toBeNull();
  });
});

describe("which refusals mean no push service", () => {
  it("AbortError, NotSupportedError or the words; never NotAllowedError or another error", () => {
    expect(isNoPushService(noService())).toBe(true);
    expect(isNoPushService(new DOMException("Push is not supported", "NotSupportedError"))).toBe(true);
    expect(isNoPushService(new Error("Registration failed - push service not available"))).toBe(true);
    expect(isNoPushService(denied())).toBe(false);
    expect(isNoPushService(new Error("Notifications are off for Ghostly in this browser. Allow them, then try again."))).toBe(false);
    expect(isNoPushService(undefined)).toBe(false);
  });

  it("a later refusal of another kind (notifications turned off) forgets it: it says nothing of the push service", async () => {
    localStorage.setItem(NO_PUSH_SERVICE_KEY, "1");
    platform(async () => { throw new Error("Notifications are off for Ghostly in this browser. Allow them, then try again."); });
    await expect(setWake(true)).rejects.toThrow("Notifications are off");
    expect(localStorage.getItem(NO_PUSH_SERVICE_KEY)).toBeNull();
  });
});
