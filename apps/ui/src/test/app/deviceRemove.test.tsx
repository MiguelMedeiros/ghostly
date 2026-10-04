import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import type { WalletView } from "@ghostly/browser/shared/types";
import { DevicesSection } from "../../components/devices/DevicesSection";
import { LostChecklist } from "../../components/devices/RemoveDeviceDialog";
import { DeviceStandby } from "../../components/DeviceStandby";
import { listNames, lostWalletLines, reenrollHere } from "../../lib/devices";
import { renderApp } from "../render";
// covers: devices.remove, devices.remove.own-set

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

vi.mock("../../lib/devices", async (original) => ({ ...(await original<typeof import("../../lib/devices")>()), reenrollHere: vi.fn() }));

const DESKTOP = "D".repeat(43), PHONE = "P".repeat(43), TABLET = "T".repeat(43);
const activeSet = (patch: Partial<DeviceSetView> = {}): DeviceSetView => ({
  state: "active",
  devices: [
    { key: DESKTOP, name: "Desktop", slot: 0, self: true, active: true },
    { key: PHONE, name: "Phone", slot: 1, self: false, active: false, status: "connecting" },
    { key: TABLET, name: "Tablet", slot: 2, self: false, active: false, status: "live" },
  ],
  ...patch,
});

describe("Remove, on the active device", () => {
  it("asks first, says what it means, and removes the device by its key", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => activeSet());
    engine.on("deviceRemove", () => activeSet({ devices: activeSet().devices.slice(0, 2), waiting: [{ key: PHONE, name: "Phone" }] }));
    // Every other device has Remove in its menu, live or not.
    expect(await screen.findAllByTestId("device-menu")).toHaveLength(2);
    await user.click(screen.getAllByTestId("device-menu")[1]);
    await user.click(screen.getByTestId("device-remove-open"));
    const dialog = screen.getByTestId("device-remove");
    expect(dialog).toHaveTextContent("Remove Tablet?");
    expect(dialog).toHaveTextContent("It can no longer take this profile.");
    await user.click(screen.getByTestId("device-remove-go"));
    await waitFor(() => expect(engine.callsTo("deviceRemove")).toEqual([{ key: TABLET }]));
    const removed = await screen.findByTestId("device-removed");
    expect(removed).toHaveTextContent("Tablet");
    expect(removed).toHaveTextContent("Removed");
  });

  it("says why it could not, and changes nothing", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => activeSet());
    engine.on("deviceRemove", () => { throw new Error("remove-busy: The profile is moving. Try again after it."); });
    await user.click((await screen.findAllByTestId("device-menu"))[0]);
    await user.click(screen.getByTestId("device-remove-open"));
    await user.click(screen.getByTestId("device-remove-go"));
    expect(await screen.findByTestId("device-remove-error")).toHaveTextContent("Something else is changing your devices.");
  });

  it("Lost or stolen shows the checklist first, then removes the device", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => activeSet());
    engine.on("deviceRemove", () => activeSet());
    await user.click((await screen.findAllByTestId("device-menu"))[0]);
    await user.click(screen.getByTestId("device-remove-open"));
    await user.click(screen.getByTestId("device-remove-lost"));
    expect(screen.getByTestId("device-lost")).toHaveTextContent("Lost or stolen?");
    expect(screen.getByTestId("device-lost-chats")).toHaveTextContent("Pair each chat again");
    await user.click(screen.getByTestId("device-lost-remove"));
    await waitFor(() => expect(engine.callsTo("deviceRemove")).toEqual([{ key: PHONE }]));
  });

  it("shows who has not taken the new secret yet, and makes a new device secret on request", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => activeSet({ waiting: [{ key: PHONE, name: "Phone" }] }));
    engine.on("deviceNewSecret", () => activeSet());
    expect(await screen.findByTestId("device-waiting")).toHaveTextContent("Waiting for Phone to open Ghostly");
    await user.click(screen.getByTestId("device-secret-new"));
    await waitFor(() => expect(engine.callsTo("deviceNewSecret")).toHaveLength(1));
    expect(await screen.findByTestId("device-secret-done")).toHaveTextContent("New device secret made.");
  });

  it("after a takeover offers to remove the device that stopped, the checklist when it was lost, or not now", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => activeSet({ secretOffer: { device: "Phone", lost: true } }));
    engine.on("deviceSecretOfferDismiss", () => undefined);
    expect(await screen.findByTestId("device-secret-offer")).toHaveTextContent("You took over from Phone.");
    expect(screen.getByTestId("device-secret-offer-remove")).toHaveTextContent("Remove Phone");
    await user.click(screen.getByTestId("device-secret-offer-lost"));
    expect(screen.getByTestId("device-lost-remove")).toHaveTextContent("Remove Phone");
    await user.click(screen.getByTestId("device-lost-done"));
    await user.click(screen.getByTestId("device-secret-offer-dismiss"));
    await waitFor(() => expect(engine.callsTo("deviceSecretOfferDismiss")).toHaveLength(1));
  });

  it("on a standby offers no Remove and no new secret", async () => {
    const { engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => ({ ...activeSet(), state: "standby", devices: activeSet().devices.map((d) => ({ ...d, self: d.key === PHONE, active: d.key === DESKTOP })) }));
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(3));
    expect(screen.queryByTestId("device-remove-open")).toBeNull();
    expect(screen.queryByTestId("device-secret")).toBeNull();
  });
});

