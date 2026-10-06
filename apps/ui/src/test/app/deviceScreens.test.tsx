import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserHost } from "@ghostly/browser/host";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import type { HandoffView } from "@ghostly/browser/devices/handoff";
import { Root } from "../../Root";
import { AccountBar } from "../../components/AccountBar";
import { DeviceStandby } from "../../components/DeviceStandby";
import { DevicesSection } from "../../components/devices/DevicesSection";
import { HandoffProgress } from "../../components/devices/Handoff";
import { deviceLook } from "../../components/devices/DeviceGlyph";
import { LimitedBanner, resetLimitedStart } from "../../components/devices/LimitedStart";
import { TakeoverDialog } from "../../components/devices/TakeoverDialog";
import { Settings } from "../../pages/Settings";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { createProfile, namespaceOf } from "../../lib/profiles";
import { setPushPlatform, type PushPlatform } from "../../lib/wakePush";
import { engineState, fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: devices.screens, devices.standby-screen, devices.turn.limited

/*
 * The device screens in their final form (WISP 06 § User experience): Profile, Devices with a row per device and its
 * state, the actions on the row and in its menu; the handoff's steps; the takeover's two choices; the standby screen's
 * parts; the question a limited start asks; Standby in the account switcher; and Settings when the push address is
 * another device's.
 */

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

// The device state of other profiles, by their database name, as `ghostly-devices` would hold it.
const states = vi.hoisted(() => new Map<string, string>());
vi.mock("@ghostly/browser/devices/store", async (original) => ({
  ...(await original<typeof import("@ghostly/browser/devices/store")>()),
  deviceStateOf: async (database: string) => states.get(database) ?? "single",
}));

const DESKTOP = "D".repeat(43), PHONE = "P".repeat(43), TABLET = "T".repeat(43);
const set = (patch: Partial<DeviceSetView> = {}): DeviceSetView => ({
  state: "active",
  devices: [
    { key: DESKTOP, name: "MacBook", slot: 0, self: true, active: true },
    { key: PHONE, name: "iPhone", slot: 1, self: false, active: false, status: "live" },
    { key: TABLET, name: "Firefox", slot: 2, self: false, active: false, status: "connecting" },
  ],
  ...patch,
});

afterEach(() => { states.clear(); vi.useRealTimers(); });

describe("Profile, Devices", () => {
  it("lists each device with its kind, its state and its link, and says what the section is for behind the ⓘ", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => set({ unfinishedGrants: [{ key: "U".repeat(43), name: "Pixel", at: 1 }] }));
    engine.on("deviceHandoffView", () => null);
    const rows = await screen.findAllByTestId("device-row");
    expect(rows.map((row) => within(row).getByTestId("device-state").textContent)).toEqual(["This device · Active", "Standby", "Standby"]);
    expect(rows[0]).toHaveTextContent("MacBook");
    // This device has no link to itself; the others say whether theirs is connected.
    expect(within(rows[0]).queryByTestId("device-link-status")).toBeNull();
    expect(within(rows[1]).getByTestId("device-link-status")).toHaveTextContent("Connected");
    expect(within(rows[2]).getByTestId("device-link-status")).toHaveAttribute("data-status", "connecting");
    expect(within(rows[2]).getByTestId("device-link-status")).toHaveTextContent("Not connected");
    // A device granted the set that never finished: Not finished, why behind its ⓘ.
    expect(screen.getByTestId("device-row-unfinished")).toHaveTextContent("Not finished");
    const section = screen.getByTestId("profile-devices");
    expect(section).toHaveTextContent("Use this profile on another device");
    expect(section).toHaveTextContent("One device is active at a time.");
    expect(section).not.toHaveTextContent("Only the active device sends");
    await user.click(within(section).getAllByTestId("row-info")[0]);
    expect(section).toHaveTextContent("Only the active device sends, receives and pays");
  });

  it("offers Move to on the row of a connected device only, and Check connection and Remove in the row's menu", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => set());
    engine.on("deviceHandoffView", () => null);
    engine.on("devicePing", () => ({ ms: 41.6 }));
    const [self, phone, tablet] = await screen.findAllByTestId("device-row");
    expect(within(self).queryByTestId("device-move")).toBeNull();
    expect(within(self).queryByTestId("device-menu")).toBeNull();
    expect(within(phone).getByTestId("device-move")).toHaveTextContent("Move to iPhone");
    expect(within(tablet).queryByTestId("device-move")).toBeNull();

    const opener = within(phone).getByTestId("device-menu");
    expect(opener).toHaveAccessibleName("Options for iPhone");
    expect(opener).toHaveAttribute("aria-expanded", "false");
    await user.click(opener);
    expect(opener).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByTestId("device-menu-items");
    expect(within(menu).getByTestId("device-check")).toHaveTextContent("Check connection");
    expect(within(menu).getByTestId("device-remove-open")).toHaveTextContent("Remove");
    // The first row has the focus, so the keys work at once.
    expect(within(menu).getByTestId("device-check")).toHaveFocus();
    await user.click(within(menu).getByTestId("device-check"));
    expect(await within(phone).findByTestId("device-check-result")).toHaveTextContent("Answered in 42 ms");
    expect(screen.queryByTestId("device-menu-items")).toBeNull();

    // A device that is not connected cannot be checked, but can be removed.
    await user.click(within(tablet).getByTestId("device-menu"));
    expect(screen.queryByTestId("device-check")).toBeNull();
    expect(screen.getByTestId("device-remove-open")).toBeInTheDocument();
  });

  it("on a standby device's list nothing acts on another device", async () => {
    const { engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => set({ state: "standby", devices: set().devices.map((device) => ({ ...device, active: device.key === PHONE, self: device.key === TABLET })) }));
    engine.on("deviceHandoffView", () => null);
    const rows = await screen.findAllByTestId("device-row");
    expect(rows.map((row) => within(row).getByTestId("device-state").textContent)).toEqual(["Standby", "Active", "This device · Standby"]);
    expect(screen.queryByTestId("device-move")).toBeNull();
    // Check connection stays (a link answers both ways); Remove is the active device's.
    await act(async () => { within(rows[1]).getByTestId("device-menu").click(); });
    expect(screen.getByTestId("device-check")).toBeInTheDocument();
    expect(screen.queryByTestId("device-remove-open")).toBeNull();
  });

  it("a move whose copy stopped: says so on the row, and Try again moves the profile to that device", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => set());
    engine.on("deviceHandoffView", () => ({ role: "giver", device: "iPhone", key: PHONE, step: "failed", bytes: 0, total: 0, failure: "stalled" }) satisfies HandoffView);
    engine.on("deviceHandoffPush", () => null);
    const row = await screen.findByTestId("handoff-stopped");
    expect(row).toHaveTextContent("The move stopped: no answer from iPhone for 2 minutes. Nothing changed, and files already copied are kept.");
    await user.click(within(row).getByTestId("handoff-try-again"));
    expect(await screen.findByTestId("handoff-move-dialog")).toBeInTheDocument();
    await waitFor(() => expect(engine.callsTo("deviceHandoffPush")).toEqual([{ key: PHONE }]));
  });

  it("draws each device's kind from its name", () => {
    expect(["iPhone", "Phone", "Pixel 8", "iPad", "Tablet", "Chrome on Mac", "Firefox", "Mac app", "Desktop", "Linux"].map(deviceLook))
      .toEqual(["phone", "phone", "phone", "tablet", "tablet", "browser", "browser", "computer", "computer", "computer"]);
  });
});

