import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import type { WalletInstanceView } from "@ghostly/browser/shared/types";
import { DevicesSection } from "../../components/devices/DevicesSection";
import { DeviceStandby } from "../../components/DeviceStandby";
import { walletsAtHomeHere } from "../../lib/profileData";
import { renderApp } from "../render";
// covers: devices.remove

/*
 * Wallets that stay home (WISP 06 § Wallets that stay home) keep their own database only on their home device. Remove
 * <device> clears their home, so they open on this device from their record instead; Remove this profile here, on the
 * home device, deletes that database. Both say so before the button, with each kind's loss from the WISP's table.
 */

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

vi.mock("../../lib/profileData", async (original) => ({ ...(await original<typeof import("../../lib/profileData")>()), removeProfileHere: vi.fn(), walletsAtHomeHere: vi.fn(async () => []) }));

const DESKTOP = "D".repeat(43), PHONE = "P".repeat(43), TABLET = "T".repeat(43);
const activeSet = (): DeviceSetView => ({
  state: "active",
  devices: [
    { key: DESKTOP, name: "Desktop", slot: 0, self: true, active: true },
    { key: PHONE, name: "Phone", slot: 1, self: false, active: false, status: "connecting" },
    { key: TABLET, name: "Tablet", slot: 2, self: false, active: false, status: "live" },
  ],
});
const wallet = (type: WalletInstanceView["type"], network: WalletInstanceView["network"], home?: WalletInstanceView["home"]): WalletInstanceView =>
  ({ id: `${type}:${network}`, type, network, config: {}, ...(home ? { home } : {}) });

/** Opens Remove on the device row `index` (0: Phone, 1: Tablet) and returns the dialog. */
async function openRemove(user: ReturnType<typeof renderApp>["user"], index: number) {
  await user.click((await screen.findAllByTestId("device-menu"))[index]);
  await user.click(screen.getByTestId("device-remove-open"));
  return screen.getByTestId("device-remove");
}

describe("Remove <device>, with wallets at home on it", () => {
  it("names each wallet at home there and its loss before Remove; a wallet at home on another device is not named", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => activeSet());
    engine.update({ wallet: { wallets: [
      wallet("cashu", "mainnet"),
      wallet("bark", "mainnet", { device: "Tablet", key: TABLET }),
      wallet("fedimint", "testnet", { device: "Tablet", key: TABLET }),
      wallet("usdt", "mainnet", { device: "Tablet", key: TABLET }),
      wallet("arkade", "testnet", { device: "Tablet", key: TABLET }),
      wallet("spark", "mainnet", { device: "Phone", key: PHONE }),
    ] } });
    const dialog = await openRemove(user, 1);
    expect(dialog).toHaveTextContent("It can no longer take this profile.");
    const homes = within(dialog).getByTestId("device-remove-homes");
    const lines = within(homes).getAllByTestId("device-remove-homes-wallet");
    expect(lines.map((line) => line.dataset.type)).toEqual(["bark", "fedimint", "usdt", "arkade"]);
    expect(lines[0]).toHaveTextContent("Mainnet Bark lives on Tablet. After removal it opens here instead.");
    expect(lines[0]).toHaveTextContent("An exit or a send still open there can't be finished here.");
    expect(lines[1]).toHaveTextContent("Testnet Fedimint lives on Tablet.");
    expect(lines[1]).toHaveTextContent("Here it is recovered from its federation; that recovery is still untested.");
    expect(lines[2]).toHaveTextContent("Sending stays off here until you confirm its last transaction on chain.");
    // Ark's row names no loss: the line alone.
    expect(lines[3]).toHaveTextContent("Testnet Ark lives on Tablet.");
    expect(within(lines[3]).queryByTestId("device-remove-homes-loss")).toBeNull();
    expect(dialog).not.toHaveTextContent("Spark");
    // Before the buttons: said before Remove is pressed.
    expect(homes.compareDocumentPosition(within(dialog).getByTestId("device-remove-go")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("matches the wallet's home by the device's key, not its name", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => activeSet());
    // A wallet at home on another device also called Tablet.
    engine.update({ wallet: { wallets: [wallet("bark", "mainnet", { device: "Tablet", key: "O".repeat(43) })] } });
    const dialog = await openRemove(user, 1);
    expect(within(dialog).queryByTestId("device-remove-homes")).toBeNull();
  });

  it("with no wallet at home there, says what it said before and nothing more", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => activeSet());
    engine.update({ wallet: { wallets: [wallet("cashu", "mainnet"), wallet("bark", "mainnet", { device: "Tablet", key: TABLET })] } });
    const dialog = await openRemove(user, 0);
    expect(dialog).toHaveTextContent("Remove Phone?");
    expect(within(dialog).queryByTestId("device-remove-homes")).toBeNull();
    expect(dialog).not.toHaveTextContent("lives on");
    await user.click(within(dialog).getByTestId("device-remove-go"));
    await waitFor(() => expect(engine.callsTo("deviceRemove")).toEqual([{ key: PHONE }]));
  });
});

describe("Remove this profile here, on the home device of a wallet", () => {
  it("names each wallet at home here, says its data is on no other device, and its loss", async () => {
    vi.mocked(walletsAtHomeHere).mockResolvedValue([{ type: "bark", network: "mainnet" }, { type: "usdt", network: "testnet" }, { type: "lightning", network: "mainnet", name: "My LND" }]);
    const { user } = renderApp(<DeviceStandby gate={{ state: "removed", activeDevice: "Desktop" }} />);
    await user.click(screen.getByTestId("device-standby-remove-here"));
    const dialog = screen.getByTestId("device-remove-here");
    const lines = await within(dialog).findAllByTestId("device-remove-here-homes-wallet");
    expect(walletsAtHomeHere).toHaveBeenCalledWith("");
    expect(lines.map((line) => line.dataset.type)).toEqual(["bark", "usdt", "lightning"]);
    expect(lines[0]).toHaveTextContent("Mainnet Bark lives on this device. What it keeps here is not on your other devices.");
    expect(lines[0]).toHaveTextContent("An exit or a send still open here can't be finished without it.");
    expect(lines[1]).toHaveTextContent("Your other devices can't send from it until you confirm its last transaction on chain.");
    expect(lines[2]).toHaveTextContent("My LND lives on this device.");
    expect(within(lines[2]).queryByTestId("device-remove-here-homes-loss")).toBeNull();
    // Said before the name is typed and Remove pressed.
    expect(within(dialog).getByTestId("device-remove-here-homes").compareDocumentPosition(within(dialog).getByTestId("device-remove-here-go")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("with no wallet at home here, says what it said before", async () => {
    vi.mocked(walletsAtHomeHere).mockResolvedValue([]);
    const { user } = renderApp(<DeviceStandby gate={{ state: "removed", activeDevice: "Desktop" }} />);
    await user.click(screen.getByTestId("device-standby-remove-here"));
    const dialog = screen.getByTestId("device-remove-here");
    await waitFor(() => expect(walletsAtHomeHere).toHaveBeenCalled());
    expect(dialog).toHaveTextContent("Your other devices keep the profile.");
    expect(within(dialog).queryByTestId("device-remove-here-homes")).toBeNull();
  });
});