describe("the money checklist", () => {
  it("names each wallet the lost device could spend from, by kind", () => {
    const wallet = {
      wallets: [{ type: "cashu" }, { type: "arkade" }, { type: "usdt" }, { type: "lightning" }].map((w, i) => ({ id: String(i), network: "mainnet", config: {}, ...w })),
      networks: { mainnet: { lightnings: [
        { card: "cashu", name: "Cashu mints", providerId: "cashu-mint", isDefault: true },
        { card: "a", name: "My node", providerId: "lnd" },
        { card: "b", name: "Breez", providerId: "breez" },
        { card: "c", name: "Alby", providerId: "webln" },
      ] } },
    } as unknown as WalletView;
    expect(lostWalletLines(wallet)).toEqual({ cashu: true, phrase: ["Ark", "USDT", "Breez"], remote: ["My node"] });
    expect(lostWalletLines(undefined)).toEqual({ cashu: false, phrase: [], remote: [] });
  });

  it("starts with the storage keys only when storage is set up", async () => {
    const { engine } = renderApp(<LostChecklist onClose={() => {}} />);
    expect(screen.queryByTestId("device-lost-storage")).toBeNull();
    engine.update({ settings: { ...engine.state!.settings, holdStorage: { s3: { endpoint: "https://s3.test", region: "us-east-1", bucket: "b", accessKeyId: "k", secretAccessKey: "s" }, space: "x" } } as never });
    expect(await screen.findByTestId("device-lost-storage")).toHaveTextContent("Change your storage keys");
    expect(screen.getByTestId("device-lost-lines").firstElementChild).toBe(screen.getByTestId("device-lost-storage"));
    expect(screen.queryByTestId("device-lost-remove")).toBeNull();
  });
});

