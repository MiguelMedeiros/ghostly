import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateVapidKeys } from "@ghostly/core";
import { Settings } from "../../pages/Settings";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { setPushPlatform, type PushPlatform } from "../../lib/wakePush";
import { engineState, fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: push.wake.online

/*
 * Settings → Notifications, "Notify me when a contact comes online" (WISP 401 § Wake-up push, revision 2026-10-27):
 * right under "Wake me while closed", shown while a subscription is shared (it rides on it), on by default, and it
 * can be turned off.
 */

const settings = { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true };
const keys = { endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "p", auth: "a" };
const platform = () => ({ supported: () => true, subscribe: vi.fn(), current: vi.fn(async () => keys), unsubscribe: vi.fn(), syncTable: vi.fn(async () => {}) }) as unknown as PushPlatform;
const renderSettings = () => renderApp(<LockScreenProvider><UpdateProvider><Settings /></UpdateProvider></LockScreenProvider>);

afterEach(() => setPushPlatform(null));

describe("the online notice switch", () => {
  it("is not there while this profile is not woken", async () => {
    setPushPlatform(platform());
    fakeEngine.setState(engineState({ settings }));
    renderSettings();
    await screen.findByTestId("settings-wake");
    expect(screen.queryByTestId("settings-wake-online")).toBeNull();
  });

  it("sits right under Wake me while closed, on by default, and turns off through the engine", async () => {
    setPushPlatform(platform());
    fakeEngine.on("setWakeSubscription", () => undefined);
    fakeEngine.on("wakeConfirm", () => undefined);
    fakeEngine.on("setWakeOnline", () => undefined);
    const wake = { ...keys, vapid: generateVapidKeys() };
    fakeEngine.setState(engineState({ settings: { ...settings, wake } }));
    const { user } = renderSettings();
    const toggle = await screen.findByTestId("settings-wake-online");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleName("Notify me when a contact comes online");
    // Right under the wake-up row, in the same section.
    const wakeRow = screen.getByTestId("settings-wake-row"), onlineRow = screen.getByTestId("settings-wake-online-row");
    expect(wakeRow.parentElement).toBe(onlineRow.parentElement);
    expect(wakeRow.compareDocumentPosition(onlineRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(toggle);
    await waitFor(() => expect(fakeEngine.callsTo("setWakeOnline")).toEqual([{ on: false }]));
    await act(async () => { fakeEngine.setState(engineState({ settings: { ...settings, wake, wakeOnline: false } })); });
    expect(screen.getByTestId("settings-wake-online")).toHaveAttribute("aria-checked", "false");
  });
});