const view = (patch: Partial<HandoffView>): HandoffView => ({ role: "taker", device: "MacBook", key: DESKTOP, step: "connecting", bytes: 0, total: 0, ...patch });

describe("the handoff's progress", () => {
  it("lists the steps, the one running now in words, and the ones done before it", () => {
    renderApp(<HandoffProgress view={view({ step: "copying", bytes: 120 * 1024 ** 2, total: 480 * 1024 ** 2 })} onCancel={() => {}} />);
    const steps = [...document.querySelectorAll("[data-handoff-step]")];
    expect(steps.map((step) => `${step.getAttribute("data-handoff-step")}:${step.getAttribute("data-state")}`)).toEqual([
      "connecting:done", "copying:now", "ready:next", "rest:next", "checking:next", "switching:next", "settling:next",
    ]);
    expect(steps[1]).toHaveAttribute("aria-current", "step");
    expect(screen.getByTestId("handoff-line")).toHaveTextContent("Copying files · 120 MB of 480 MB");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByTestId("handoff-cancel")).toHaveTextContent("Cancel");
    expect(screen.getByTestId("handoff-progress")).toHaveTextContent("Nothing changes until the last step.");
  });

  it("says where a dropped copy stopped, and that it goes on by itself", () => {
    renderApp(<HandoffProgress view={view({ step: "paused", bytes: 60, total: 100 })} onCancel={() => {}} />);
    expect(screen.getByTestId("handoff-line")).toHaveTextContent("Stopped at 60%. It resumes when both devices are online.");
    expect(screen.getByTestId("handoff-cancel")).toBeInTheDocument();
  });

  it("keeps why the last step waits behind its ⓘ, and offers no Cancel there", async () => {
    const { user } = renderApp(<HandoffProgress view={view({ step: "settling" })} onCancel={() => {}} />);
    expect(screen.getByTestId("handoff-line")).toHaveTextContent("Checking which device is active · about 30 seconds");
    expect(screen.queryByTestId("handoff-settle-text")).toBeNull();
    await user.click(screen.getByTestId("handoff-settle-info"));
    expect(screen.getByTestId("handoff-settle-text")).toHaveTextContent("Ghostly waits to be sure no other device took over at the same moment.");
    expect(screen.queryByTestId("handoff-cancel")).toBeNull();
  });

  it("says a phone that was woken must open Ghostly, and on a phone to keep Ghostly open", () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    renderApp(<HandoffProgress view={view({ step: "connecting", woken: true })} />);
    expect(screen.getByTestId("handoff-line")).toHaveTextContent("Open Ghostly on MacBook and keep it open. A notice was sent to it.");
    expect(screen.getByTestId("handoff-keep-open")).toHaveTextContent("Keep Ghostly open.");
  });

  it("a failure is one line read out at once, with no steps", () => {
    renderApp(<HandoffProgress view={view({ step: "failed", failure: "password" })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Wrong password.");
    expect(document.querySelector("[data-handoff-step]")).toBeNull();
  });
});

