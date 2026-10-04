import { renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import type { HandoffView } from "@ghostly/browser/devices/handoff";
import { DevicesSection } from "../../components/devices/DevicesSection";
import { handoffRunning, hasStandby, keepAwakeWanted, useComputerAwake } from "../../lib/keepAwake";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
// covers: devices.keep-awake

/*
 * "Keep this computer awake" (WISP 06 § User experience, Profile, Devices): on a Desktop with a standby device, a switch
 * of this device's own; and a handoff in progress keeps the computer awake on either side.
 */

const DESKTOP = "D".repeat(43), PHONE = "P".repeat(43);
const active: DeviceSetView = { state: "active", devices: [{ key: DESKTOP, name: "Desktop", slot: 0, self: true, active: true }, { key: PHONE, name: "Phone", slot: 1, self: false, active: false, status: "connecting" }] };
const alone: DeviceSetView = { state: "active", devices: [{ key: DESKTOP, name: "Desktop", slot: 0, self: true, active: true }] };
const handoff = (step: HandoffView["step"]): HandoffView => ({ role: "giver", device: "Phone", key: PHONE, step, bytes: 0, total: 0 });

afterEach(() => { localStorage.clear(); fakeEngine.keepAwake = undefined; });

describe("when the computer is kept awake", () => {
  it("with the switch on and a standby device; and during a handoff on either side, switch or not", () => {
    expect(hasStandby(active)).toBe(true);
    expect(hasStandby(alone)).toBe(false);
    expect(hasStandby({ ...active, state: "standby" })).toBe(false);
    expect(keepAwakeWanted(true, active, null)).toBe(true);
    expect(keepAwakeWanted(false, active, null)).toBe(false);
    expect(keepAwakeWanted(true, alone, null)).toBe(false);
    expect(keepAwakeWanted(false, null, handoff("copying"))).toBe(true);
    expect(keepAwakeWanted(false, null, { ...handoff("settling"), role: "taker" })).toBe(true);
    for (const step of ["failed", "done", "offer"] as const) expect(handoffRunning(handoff(step))).toBe(false);
  });
});

describe("the switch", () => {
  it("shows on a Desktop with a standby device, and holds the computer awake while it is on", async () => {
    const keepAwake = vi.fn(async (on: boolean) => on);
    fakeEngine.keepAwake = keepAwake;
    fakeEngine.on("deviceSet", () => active);
    fakeEngine.on("deviceHandoffView", () => null);
    fakeEngine.on("deviceTurnCheck", () => null);
    const { user } = renderApp(<DevicesSection />);
    renderHook(() => useComputerAwake());
    const toggle = await screen.findByTestId("device-keep-awake-switch");
    // Why, behind its ⓘ.
    await user.click(within(screen.getByTestId("device-keep-awake")).getByTestId("row-info"));
    expect(screen.getByTestId("device-keep-awake")).toHaveTextContent("So your phone can take over while you are out.");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await waitFor(() => expect(keepAwake).toHaveBeenLastCalledWith(false));
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(keepAwake).toHaveBeenLastCalledWith(true));
    // This device's own: kept in this app's storage, never in the profile's settings.
    expect(localStorage.getItem("ghostly_keep_awake")).toBe("1");
    expect(fakeEngine.callsTo("updateSettings")).toEqual([]);
    await user.click(toggle);
    await waitFor(() => expect(keepAwake).toHaveBeenLastCalledWith(false));
  });

  it("is not there where the app cannot keep its computer awake, nor without a standby device", async () => {
    fakeEngine.on("deviceSet", () => active);
    fakeEngine.on("deviceTurnCheck", () => null);
    renderApp(<DevicesSection />);
    await screen.findAllByTestId("device-row");
    expect(screen.queryByTestId("device-keep-awake")).toBeNull();
  });
});
