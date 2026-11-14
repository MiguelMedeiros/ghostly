import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import type { HandoffView } from "@ghostly/browser/devices/handoff";
import { DeviceStandby } from "../../components/DeviceStandby";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: devices.standby-screen, devices.handoff

/*
 * The offer of a move on a standby, answered with the keyboard: its buttons go with it, and the keyboard focus goes to
 * what took their place (the move's Cancel, else its words, else Use here), not to the page.
 */

const DESKTOP = "D".repeat(43), PHONE = "P".repeat(43);
const standby = (): DeviceSetView => ({
  state: "standby",
  devices: [
    { key: DESKTOP, name: "MacBook", slot: 0, self: false, active: true, status: "live" },
    { key: PHONE, name: "iPhone", slot: 1, self: true, active: false },
  ],
});
const offer: HandoffView = { role: "taker", device: "MacBook", key: DESKTOP, step: "offer", bytes: 0, total: 0, offer: 1024 };

describe("the offer of a move, answered with the keyboard", () => {
  let view: HandoffView | null;
  beforeEach(() => {
    view = offer;
    fakeEngine.on("deviceSet", standby);
    fakeEngine.on("deviceHandoffView", () => view);
    fakeEngine.on("deviceTakeoverInfo", () => ({ offered: false }));
  });

  const press = async (testId: string, next: HandoffView | null, method: "deviceHandoffAccept" | "deviceHandoffCancel") => {
    fakeEngine.on(method, () => { view = next; });
    const { user } = renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "MacBook" }} />);
    (await screen.findByTestId(testId)).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("handoff-offer")).toBeNull(), { timeout: 2_000 });
  };

  it("Use here: the focus goes to the move's Cancel", async () => {
    await press("handoff-accept", { ...offer, step: "connecting", offer: undefined }, "deviceHandoffAccept");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("handoff-cancel")));
  });

  it("Not now: the focus goes to the words of the move it stopped", async () => {
    await press("handoff-decline", { ...offer, step: "failed", failure: "cancelled", offer: undefined }, "deviceHandoffCancel");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("handoff-progress")));
  });

  it("an offer the other device took back: the focus goes to Use here", async () => {
    renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "MacBook" }} />);
    (await screen.findByTestId("handoff-accept")).focus();
    view = null;
    await waitFor(() => expect(screen.queryByTestId("handoff-offer")).toBeNull(), { timeout: 2_000 });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("handoff-use-here")));
  });
});