describe("the forced takeover", () => {
  it("asks Lost or stolen as two choices with a line each, and why behind the ⓘ", async () => {
    const { user } = renderApp(<TakeoverDialog device="iPhone" password onClose={() => {}} />);
    const group = screen.getByRole("group", { name: "Lost or stolen?" });
    expect(within(group).getByRole("radio", { name: /Lost or stolen/ })).toBeInTheDocument();
    expect(group).toHaveTextContent("After the takeover, a checklist helps protect your money and chats.");
    expect(group).toHaveTextContent("It stops if it ever comes back.");
    expect(screen.getByTestId("takeover-go")).toBeDisabled();
    await user.click(screen.getByTestId("takeover-lost-no"));
    await user.type(screen.getByTestId("takeover-password"), "a long lock password");
    // The name to type is labelled, and the field shows what to type.
    await user.type(screen.getByLabelText("Type iPhone to confirm"), "iPhone");
    expect(screen.getByTestId("takeover-go")).toBeEnabled();
    await user.click(screen.getByTestId("takeover-info"));
    expect(screen.getByTestId("takeover-info-text")).toHaveTextContent("Messages and money that reached iPhone after that are not here.");
  });
});

describe("the standby screen", () => {
  it("lists the other devices with their links, and the other profiles under their own heading", async () => {
    createProfile("Work");
    fakeEngine.on("deviceSet", () => set({ state: "standby", devices: set().devices.map((device) => ({ ...device, self: device.key === PHONE, active: device.key === DESKTOP, status: device.key === PHONE ? undefined : device.status })) }));
    fakeEngine.on("deviceHandoffView", () => null);
    fakeEngine.on("deviceTakeoverInfo", () => ({ offered: false }));
    renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "MacBook" }} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Active on MacBook");
    const devices = await screen.findByRole("region", { name: "Your devices" });
    const links = within(devices).getAllByTestId("device-standby-link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveTextContent("MacBook");
    expect(links[0]).toHaveTextContent("Active");
    expect(screen.getByRole("navigation", { name: "Other profiles" })).toHaveTextContent("Switch to Work");
    expect(screen.getByRole("button", { name: "Use here" })).toBeInTheDocument();
  });

  it("a device that released the profile and has not heard back: the step it waits at, and Use here all the same", async () => {
    fakeEngine.on("deviceSet", () => set({ state: "standby", devices: set().devices.map((device) => ({ ...device, self: device.key === DESKTOP, active: device.key === PHONE })) }));
    fakeEngine.on("deviceHandoffView", () => ({ role: "giver", device: "iPhone", key: PHONE, step: "switching", bytes: 0, total: 0 }) satisfies HandoffView);
    fakeEngine.on("deviceTakeoverInfo", () => ({ offered: false }));
    const { user } = renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "iPhone" }} />);
    expect(await screen.findByTestId("handoff-progress")).toHaveAttribute("data-step", "switching");
    const useHere = await screen.findByTestId("handoff-use-here");
    expect(useHere).toHaveTextContent("Use here");
    await user.click(useHere);
    expect(screen.getByTestId("handoff-use-here-dialog")).toBeInTheDocument();
  });

  it("a move whose copy stopped: the line read out at once, and Try again in place of Use here", async () => {
    fakeEngine.on("deviceSet", () => set({ state: "standby", devices: set().devices.map((device) => ({ ...device, self: device.key === PHONE, active: device.key === DESKTOP })) }));
    fakeEngine.on("deviceHandoffView", () => ({ role: "taker", device: "MacBook", key: DESKTOP, step: "failed", bytes: 0, total: 0, failure: "stalled" }) satisfies HandoffView);
    fakeEngine.on("deviceTakeoverInfo", () => ({ offered: false }));
    const { user } = renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "MacBook" }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The move stopped: no answer from MacBook for 2 minutes.");
    const again = await screen.findByTestId("handoff-use-here");
    expect(again).toHaveTextContent("Try again");
    await user.click(again);
    expect(screen.getByTestId("handoff-use-here-dialog")).toBeInTheDocument();
  });

  it("a device that took the profile and could not check which device is active: the line read out, and Try again checks again", async () => {
    fakeEngine.on("deviceSet", () => set({ state: "standby", devices: set().devices.map((device) => ({ ...device, self: device.key === PHONE, active: device.key === DESKTOP })) }));
    fakeEngine.on("deviceHandoffView", () => ({ role: "taker", device: "MacBook", key: DESKTOP, step: "failed", bytes: 0, total: 0, failure: "settle" }) satisfies HandoffView);
    fakeEngine.on("deviceTakeoverInfo", () => ({ offered: false }));
    const settle = vi.fn(() => null);
    fakeEngine.on("deviceHandoffSettle", settle);
    const { user } = renderApp(<DeviceStandby gate={{ state: "taking", activeDevice: "MacBook" }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Can't check which device is active. Check your connection, then try again.");
    // Not Use here: the profile is already this device's to take.
    expect(screen.queryByTestId("handoff-use-here")).toBeNull();
    await user.click(await screen.findByTestId("handoff-settle-retry"));
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("fills the window, and offers no Use here while the new device list waits for an answer", async () => {
    fakeEngine.on("deviceSet", () => set({ state: "standby" }));
    fakeEngine.on("deviceHandoffView", () => null);
    fakeEngine.on("deviceTakeoverInfo", () => ({ offered: false }));
    renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "MacBook", notice: ["MacBook", "iPhone"] }} />);
    // The app's root is a flex row: the screen takes all of it, not the width of its words.
    expect(screen.getByTestId("device-standby").className).toMatch(/\bflex-1\b/);
    expect(await screen.findByTestId("device-set-notice-title")).toHaveTextContent("Your devices are now: MacBook and iPhone");
    expect(screen.queryByTestId("handoff-use-here")).toBeNull();
  });

  it("a state that cannot be read: Can't read this device's state, Nothing was started, and how to recover behind the ⓘ", async () => {
    const { user } = renderApp(<DeviceStandby gate={{ state: "unreadable" }} />);
    expect(screen.getByTestId("device-standby-title")).toHaveTextContent("Can't read this device's state");
    expect(screen.getByTestId("device-standby")).toHaveTextContent("Nothing was started.");
    await user.click(screen.getByTestId("device-standby-info"));
    expect(screen.getByTestId("device-standby-text")).toHaveTextContent("Restart the app or the device, then try again.");
  });
});

