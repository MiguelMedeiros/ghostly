import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceGate, DeviceGateView } from "@ghostly/browser/devices/gate";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import { Root } from "../../Root";
import { fakeEngine } from "../fakeEngine";

// covers: devices.standby-screen, app.mobile-layout

/*
 * The standby screen on a phone with its on-screen keyboard up (WISP 06 § The standby screen): Root draws it in place of
 * the app, so the app's own keeper of the visible height is not there. Use here asks for the lock password in a dialog,
 * which must stand above the keyboard as every other dialog does (index.css `html[data-keyboard="true"] dialog:modal`),
 * or its field and its Use here button are under it.
 */

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

const page = vi.hoisted(() => ({ gate: undefined as DeviceGate | undefined }));
vi.mock("@ghostly/browser/devices/gate", async (original) => ({ ...(await original<typeof import("@ghostly/browser/devices/gate")>()), knownDeviceGate: () => page.gate }));
const standbyPage = (view: DeviceGateView): DeviceGate => ({ profile: "ghostly", state: view.state, full: false, view });

const DESKTOP = "D".repeat(43), PHONE = "P".repeat(43);
const standbySet: DeviceSetView = {
  state: "standby",
  devices: [
    { key: DESKTOP, name: "MacBook", slot: 0, self: false, active: true, status: "live" },
    { key: PHONE, name: "iPhone", slot: 1, self: true, active: false },
  ],
};

/** A phone's visual viewport the test moves: 375×667, a touch screen. */
class Viewport extends EventTarget {
  width = 375;
  height = 667;
  offsetTop = 0;
}
let viewport: Viewport;

beforeEach(() => {
  viewport = new Viewport();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  Object.defineProperty(window, "innerHeight", { configurable: true, get: () => 667 });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => 5 });
});
afterEach(() => {
  page.gate = undefined;
  Reflect.deleteProperty(window, "visualViewport");
  Reflect.deleteProperty(window, "innerHeight");
  Reflect.deleteProperty(navigator, "maxTouchPoints");
  delete document.documentElement.dataset.keyboard;
});

describe("the standby screen with the keyboard up", () => {
  it("puts Use here's dialog in what the keyboard leaves, as the app does for its own dialogs", async () => {
    fakeEngine.on("deviceSet", () => standbySet);
    fakeEngine.on("deviceHandoffView", () => null);
    fakeEngine.on("deviceTakeoverInfo", () => ({ offered: false }));
    page.gate = standbyPage({ state: "standby", activeDevice: "MacBook" });
    const user = userEvent.setup();
    render(<Root />);

    await user.click(await screen.findByTestId("handoff-use-here"));
    const dialog = screen.getByTestId("handoff-use-here-dialog");
    expect(screen.getByTestId("handoff-password")).toHaveFocus();

    // iOS keeps the page's height and only the visual viewport gets shorter: 300px of keyboard leave 367.
    viewport.height = 367;
    act(() => { viewport.dispatchEvent(new Event("resize")); });
    expect(document.documentElement.dataset.keyboard).toBe("true");
    expect(dialog.style.getPropertyValue("--app-height")).toBe("367px");

    // Down again: the whole screen.
    viewport.height = 667;
    act(() => { viewport.dispatchEvent(new Event("resize")); });
    expect(document.documentElement.dataset.keyboard).toBe("false");
    expect(dialog.style.getPropertyValue("--app-height")).toBe("667px");
  });
});
