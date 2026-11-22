import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import type { HandoffView } from "@ghostly/browser/devices/handoff";
import { DevicesSection } from "../../components/devices/DevicesSection";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: devices.screens

/*
 * Profile's Devices section stays open for as long as the person reads Profile. On a profile with no move under way (one
 * device, the first run, a move never made) it asks its engine for the handoff as often as for the device set, every
 * 3 s, not twice a second; once there is a move, its steps are read twice a second again.
 */

const DESKTOP = "D".repeat(43), PHONE = "P".repeat(43);
const MINUTE = 60_000;
const one: DeviceSetView = { state: "single", devices: [{ key: DESKTOP, name: "MacBook", slot: 0, self: true, active: true }] };
const two: DeviceSetView = { state: "active", devices: [...one.devices, { key: PHONE, name: "iPhone", slot: 1, self: false, active: false, status: "live" }] };

/** Lets `ms` pass, the engine's answers included. */
const pass = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const asked = () => ({ handoff: fakeEngine.callsTo("deviceHandoffView").length, set: fakeEngine.callsTo("deviceSet").length });

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("Profile's Devices section with no move", () => {
  it("on one device, asks for the handoff as often as for the device set: every 3 s, not twice a second", async () => {
    fakeEngine.on("deviceSet", () => one).on("deviceHandoffView", () => null);
    renderApp(<DevicesSection />);
    await pass(0);
    const before = asked();
    await pass(MINUTE);
    expect(asked()).toEqual({ handoff: before.handoff + 20, set: before.set + 20 });
  });

  it("a move the other device starts shows within 3 s, and its steps are read twice a second", async () => {
    let view: HandoffView | null = null;
    fakeEngine.on("deviceSet", () => two).on("deviceHandoffView", () => view);
    renderApp(<DevicesSection />);
    await pass(MINUTE);
    view = { role: "giver", device: "iPhone", key: PHONE, step: "copying", bytes: 10, total: 100 };
    await pass(3_000);
    const running = screen.getByTestId("handoff-running");
    const before = asked().handoff;
    view = { ...view, bytes: 60 };
    await pass(500);
    expect(asked().handoff).toBe(before + 1);
    expect(within(running).getByTestId("handoff-line")).toHaveTextContent("Copying files");
    // Gone (cancelled on the other device): back to every 3 s.
    view = null;
    await pass(500);
    expect(screen.queryByTestId("handoff-running")).toBeNull();
    const after = asked().handoff;
    await pass(MINUTE);
    expect(asked().handoff).toBe(after + 20);
  });
});