describe("a limited start (WISP 06 § When a device checks)", () => {
  beforeEach(() => resetLimitedStart());

  it("asks first: Try again starts the app again, Start anyway opens it, and a line says why nothing goes out", async () => {
    fakeEngine.setState({ limited: true });
    const restart = vi.fn(async () => {});
    const reload = vi.fn();
    (fakeEngine as BrowserHost).restartEngine = restart;
    try {
      render(<Root />);
      const ask = await screen.findByTestId("limited-start");
      // The reload itself is left out: the test stays on this page.
      const location = vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload } as Location);
      expect(ask).toHaveAttribute("role", "alertdialog");
      expect(screen.getByTestId("limited-start-title")).toHaveTextContent("Can't check which device is active");
      expect(ask).toHaveTextContent("Check your connection.");
      expect(screen.queryByTestId("sidebar")).toBeNull();
      expect(screen.getByTestId("limited-start-retry")).toHaveFocus();
      act(() => screen.getByTestId("limited-start-info").click());
      expect(screen.getByTestId("limited-start-text")).toHaveTextContent("nothing is sent, paid or received until the check works");
      act(() => screen.getByTestId("limited-start-retry").click());
      await waitFor(() => expect(reload).toHaveBeenCalled());
      expect(restart).toHaveBeenCalled();
      location.mockRestore();

      act(() => screen.getByTestId("limited-start-go-on").click());
      expect(await screen.findByTestId("sidebar")).toBeInTheDocument();
      expect(screen.queryByTestId("limited-start")).toBeNull();
      expect(await screen.findByTestId("limited-banner", {}, { timeout: 3_000 })).toHaveTextContent("Offline until Ghostly can check which device is active");
      // The first good read ends it: the line goes.
      act(() => fakeEngine.setState({}));
      await waitFor(() => expect(screen.queryByTestId("limited-banner")).toBeNull());
    } finally { delete (fakeEngine as BrowserHost).restartEngine; }
  });

  it("a check while going online is not a limited start: no question, and the line only once it lasts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    renderApp(<LimitedBanner />);
    act(() => fakeEngine.setState({ limited: true }));
    expect(screen.queryByTestId("limited-start")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(screen.queryByTestId("limited-banner")).toBeNull();
    // Over in a moment: nothing was shown.
    act(() => fakeEngine.setState({}));
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(screen.queryByTestId("limited-banner")).toBeNull();
    act(() => fakeEngine.setState({ limited: true }));
    await act(async () => { vi.advanceTimersByTime(2_500); });
    expect(screen.getByTestId("limited-banner")).toHaveTextContent("Messages you write wait until then.");
  });

  it("a restored copy checking its turn asks nothing: the app opens, a line says why it is offline, the reason behind the ⓘ", async () => {
    fakeEngine.setState({ limited: true, restoreCheck: "checking" });
    render(<Root />);
    expect(await screen.findByTestId("sidebar")).toBeInTheDocument();
    expect(screen.queryByTestId("limited-start")).toBeNull();
    const line = screen.getByTestId("restore-limited-banner");
    expect(line).toHaveTextContent("Restored copy, offline for now");
    expect(line).toHaveTextContent("Checking whether your profile runs on another device.");
    act(() => screen.getByTestId("restore-limited-info").click());
    expect(screen.getByTestId("restore-limited-text")).toHaveTextContent("this copy goes on standby; if none does, it starts by itself");
    // A tombstone: only the person starts it as a profile of its own, by typing its name.
    act(() => fakeEngine.setState({ limited: true, restoreCheck: "removed" }));
    expect(screen.getByTestId("restore-limited-banner")).toHaveTextContent("This backup is from before a device was removed.");
    // The read says no device runs it: limited mode ends and the line goes.
    act(() => fakeEngine.setState({}));
    await waitFor(() => expect(screen.queryByTestId("restore-limited-banner")).toBeNull());
  });
});

