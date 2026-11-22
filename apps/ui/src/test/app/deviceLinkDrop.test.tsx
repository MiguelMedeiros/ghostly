import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import { DeviceStandby } from "../../components/DeviceStandby";
import { DevicesSection } from "../../components/devices/DevicesSection";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: devices.screens

/*
 * A device's link goes from Connected to Not connected often (a phone asleep, a change of network). What its row
 * offers only while it is connected (Move to, Check connection, a ⋮ holding only Check connection) then goes. When it
 * had the keyboard focus, the focus stays on that row (what is left on it, else the row), never on the page.
 */

const DESKTOP = "D".repeat(43), PHONE = "P".repeat(43), TABLET = "T".repeat(43);
type Status = "live" | "connecting";

/** The set seen from the active MacBook, the tablet's link as `status()` says. */
const activeSet = (status: () => Status): DeviceSetView => ({
  state: "active",
  devices: [
    { key: DESKTOP, name: "MacBook", slot: 0, self: true, active: true },
    { key: PHONE, name: "iPhone", slot: 1, self: false, active: false, status: "live" },
    { key: TABLET, name: "Tablet", slot: 2, self: false, active: false, status: status() },
  ],
});

/** The same set seen from the iPhone, on standby; the MacBook (active) linked as `status()` says. */
const standbySet = (status: () => Status): DeviceSetView => ({
  state: "standby",
  devices: [
    { key: DESKTOP, name: "MacBook", slot: 0, self: false, active: true, status: status() },
    { key: PHONE, name: "iPhone", slot: 1, self: true, active: false },
  ],
});

afterEach(() => { vi.useRealTimers(); });

/** Lets `ms` of the faked clock pass (the set is read every 3 s), and what it started settle. */
const later = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

const rowOf = (name: string) => screen.getAllByTestId("device-row").find((row) => row.textContent?.includes(name))!;

describe("a device's link drops under the keyboard focus", () => {
  it("Move to goes from the row of a device no longer connected, and the focus goes to that row's ⋮", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
    let status: Status = "live";
    fakeEngine.on("deviceSet", () => activeSet(() => status));
    fakeEngine.on("deviceHandoffView", () => null);
    renderApp(<DevicesSection />);
    await later(0);
    const move = within(rowOf("Tablet")).getByTestId("device-move");
    act(() => move.focus());
    expect(move).toHaveFocus();
    status = "connecting";
    await later(3_000);
    const tablet = rowOf("Tablet");
    expect(within(tablet).getByTestId("device-link-status")).toHaveAttribute("data-status", "connecting");
    expect(within(tablet).queryByTestId("device-move")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(within(tablet).getByTestId("device-menu")).toHaveFocus();
  });

  it("on a standby, the ⋮ that held only Check connection goes, and the focus goes to the row", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
    let status: Status = "live";
    fakeEngine.on("deviceSet", () => standbySet(() => status));
    fakeEngine.on("deviceHandoffView", () => null);
    renderApp(<DevicesSection />);
    await later(0);
    const menu = within(rowOf("MacBook")).getByTestId("device-menu");
    act(() => menu.focus());
    status = "connecting";
    await later(3_000);
    const mac = rowOf("MacBook");
    expect(within(mac).queryByTestId("device-menu")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(mac).toHaveFocus();
    // The row is a stop only while it holds that focus: once the focus leaves, Tab no longer stops on it.
    act(() => mac.blur());
    expect(mac).not.toHaveAttribute("tabindex");
  });

  it("the standby screen's Check connection goes, and the focus goes to that device's line in the list", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
    let status: Status = "live";
    fakeEngine.on("deviceSet", () => standbySet(() => status));
    fakeEngine.on("deviceHandoffView", () => null);
    fakeEngine.on("deviceTakeoverInfo", () => ({ offered: false }));
    renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "MacBook" }} />);
    await later(0);
    const [mac] = screen.getAllByTestId("device-standby-link");
    const check = within(mac).getByTestId("device-standby-check");
    act(() => check.focus());
    status = "connecting";
    await later(3_000);
    expect(mac).toHaveAttribute("data-status", "connecting");
    expect(within(mac).queryByTestId("device-standby-check")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(mac).toHaveFocus();
  });

  it("Check connection goes from an open ⋮ menu, and the focus stays on that row", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
    let status: Status = "live";
    fakeEngine.on("deviceSet", () => activeSet(() => status));
    fakeEngine.on("deviceHandoffView", () => null);
    renderApp(<DevicesSection />);
    await later(0);
    act(() => within(rowOf("Tablet")).getByTestId("device-menu").click());
    await later(0);
    expect(screen.getByTestId("device-check")).toHaveFocus();
    status = "connecting";
    await later(3_000);
    expect(screen.queryByTestId("device-check")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(rowOf("Tablet").contains(document.activeElement)).toBe(true);
  });

  it("a focus the person moved elsewhere first is left where it is", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
    let status: Status = "live";
    fakeEngine.on("deviceSet", () => activeSet(() => status));
    fakeEngine.on("deviceHandoffView", () => null);
    renderApp(<DevicesSection />);
    await later(0);
    act(() => within(rowOf("Tablet")).getByTestId("device-move").focus());
    const other = within(rowOf("iPhone")).getByTestId("device-move");
    act(() => other.focus());
    status = "connecting";
    await later(3_000);
    expect(within(rowOf("Tablet")).queryByTestId("device-move")).toBeNull();
    expect(other).toHaveFocus();
  });
});
