import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLink, encodeInviteCode } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import type { BrowserHost } from "@ghostly/browser/host";
import type { DeviceGate, DeviceGateView } from "@ghostly/browser/devices/gate";
import { Root } from "../../Root";
import { DeviceStandby } from "../../components/DeviceStandby";
import { desktopDeviceMirror } from "../../desktop/deviceMirror";
import { createProfile, lastRouteOf, switchProfile } from "../../lib/profiles";
import { locales } from "../../locales";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: devices.gate, devices.standby-screen

// What the page itself read before it drew anything (the entry points await `openDeviceGate`): set by a test.
const page = vi.hoisted(() => ({ gate: undefined as DeviceGate | undefined }));
vi.mock("@ghostly/browser/devices/gate", async (original) => ({ ...(await original<typeof import("@ghostly/browser/devices/gate")>()), knownDeviceGate: () => page.gate }));
const standbyPage = (view: DeviceGateView): DeviceGate => ({ profile: "ghostly", state: view.state, full: false, view });

/*
 * The standby screen (WISP 06 § The gate, § User experience): on a device that is not the active one for the profile,
 * the app shows which state the device is in and nothing of the profile. No chat list, no composer, and no link
 * intake: an invite opened there must not be written into a copy that has to stay as it is.
 */

const gate = (view: DeviceGateView) => act(() => fakeEngine.emit({ kind: "device-gate", gate: view }));
afterEach(() => { page.gate = undefined; window.location.hash = ""; });

describe("the app on a device that is not the active one", () => {
  it("shows the standby screen in place of the whole app, and comes back when the engine runs", async () => {
    render(<Root />);
    expect(await screen.findByTestId("sidebar")).toBeInTheDocument();
    expect(screen.queryByTestId("device-standby")).toBeNull();

    gate({ state: "standby", activeDevice: "MacBook" });
    const standby = screen.getByTestId("device-standby");
    expect(standby).toHaveAttribute("data-state", "standby");
    expect(screen.getByTestId("device-standby-title")).toHaveTextContent("Active on MacBook");
    expect(standby).toHaveTextContent("This device is on standby for this profile.");
    expect(screen.queryByTestId("sidebar")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();

    // An engine that runs again (the extension's, started as the active device) takes the screen away.
    act(() => fakeEngine.setState({}));
    expect(await screen.findByTestId("sidebar")).toBeInTheDocument();
    expect(screen.queryByTestId("device-standby")).toBeNull();
  });

  it("shows it from the first paint when the page read the state itself, before the peer says anything", () => {
    page.gate = standbyPage({ state: "superseded" });
    render(<Root />);
    expect(screen.getByTestId("device-standby")).toHaveAttribute("data-state", "superseded");
    expect(screen.queryByTestId("sidebar")).toBeNull();
  });

  it("takes in no invite link and saves no settings: nothing is written to the profile's storage", async () => {
    page.gate = standbyPage({ state: "standby" });
    window.location.hash = `#/chat/${encodeInviteCode(createLink().invite)}`;
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ language: "pt" }));
    const before = JSON.stringify(Object.entries(localStorage));
    render(<Root />);
    expect(screen.getByTestId("device-standby-title")).toHaveTextContent("Ativo em outro dispositivo");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(JSON.stringify(Object.entries(localStorage))).toBe(before);
    // No engine call was made for it either: only the standby screen's own reads of the device set, which device-link-only
    // mode answers without the profile.
    expect(fakeEngine.calls.filter((call) => !String(call.method).startsWith("device"))).toEqual([]);
  });

  it("the same link on a device that runs the profile is taken in (what the standby must not do)", async () => {
    window.location.hash = `#/chat/${encodeInviteCode(createLink().invite)}`;
    const before = Object.keys(localStorage).length;
    render(<Root />);
    await waitFor(() => expect(window.location.hash).not.toContain("/chat/pair"));
    await waitFor(() => expect(Object.keys(localStorage).length).toBeGreaterThan(before + 1));
  });

  it("is behind the lock screen", async () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", salt: "y" } }));
    gate({ state: "standby", activeDevice: "MacBook" });
    render(<Root />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.queryByTestId("device-standby")).toBeNull();
    expect(document.body).not.toHaveTextContent("Active on MacBook");
  });
});