describe("the account switcher", () => {
  beforeEach(() => { fakeEngine.features = { ...fakeEngine.features, profiles: true }; });
  afterEach(() => { fakeEngine.features = { ...fakeEngine.features, profiles: false }; });

  it("shows Standby in place of the counts for a profile on standby here, and its name says so", async () => {
    const work = createProfile("Work");
    const prefix = `ghostly_${namespaceOf(work.id)}_`;
    localStorage.setItem(`${prefix}chat1`, JSON.stringify({ id: "chat1", mySeedB64: "s", peerPubKeyB64: "p", encKeyB64: "e", createdAt: 0, messages: [{ id: "m0" }, { id: "m1" }] }));
    states.set(`ghostly_${namespaceOf(work.id)}`, "standby");
    const { user } = renderApp(<AccountBar />);
    await user.click(screen.getByTestId("account-profile"));
    const item = await screen.findByRole("menuitemradio", { name: "Switch to Work, Standby" });
    expect(within(item).getByTestId("profile-switcher-standby")).toHaveTextContent("Standby");
    expect(within(item).queryByTestId("profile-switcher-unread")).toBeNull();
  });
});

describe("Settings, when contacts hold another device's push address", () => {
  afterEach(() => setPushPlatform(null));

  it("says this device is not woken by it, and which device is", async () => {
    setPushPlatform({ supported: () => true, subscribe: vi.fn(), current: vi.fn(async () => null), unsubscribe: vi.fn(), syncTable: vi.fn(async () => {}) } as unknown as PushPlatform);
    fakeEngine.on("deviceSet", () => set({ devices: set().devices.map((device) => ({ ...device, self: device.key === DESKTOP })) }));
    const wake = { endpoint: "https://fcm.googleapis.com/fcm/send/phone", p256dh: "p", auth: "a", vapid: { publicKey: "v", privateKey: "k" }, device: PHONE };
    fakeEngine.setState({ ...engineState({ settings: { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true, wake } as never }), wakeOwner: "away" });
    renderApp(<LockScreenProvider><UpdateProvider><Settings /></UpdateProvider></LockScreenProvider>);
    await waitFor(() => expect(screen.getByTestId("settings-wake-hint")).toHaveTextContent("Off here. Contacts wake iPhone for now."));
    expect(screen.getByTestId("settings-wake")).toHaveAttribute("aria-checked", "false");
  });
});
