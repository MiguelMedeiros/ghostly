import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import type { HandoffView } from "@ghostly/browser/devices/handoff";
import { DeviceStandby } from "../../components/DeviceStandby";
import { DevicesSection } from "../../components/devices/DevicesSection";
import { LimitedBanner, resetLimitedStart } from "../../components/devices/LimitedStart";
import { activeProfileId, listProfiles } from "../../lib/profiles";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: devices.screens, devices.standby-screen, devices.handoff, devices.remove

/*
 * The buttons of the device screens that ask the engine for one thing and show nothing of their own: when the engine
 * refuses, the reason is said under them, as the dialogs beside them do.
 */

const DESKTOP = "D".repeat(43), PHONE = "P".repeat(43);
const set = (patch: Partial<DeviceSetView> = {}): DeviceSetView => ({
  state: "active",
  devices: [
    { key: DESKTOP, name: "MacBook", slot: 0, self: true, active: true },
    { key: PHONE, name: "iPhone", slot: 1, self: false, active: false, status: "live" },
  ],
  ...patch,
});
const standby = () => set({ state: "standby", devices: set().devices.map((device) => ({ ...device, self: device.key === PHONE, active: device.key === DESKTOP })) });
const offer: HandoffView = { role: "taker", device: "MacBook", key: DESKTOP, step: "offer", bytes: 0, total: 0, offer: 480 * 1024 ** 2 };

describe("the offer of a move, on a standby", () => {
  beforeEach(() => {
    fakeEngine.on("deviceSet", standby);
    fakeEngine.on("deviceHandoffView", () => offer);
    fakeEngine.on("deviceTakeoverInfo", () => ({ offered: false }));
  });

  it("Use here on an offer that is gone says so under the buttons, which come back", async () => {
    fakeEngine.on("deviceHandoffAccept", () => { throw new Error("handoff-refused: There is no offer to accept."); });
    const { user } = renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "MacBook" }} />);
    await user.click(await screen.findByTestId("handoff-accept"));
    expect(await screen.findByTestId("handoff-offer-error")).toHaveTextContent("That offer endedAsk again from MacBook.");
    expect(screen.getByTestId("handoff-offer-error")).toHaveAttribute("role", "alert");
    await waitFor(() => expect(screen.getByTestId("handoff-accept")).toBeEnabled());
  });

  it("Use here with no room for the copy says the storage's own words", async () => {
    fakeEngine.on("deviceHandoffAccept", () => { throw new Error("handoff-room: Not enough space for the copy."); });
    const { user } = renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "MacBook" }} />);
    await user.click(await screen.findByTestId("handoff-accept"));
    expect(await screen.findByTestId("handoff-offer-error")).toHaveTextContent("Not enough space on this device.");
  });

  it("Not now that fails says what went wrong, and the next press clears it", async () => {
    let fail = true;
    fakeEngine.on("deviceHandoffCancel", () => { if (fail) throw new Error("The device record could not be written"); });
    const { user } = renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "MacBook" }} />);
    await user.click(await screen.findByTestId("handoff-decline"));
    expect(await screen.findByTestId("handoff-offer-error")).toHaveTextContent("The device record could not be written");
    fail = false;
    await user.click(screen.getByTestId("handoff-decline"));
    await waitFor(() => expect(screen.queryByTestId("handoff-offer-error")).toBeNull());
  });
});

describe("the new device list, on a standby", () => {
  it("OK and This is wrong say when the answer could not be kept", async () => {
    fakeEngine.on("deviceSet", standby);
    fakeEngine.on("deviceHandoffView", () => null);
    fakeEngine.on("deviceTakeoverInfo", () => ({ offered: false }));
    fakeEngine.on("deviceSetNoticeSeen", () => { throw new Error("The device record could not be written"); });
    const { user, engine } = renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "MacBook", notice: ["MacBook", "iPhone"] }} />);
    await user.click(await screen.findByTestId("device-set-notice-ok"));
    expect(await screen.findByTestId("device-set-notice-error")).toHaveTextContent("The device record could not be written");
    await waitFor(() => expect(screen.getByTestId("device-set-notice-wrong")).toBeEnabled());
    await user.click(screen.getByTestId("device-set-notice-wrong"));
    await waitFor(() => expect(engine.callsTo("deviceSetNoticeSeen")).toEqual([{ wrong: false }, { wrong: true }]));
    expect(await screen.findByTestId("device-set-notice-error")).toHaveTextContent("The device record could not be written");
  });
});

describe("a restored copy from before a device was removed", () => {
  beforeEach(() => resetLimitedStart());

  it("Start as its own profile says when the engine refuses", async () => {
    fakeEngine.on("deviceRestoreStartOwn", () => { throw new Error("This copy is not waiting for that choice"); });
    const { user, engine } = renderApp(<LimitedBanner />);
    act(() => fakeEngine.setState({ limited: true, restoreCheck: "removed" }));
    const name = listProfiles().find((profile) => profile.id === activeProfileId())!.name;
    await user.type(await screen.findByTestId("restore-limited-name"), name);
    await user.click(screen.getByTestId("restore-limited-own"));
    await waitFor(() => expect(engine.callsTo("deviceRestoreStartOwn")).toHaveLength(1));
    expect(await screen.findByTestId("restore-limited-error")).toHaveTextContent("This copy is not waiting for that choice");
    await waitFor(() => expect(screen.getByTestId("restore-limited-own")).toBeEnabled());
  });
});

describe("Profile, Devices on the active device", () => {
  it("Not now on the new device secret offer says when it could not be put away", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => set({ secretOffer: { device: "iPhone" } }));
    engine.on("deviceSecretOfferDismiss", () => { throw new Error("The device record could not be written"); });
    await user.click(await screen.findByTestId("device-secret-offer-dismiss"));
    expect(await screen.findByTestId("device-secret-offer-error")).toHaveTextContent("The device record could not be written");
  });

  it("Let <device> try again says when the engine refuses", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => set());
    engine.on("deviceHandoffView", () => ({ role: "giver", device: "iPhone", key: PHONE, step: "failed", bytes: 0, total: 0, failure: "password" }) satisfies HandoffView);
    engine.on("deviceHandoffAllow", () => { throw new Error("That device is not one of this profile's"); });
    await user.click(await screen.findByTestId("handoff-allow", {}, { timeout: 3_000 }));
    await waitFor(() => expect(engine.callsTo("deviceHandoffAllow")).toEqual([{ key: PHONE }]));
    expect(await screen.findByTestId("handoff-allow-error")).toHaveTextContent("That device is not one of this profile's");
  });
});
