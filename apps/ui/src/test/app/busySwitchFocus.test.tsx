import { act, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateVapidKeys } from "@ghostly/core";
import { NetworkSettings } from "../../components/NetworkSettings";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { setPushPlatform, type PushPlatform } from "../../lib/wakePush";
import { Settings } from "../../pages/Settings";
import { engineState, fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: push.wake.exchange, app.attention.notifications, settings.network.relay-only, settings.network.relays

/*
 * A switch (or a button beside it) that works for a while is busy, not disabled: a disabled button drops a keyboard's
 * focus to the page, and the next Tab starts again from the top. Each control is pressed from the keyboard, held at
 * work, then let go: the focus stays on it throughout, and a second press while it works does nothing.
 */

/** A promise and the way to settle it. */
function held<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
}

afterEach(() => {
  setPushPlatform(null);
  vi.unstubAllGlobals();
});

const keys = { endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "p", auth: "a" };
const settings = { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true };
const platform = (subscribe: () => Promise<typeof keys>) =>
  ({ supported: () => true, subscribe: vi.fn(subscribe), current: vi.fn(async () => keys), unsubscribe: vi.fn(async () => {}), syncTable: vi.fn(async () => {}) }) as unknown as PushPlatform & { subscribe: ReturnType<typeof vi.fn> };
const renderSettings = () => renderApp(
  <LockScreenProvider><UpdateProvider><Routes><Route path="/settings/*" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>,
  { route: "/settings/notifications" },
);

describe("Settings › Notifications", () => {
  it("Wake me while closed keeps the focus while it turns on", async () => {
    const subscription = held<typeof keys>();
    const push = platform(() => subscription.promise);
    setPushPlatform(push);
    fakeEngine.on("setWakeSubscription", () => undefined);
    fakeEngine.setState(engineState({ settings }));
    const { user } = renderSettings();
    const toggle = await screen.findByTestId("settings-wake");
    toggle.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(push.subscribe).toHaveBeenCalledTimes(1));
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-busy", "true");
    // Enabled: a disabled button would let the focus go to the page.
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    await user.keyboard(" ");
    expect(push.subscribe).toHaveBeenCalledTimes(1);
    await act(async () => { subscription.release(keys); });
    await waitFor(() => expect(fakeEngine.callsTo("setWakeSubscription")).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("settings-wake")).not.toHaveAttribute("aria-busy"));
    expect(screen.getByTestId("settings-wake")).toHaveFocus();
  });

  it("its New link keeps the focus while it works", async () => {
    const subscription = held<typeof keys>();
    const push = platform(() => subscription.promise);
    setPushPlatform(push);
    fakeEngine.on("setWakeSubscription", () => undefined);
    fakeEngine.on("wakeConfirm", () => undefined);
    fakeEngine.setState(engineState({ settings: { ...settings, wake: { ...keys, vapid: generateVapidKeys() } } }));
    const { user } = renderSettings();
    const rotate = await screen.findByTestId("settings-wake-rotate");
    rotate.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(push.subscribe).toHaveBeenCalledTimes(1));
    expect(rotate).toHaveFocus();
    expect(rotate).toHaveAttribute("aria-busy", "true");
    // Enabled: a disabled button would let the focus go to the page.
    expect(rotate).toBeEnabled();
    await act(async () => { subscription.release(keys); });
    await waitFor(() => expect(screen.getByTestId("settings-wake-rotate")).not.toHaveAttribute("aria-busy"));
    expect(screen.getByTestId("settings-wake-rotate")).toHaveFocus();
  });

  it("System notifications keeps the focus while the browser asks", async () => {
    const answer = held<NotificationPermission>();
    class AskingNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = vi.fn(() => answer.promise.then((permission) => (AskingNotification.permission = permission)));
    }
    vi.stubGlobal("Notification", AskingNotification);
    fakeEngine.setState(engineState({ settings }));
    const { user } = renderSettings();
    const toggle = await screen.findByTestId("settings-system-notifications");
    toggle.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(AskingNotification.requestPermission).toHaveBeenCalledTimes(1));
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-busy", "true");
    // Enabled: a disabled button would let the focus go to the page.
    expect(toggle).toBeEnabled();
    await user.keyboard(" ");
    expect(AskingNotification.requestPermission).toHaveBeenCalledTimes(1);
    await act(async () => { answer.release("granted"); });
    await waitFor(() => expect(screen.getByTestId("settings-system-notifications")).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByTestId("settings-system-notifications")).not.toHaveAttribute("aria-busy");
    expect(screen.getByTestId("settings-system-notifications")).toHaveFocus();
  });
});

describe("Settings › Network", () => {
  const RELAYS = ["https://pkarr.pubky.org", "https://pkarr.pubky.app"];
  const TURN = { urls: "turn:turn.example.org:3478", username: "ghost", credential: "c" };

  for (const [name, testId, transport] of [
    ["Hide my IP from contacts", "network-relay-only", { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS }],
    ["the Desktop's relay reads", "network-read-relays", { protocol: "Mainline DHT (BEP44) — Direct UDP", relays: [], direct: true }],
  ] as const) {
    it(`${name} keeps the focus while it turns on`, async () => {
      const saved = held();
      const { engine, user } = renderApp(<NetworkSettings />);
      act(() => engine.update({ transport: { ...transport, relays: [...transport.relays] }, settings: { relays: RELAYS, iceServers: [TURN] } }));
      engine.on("updateSettings", () => saved.promise);
      const toggle = screen.getByTestId(testId);
      toggle.focus();
      await user.keyboard(" ");
      await waitFor(() => expect(engine.callsTo("updateSettings")).toHaveLength(1));
      expect(toggle).toHaveFocus();
      expect(toggle).toHaveAttribute("aria-busy", "true");
      // Enabled: a disabled button would let the focus go to the page.
      expect(toggle).toBeEnabled();
      await user.keyboard(" ");
      expect(engine.callsTo("updateSettings")).toHaveLength(1);
      await act(async () => { saved.release(); });
      await waitFor(() => expect(screen.getByTestId(testId)).not.toHaveAttribute("aria-busy"));
      expect(screen.getByTestId(testId)).toHaveFocus();
    });
  }
});