describe("the standby screen", () => {
  const cases: [DeviceGateView, string, string][] = [
    [{ state: "standby", activeDevice: "Phone" }, "Active on Phone", "This device is on standby for this profile."],
    [{ state: "standby" }, "Active on another device", "This device is on standby for this profile."],
    [{ state: "releasing" }, "Moving to another device", "Nothing changes until the last step."],
    [{ state: "taking" }, "Finishing", "Waiting for the network."],
    [{ state: "superseded" }, "This device was replaced", "Another device took over without this one. This device has stopped."],
    [{ state: "moving" }, "Almost there", "Open Ghostly on the device you use now to finish."],
    [{ state: "removed" }, "This device was removed", "Add it again from the device you use now."],
    [{ state: "unreadable", detail: "UnknownError: Internal error" }, "Can't read this device's state", "Nothing was started."],
  ];

  it.each(cases)("says each state in one line and a hint: %o", (view, title, hint) => {
    renderApp(<DeviceStandby gate={view} />);
    expect(screen.getByTestId("device-standby")).toHaveAttribute("data-state", view.state);
    expect(screen.getByTestId("device-standby-title")).toHaveTextContent(title);
    expect(screen.getByTestId("device-standby")).toHaveTextContent(hint);
    // Nothing offers to delete anything, and no takeover yet (part 6). A standby offers Use here (the handoff, part 5).
    expect(screen.queryByRole("button", { name: /delete|reset|clear|take over/i })).toBeNull();
    expect(!!screen.queryByRole("button", { name: "Use here" })).toBe(view.state === "standby");
    expect(!!screen.queryByTestId("device-standby-retry")).toBe(view.state === "unreadable");
  });

  it("keeps why behind the ⓘ, and the system's words for a state that could not be read", async () => {
    const user = userEvent.setup();
    const view = renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "MacBook" }} />);
    expect(screen.queryByTestId("device-standby-text")).toBeNull();
    await user.click(screen.getByRole("button", { name: "More info" }));
    expect(screen.getByTestId("device-standby-text")).toHaveTextContent("Only one device sends, receives and pays at a time, so your messages and money are never in two places.");
    view.unmount();

    renderApp(<DeviceStandby gate={{ state: "unreadable", detail: "VersionError: The requested version (1) is less than the existing version (2)." }} />);
    await user.click(screen.getByRole("button", { name: "More info" }));
    const text = screen.getByTestId("device-standby-text");
    expect(text).toHaveTextContent("nothing was started, nothing was sent and nothing was changed");
    expect(text).toHaveTextContent("VersionError: The requested version (1) is less than the existing version (2).");
  });

  it("Try again starts the peer anew where it outlives the page (the extension), then reloads", async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    const reload = vi.fn(() => { order.push("reload"); });
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload } as Location);
    (fakeEngine as BrowserHost).restartEngine = vi.fn(async () => { order.push("restart"); });
    try {
      renderApp(<DeviceStandby gate={{ state: "unreadable" }} />);
      await user.click(screen.getByTestId("device-standby-retry"));
      await waitFor(() => expect(order).toEqual(["restart", "reload"]));
    } finally { delete (fakeEngine as BrowserHost).restartEngine; }
    // Where the peer lives in the page (web, Desktop) the reload alone starts it again.
    order.length = 0;
    renderApp(<DeviceStandby gate={{ state: "unreadable" }} />);
    await user.click(screen.getAllByTestId("device-standby-retry").slice(-1)[0]);
    await waitFor(() => expect(order).toEqual(["reload"]));
  });

  it("leaves the person's other profiles one click away", () => {
    createProfile("Work");
    renderApp(<DeviceStandby gate={{ state: "standby" }} />);
    expect(screen.getByTestId("device-standby-switch")).toHaveTextContent("Work");
  });

  it("a switch to another profile leaves the standby profile's storage as it was", () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const work = createProfile("Work");
      const other = createProfile("Home");
      window.location.hash = "#/wallet";
      page.gate = standbyPage({ state: "standby" });
      const before = JSON.stringify(Object.entries(localStorage));
      switchProfile(work.id);
      expect(JSON.stringify(Object.entries(localStorage))).toBe(before);
      expect(lastRouteOf("")).toBe("/");
      // The same switch from a profile that runs here remembers where it was.
      page.gate = undefined;
      switchProfile(other.id);
      expect(lastRouteOf("")).toBe("/wallet");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("is in the app's language", () => {
    renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "MacBook" }} />, { language: "pt" });
    expect(screen.getByTestId("device-standby-title")).toHaveTextContent("Ativo em MacBook");
  });

  it("has every string in all eight languages, with the device's name where English has it", () => {
    const english = locales.en.devices.standby;
    for (const [language, dict] of Object.entries(locales)) {
      const standby = (dict as typeof locales.en).devices.standby;
      expect(Object.keys(standby.title).sort(), language).toEqual(Object.keys(english.title).sort());
      expect(Object.keys(standby.hint).sort(), language).toEqual(Object.keys(english.hint).sort());
      expect(standby.title.standby, language).toContain("{{device}}");
      for (const text of [...Object.values(standby.title), ...Object.values(standby.hint), standby.info, standby.unreadableInfo]) {
        expect(text.trim().length, language).toBeGreaterThan(0);
        expect(text, language).not.toContain("—");
      }
    }
  });
});

describe("Desktop's device state file", () => {
  it("is read and written through the two Rust commands, by profile", async () => {
    const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>) => (command === "device_state_read" ? "{\"state\":\"standby\"}" : undefined));
    const mirror = desktopDeviceMirror(invoke as never);
    expect(await mirror.read("ghostly_work")).toBe("{\"state\":\"standby\"}");
    await mirror.write("ghostly_work", "{}");
    await mirror.write("ghostly_work", null);
    expect(invoke.mock.calls).toEqual([
      ["device_state_read", { profile: "ghostly_work" }],
      ["device_state_write", { profile: "ghostly_work", record: "{}" }],
      ["device_state_write", { profile: "ghostly_work", record: null }],
    ]);
    expect(engine.deviceGate).toBeNull();
  });
});
