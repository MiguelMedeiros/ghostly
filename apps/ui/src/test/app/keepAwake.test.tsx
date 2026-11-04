import { act, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import type { HandoffView } from "@ghostly/browser/devices/handoff";
import { DevicesSection } from "../../components/devices/DevicesSection";
import type { FileTransferView } from "@ghostly/browser/shared/types";
import { filesMoving, handoffRunning, hasStandby, keepAwakeWanted, useComputerAwake } from "../../lib/keepAwake";
import { useDeviceSet } from "../../lib/devices";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
// covers: devices.keep-awake, files.keep-awake

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

describe("a file on its way", () => {
  const moving: FileTransferView = { state: "transferring", transferred: 10, size: 100, direction: "out", rate: 5 };

  it("keeps the device awake while it moves, is copied, waits its turn or is checked; not while it waits or after", () => {
    expect(filesMoving(undefined)).toBe(false);
    expect(filesMoving({})).toBe(false);
    expect(filesMoving({ a: moving })).toBe(true);
    for (const stage of ["preparing", "queued", "verifying"] as const) expect(filesMoving({ a: { ...moving, stage } })).toBe(true);
    // The contact away, a person to answer, paused: nothing comes of staying awake.
    for (const stage of ["waiting", "asking", "paused"] as const) expect(filesMoving({ a: { ...moving, stage } })).toBe(false);
    expect(filesMoving({ a: { ...moving, stalled: true } })).toBe(false);
    expect(filesMoving({ a: { ...moving, state: "done", transferred: 100 } })).toBe(false);
    expect(filesMoving({ a: { ...moving, state: "failed", error: "Cancelled" } })).toBe(false);
    // One moving among finished and waiting ones is enough.
    expect(filesMoving({ a: { ...moving, state: "done" }, b: { ...moving, stage: "waiting" }, c: moving })).toBe(true);
  });

  it("holds the Desktop's computer awake from the first file that moves until the last one ends", async () => {
    const keepAwake = vi.fn(async (on: boolean) => on);
    fakeEngine.keepAwake = keepAwake;
    fakeEngine.on("deviceSet", () => ({ state: "single", devices: [] }));
    fakeEngine.on("deviceHandoffView", () => null);
    renderHook(() => useComputerAwake());
    await waitFor(() => expect(keepAwake).toHaveBeenLastCalledWith(false, false));
    // A group's file and a chat's.
    act(() => fakeEngine.update({ transfers: { "group-g-in-1": { ...moving, direction: "in" }, "l-out-2": { ...moving, stage: "queued" } } }));
    await waitFor(() => expect(keepAwake).toHaveBeenLastCalledWith(true, true));
    act(() => fakeEngine.update({ transfers: { "group-g-in-1": { ...moving, state: "done" }, "l-out-2": moving } }));
    act(() => fakeEngine.update({ transfers: { "group-g-in-1": { ...moving, state: "done" }, "l-out-2": { ...moving, stage: "waiting" } } }));
    await waitFor(() => expect(keepAwake).toHaveBeenLastCalledWith(false, false));
    expect(keepAwake.mock.calls.filter(([on]) => on)).toHaveLength(1);
  });

  it("says when files are what holds it, so Android shows a notification for them (and holds nothing for the devices)", async () => {
    const keepAwake = vi.fn(async (on: boolean) => on);
    fakeEngine.keepAwake = keepAwake;
    localStorage.setItem("ghostly_keep_awake", "1");
    fakeEngine.on("deviceSet", () => active);
    fakeEngine.on("deviceHandoffView", () => null);
    renderHook(() => useComputerAwake());
    // Held for the standby device alone.
    await waitFor(() => expect(keepAwake).toHaveBeenLastCalledWith(true, false));
    // A file starts while it is held: told again, now for files too.
    act(() => fakeEngine.update({ transfers: { "l-in-1": { ...moving, direction: "in" } } }));
    await waitFor(() => expect(keepAwake).toHaveBeenLastCalledWith(true, true));
    act(() => fakeEngine.update({ transfers: { "l-in-1": { ...moving, direction: "in", state: "done" } } }));
    await waitFor(() => expect(keepAwake).toHaveBeenLastCalledWith(true, false));
  });
});

describe("how often the device set is asked for", () => {
  const single: DeviceSetView = { state: "single", devices: [] };
  const minute = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); };

  it("once for a profile on one device, and again every 5 s from the moment the page reads a device set", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const keepAwake = vi.fn(async (on: boolean) => on);
      fakeEngine.keepAwake = keepAwake;
      localStorage.setItem("ghostly_keep_awake", "1");
      let set = single;
      fakeEngine.on("deviceSet", () => set);
      fakeEngine.on("deviceHandoffView", () => null);
      renderHook(() => useComputerAwake());
      await minute();
      // No standby and no handoff can be there: nothing to look at again.
      expect(fakeEngine.callsTo("deviceSet")).toHaveLength(1);
      expect(fakeEngine.callsTo("deviceHandoffView")).toHaveLength(1);
      expect(keepAwake).not.toHaveBeenCalledWith(true);
      // A device was added here: Profile, Devices reads the set, and the checks start again.
      set = active;
      const page = renderHook(() => useDeviceSet(0));
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(page.result.current?.state).toBe("active");
      expect(keepAwake).toHaveBeenLastCalledWith(true, false);
      const before = fakeEngine.callsTo("deviceHandoffView").length;
      await minute();
      expect(fakeEngine.callsTo("deviceHandoffView").length - before).toBe(12);
    } finally { vi.useRealTimers(); }
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
    await waitFor(() => expect(keepAwake).toHaveBeenLastCalledWith(false, false));
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(keepAwake).toHaveBeenLastCalledWith(true, false));
    // This device's own: kept in this app's storage, never in the profile's settings.
    expect(localStorage.getItem("ghostly_keep_awake")).toBe("1");
    expect(fakeEngine.callsTo("updateSettings")).toEqual([]);
    await user.click(toggle);
    await waitFor(() => expect(keepAwake).toHaveBeenLastCalledWith(false, false));
  });

  it("is not there where the app cannot keep its computer awake, nor without a standby device", async () => {
    fakeEngine.on("deviceSet", () => active);
    fakeEngine.on("deviceTurnCheck", () => null);
    renderApp(<DevicesSection />);
    await screen.findAllByTestId("device-row");
    expect(screen.queryByTestId("device-keep-awake")).toBeNull();
  });
});
