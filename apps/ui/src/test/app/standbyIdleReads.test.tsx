import { Profiler } from "react";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import type { HandoffView } from "@ghostly/browser/devices/handoff";
import { DeviceStandby } from "../../components/DeviceStandby";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: devices.standby-screen

/*
 * A device on standby shows its screen for as long as the app is open: hours, days. What that screen asks its engine
 * on a timer (the handoff twice a second, the device set every 3 s) it asks only while someone can see it, and an
 * answer that says what the last one said draws nothing again.
 */

const DESKTOP = "D".repeat(43), PHONE = "P".repeat(43);
const set = (status: "live" | "connecting" = "live"): DeviceSetView => ({ state: "standby", devices: [
  { key: DESKTOP, name: "Desktop", slot: 0, self: true, active: false },
  { key: PHONE, name: "Phone", slot: 1, self: false, active: true, status },
] });
const MINUTE = 60_000;

let hidden = false;
function show(shown: boolean) {
  hidden = !shown;
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}
/** Lets `ms` pass, the engine's answers included. */
const pass = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const asked = () => ({ handoff: fakeEngine.callsTo("deviceHandoffView").length, set: fakeEngine.callsTo("deviceSet").length });

let draws = 0;
async function standby(handoff: () => HandoffView | null = () => null, devices: () => DeviceSetView = set) {
  fakeEngine.on("deviceSet", devices).on("deviceHandoffView", handoff).on("deviceTakeoverInfo", () => ({ offered: false }));
  draws = 0;
  renderApp(<Profiler id="standby" onRender={() => { draws += 1; }}><DeviceStandby gate={{ state: "standby", activeDevice: "Phone" }} /></Profiler>);
  await pass(0);
  expect(screen.getByTestId("device-standby-link")).toHaveAttribute("data-status", "live");
}

beforeEach(() => {
  hidden = false;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("the standby screen behind a hidden window", () => {
  it("asks its engine nothing for as long as it is hidden", async () => {
    await standby();
    show(false);
    await pass(0);
    const before = asked();
    await pass(MINUTE);
    expect(asked()).toEqual(before);
  });

  it("asks once when it shows again, and goes on as before: the handoff twice a second, the device set every 3 s", async () => {
    await standby();
    show(false);
    await pass(MINUTE);
    const before = asked();
    show(true);
    await pass(0);
    expect(asked()).toEqual({ handoff: before.handoff + 1, set: before.set + 1 });
    await pass(MINUTE);
    expect(asked()).toEqual({ handoff: before.handoff + 1 + 120, set: before.set + 1 + 20 });
  });

  it("shows what changed meanwhile as soon as it is back in front", async () => {
    let offer: HandoffView | null = null;
    let status: "live" | "connecting" = "live";
    await standby(() => offer, () => set(status));
    show(false);
    offer = { role: "taker", device: "Phone", key: PHONE, step: "copying", bytes: 10, total: 100 };
    status = "connecting";
    await pass(MINUTE);
    expect(screen.getByTestId("device-standby-link")).toHaveAttribute("data-status", "live");
    show(true);
    await pass(0);
    expect(screen.getByTestId("device-standby-link")).toHaveAttribute("data-status", "connecting");
    expect(screen.getByTestId("handoff-standby")).toHaveTextContent("Phone");
  });
});

describe("the standby screen in front, with nothing new", () => {
  it("draws nothing again for answers that say the same", async () => {
    await standby();
    await pass(MINUTE);
    const before = draws;
    // Second by second: each answer that came is its own chance to draw.
    for (let second = 0; second < 60; second += 1) await pass(1000);
    expect(asked().set).toBeGreaterThanOrEqual(40);
    expect(draws).toBe(before);
  });

  it("shows a handoff's progress within half a second", async () => {
    let view: HandoffView | null = null;
    await standby(() => view);
    await pass(MINUTE);
    view = { role: "taker", device: "Phone", key: PHONE, step: "copying", bytes: 10, total: 100 };
    await pass(500);
    expect(screen.getByTestId("handoff-standby")).toHaveTextContent("Phone");
    const before = draws;
    view = { ...view, bytes: 60 };
    await pass(500);
    expect(draws).toBeGreaterThan(before);
  });
});
