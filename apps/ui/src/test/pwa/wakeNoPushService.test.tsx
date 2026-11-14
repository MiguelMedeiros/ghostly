import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "../../pages/Settings";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { NO_PUSH_SERVICE_KEY, isNoPushService, setPushPlatform, setWake, type PushPlatform } from "../../lib/wakePush";
import { generateVapidKeys } from "@ghostly/core";
import type { WakeSubscription } from "@ghostly/browser/shared/types";
import type { Language } from "../../lib/settings";
import { engineState, fakeEngine } from "../fakeEngine";
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
    await waitFor(() => expect(screen.getByTestId("settings-wake-retry")).not.toHaveAttribute("aria-busy"));
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

/*
 * New token while wake-ups are on: the web platform ends the old subscription before it makes the new one (a browser
 * refuses a second key while one is held), so a refused new one leaves contacts holding an endpoint that is gone.
 */
describe("New token refused", () => {
  const settingsWith = (wake?: WakeSubscription) => ({ online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, ...(wake && { wake }) });
  const wakeOn = { ...keys, vapid: generateVapidKeys() };
  beforeEach(() => {
    fakeEngine.setState(engineState({ settings: settingsWith(wakeOn) }));
    fakeEngine.on("setWakeSubscription", ({ subscription }) => fakeEngine.setState(engineState({ settings: settingsWith(subscription ?? undefined) })));
  });

  it("for no push service, after the old subscription ended: wake-ups are off, and the row says why", async () => {
    const fake = platform(async () => { throw noService(); });
    const { user } = settings();
    await user.click(await screen.findByTestId("settings-wake-rotate"));
    await waitFor(() => expect(fake.subscribe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(wakeSwitch()).toHaveAttribute("aria-checked", "false"));
    expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([{ subscription: null }]);
    expect(hint()).toHaveTextContent("This browser has no push service");
    expect(wakeSwitch()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("settings-wake-retry")).toBeEnabled();
  });

  it("for another reason, after the old subscription ended: wake-ups are off, with the refusal's line", async () => {
    const fake = platform(async () => { throw new Error("Registration failed - storage error"); });
    const { user } = settings();
    await user.click(await screen.findByTestId("settings-wake-rotate"));
    await waitFor(() => expect(fake.subscribe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(wakeSwitch()).toHaveAttribute("aria-checked", "false"));
    expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([{ subscription: null }]);
    expect(hint()).toHaveTextContent("storage error");
    expect(wakeSwitch()).not.toHaveAttribute("aria-disabled");
  });

  it("before the old subscription was touched (notifications refused): wake-ups stay on, with the refusal's line", async () => {
    const fake = platform(async () => { throw denied(); });
    fake.current.mockImplementation(async () => keys as never);
    const { user } = settings();
    await user.click(await screen.findByTestId("settings-wake-rotate"));
    await waitFor(() => expect(fake.subscribe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hint()).toHaveTextContent("permission denied"));
    expect(wakeSwitch()).toHaveAttribute("aria-checked", "true");
    expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([]);
  });

  it("for no push service with the old subscription still there: wake-ups stay on, and the line says why", async () => {
    const fake = platform(async () => { throw noService(); });
    fake.current.mockImplementation(async () => keys as never);
    const { user } = settings();
    await user.click(await screen.findByTestId("settings-wake-rotate"));
    await waitFor(() => expect(fake.subscribe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("settings-wake-rotate")).not.toHaveAttribute("aria-busy"));
    expect(hint()).toHaveTextContent("This browser has no push service");
    expect(wakeSwitch()).toHaveAttribute("aria-checked", "true");
    expect(fakeEngine.callsTo("setWakeSubscription")).toEqual([]);
  });
});

/*
 * Settings is not drawn again on a change of Language: a refusal's line under a switch is written in the language on
 * screen, not the one it was said in (it stayed in English under a page all in Portuguese until the switch was tapped).
 */
describe("a refusal's line, after a change of Language further up the page", () => {
  const noRoom = () => new Error("Not enough space on this device (QuotaExceededError)");
  const choosePortuguese = async (user: ReturnType<typeof settings>["user"]) => {
    await user.click(screen.getByTestId("settings-language"));
    await user.click(await screen.findByRole("option", { name: /Português/ }));
    await screen.findByRole("heading", { name: "Aparência" });
  };

  it("Wake me while closed: in the new language", async () => {
    platform(async () => { throw noRoom(); });
    const { user } = settings();
    await user.click(await screen.findByTestId("settings-wake"));
    await waitFor(() => expect(hint()).toHaveTextContent("Not enough space on this device"));
    await choosePortuguese(user);
    expect(hint()).toHaveTextContent("Não há espaço suficiente neste dispositivo");
  });

  it("Notify me when a contact comes online: in the new language", async () => {
    platform(async () => keys);
    fakeEngine.on("setWakeOnline", () => { throw noRoom(); });
    fakeEngine.setState(engineState({ settings: { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, wake: { ...keys, vapid: generateVapidKeys() } } }));
    const { user } = settings();
    await user.click(await screen.findByTestId("settings-wake-online"));
    const line = () => screen.getByTestId("settings-wake-online-row");
    await waitFor(() => expect(line()).toHaveTextContent("Not enough space on this device"));
    await choosePortuguese(user);
    expect(line()).toHaveTextContent("Não há espaço suficiente neste dispositivo");
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