describe("the standby screen after a removal", () => {
  it("a device that took the new secret shows the list once; OK and This is wrong go to the engine", async () => {
    const { user, engine } = renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "Desktop", notice: ["Desktop", "Phone"] }} />);
    engine.on("deviceSetNoticeSeen", () => undefined);
    engine.on("deviceTakeoverInfo", () => ({ offered: false }));
    expect(screen.getByTestId("device-set-notice-title")).toHaveTextContent("Your devices are now: Desktop and Phone");
    expect(screen.getByTestId("device-set-notice")).toHaveTextContent("If this list looks wrong, do not use this device.");
    await user.click(screen.getByTestId("device-set-notice-ok"));
    await user.click(screen.getByTestId("device-set-notice-wrong"));
    await waitFor(() => expect(engine.callsTo("deviceSetNoticeSeen")).toEqual([{ wrong: false }, { wrong: true }]));
  });

  it("reads the turn again when the screen comes back to the front, at most every 30 seconds", async () => {
    const { engine } = renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "Desktop" }} />);
    engine.on("deviceTurnCheck", () => null);
    engine.on("deviceTakeoverInfo", () => ({ offered: false }));
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 5_000);
    window.dispatchEvent(new Event("focus"));
    expect(engine.callsTo("deviceTurnCheck")).toHaveLength(0);
    clock.mockReturnValue(now + 31_000);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(engine.callsTo("deviceTurnCheck")).toHaveLength(1));
    clock.mockRestore();
  });

  it("a moving device names the device that finishes it", () => {
    renderApp(<DeviceStandby gate={{ state: "moving", activeDevice: "Desktop" }} />);
    expect(screen.getByTestId("device-standby-title")).toHaveTextContent("Almost there");
    expect(screen.getByTestId("device-standby")).toHaveTextContent("Open Ghostly on Desktop to finish.");
    expect(screen.queryByTestId("device-standby-reenroll")).toBeNull();
  });

  it("a moving device whose remover is gone: My other device is lost or broken makes a set of its own, and says the others are added again", async () => {
    const { user, engine } = renderApp(<DeviceStandby gate={{ state: "moving", activeDevice: "Desktop" }} />);
    engine.on("deviceTakeoverInfo", () => ({ offered: true, ownSet: true, device: "Desktop", copy: "frozen", password: true }));
    engine.on("deviceTakeover", () => ({ kind: "removed" }));
    await user.click(await screen.findByTestId("takeover-open"));
    expect(screen.getByTestId("takeover-open")).toHaveTextContent("My other device is lost or broken");
    expect(screen.getByTestId("takeover-own-set")).toHaveTextContent("Add your other devices again afterwards.");
    // Its devices are not lost by this: the question is not asked.
    expect(screen.queryByTestId("takeover-lost")).toBeNull();
    await user.type(screen.getByTestId("takeover-password"), "a long lock password");
    await user.type(screen.getByTestId("takeover-name"), "Desktop");
    await user.click(screen.getByTestId("takeover-go"));
    await waitFor(() => expect(engine.callsTo("deviceTakeover")).toEqual([{ password: "a long lock password", name: "Desktop", lost: false }]));
    expect(await screen.findByTestId("takeover-error")).toHaveTextContent("Another of your devices started over first.");
  });

  it("one that can accept nothing, and one removed, are added again from a new profile here", async () => {
    const first = renderApp(<DeviceStandby gate={{ state: "moving", activeDevice: "Tablet", reenroll: true }} />);
    expect(screen.getByTestId("device-standby-title")).toHaveTextContent("Your devices changed while this one was off");
    await first.user.click(screen.getByTestId("device-standby-reenroll"));
    expect(reenrollHere).toHaveBeenCalledOnce();
    first.unmount();
    renderApp(<DeviceStandby gate={{ state: "removed", activeDevice: "Desktop" }} />);
    expect(screen.getByTestId("device-standby-title")).toHaveTextContent("This device was removed");
    expect(screen.getByTestId("device-standby")).toHaveTextContent("Add it again from Desktop.");
    expect(screen.getByTestId("device-standby-reenroll")).toHaveTextContent("Add this device to my profile");
  });
});

describe("the forced takeover asks Lost or stolen?", () => {
  it("and says so to the engine", async () => {
    const { user, engine } = renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "Phone" }} />);
    engine.on("deviceTakeoverInfo", () => ({ offered: true, device: "Phone", copy: "frozen", password: true }));
    engine.on("deviceTakeover", () => ({ kind: "gated" }));
    await user.click(await screen.findByTestId("takeover-open"));
    await user.type(screen.getByTestId("takeover-password"), "a long lock password");
    await user.type(screen.getByTestId("takeover-name"), "Phone");
    await user.click(screen.getByTestId("takeover-lost-yes"));
    await user.click(screen.getByTestId("takeover-go"));
    await waitFor(() => expect(engine.callsTo("deviceTakeover")).toEqual([{ password: "a long lock password", name: "Phone", lost: true }]));
  });
});

describe("a list of names", () => {
  it("reads in the person's language", () => {
    expect(listNames(["Desktop", "Phone", "Tablet"], "en")).toBe("Desktop, Phone, and Tablet");
    expect(listNames(["Desktop"], "en")).toBe("Desktop");
  });
});
