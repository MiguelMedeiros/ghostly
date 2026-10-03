import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WalletAway } from "../../components/wallet/WalletAway";
import type { WalletPlatform } from "../../lib/platform";
import { renderApp } from "../render";

// covers: devices.handoff.wallets

/*
 * A wallet at home on another device (WISP 06 § Wallets that stay home), in place of its panel: where it can be used,
 * when Ark and Bark coins expire there, and the recovery phrase and backup file, read here without opening the wallet:
 * if that device is lost, the funds are reachable from them.
 */

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function platform(): WalletPlatform & { arkBackup: ReturnType<typeof vi.fn>; arkExportBackup: ReturnType<typeof vi.fn> } {
  return { arkBackup: vi.fn(async () => ({ mnemonic: PHRASE })), arkExportBackup: vi.fn(async () => "{}") } as never;
}

describe("the away panel", () => {
  it("an Ark wallet: where it is, when its coins expire there, and its recovery phrase shown on Show, the wallet never opened", async () => {
    const wallet = platform();
    const { user } = renderApp(<WalletAway wallet={{ type: "arkade", name: "Ark", home: { device: "MacBook", expiresAt: Date.UTC(2026, 9, 12) } }} platform={wallet} />);
    const panel = screen.getByTestId("wallet-away");
    expect(panel).toHaveTextContent("MacBook");
    expect(screen.getByTestId("wallet-away-expires")).toHaveTextContent("2026");
    expect(screen.getByTestId("wallet-away-backup")).toHaveTextContent("MacBook");
    // The phrase and the backup file rows, as every self-custodial wallet has them; no restore here.
    expect(screen.getByTestId("ark-recovery-show")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    await user.click(screen.getByTestId("ark-recovery-show"));
    expect(await screen.findByTestId("ark-recovery")).toHaveTextContent(PHRASE);
    expect(wallet.arkBackup).toHaveBeenCalledTimes(1);
  });

  it("a Lightning card, or no wallet calls to read with: no phrase and no backup rows", () => {
    renderApp(<WalletAway wallet={{ type: "lightning", name: "LND", home: { device: "MacBook" } }} platform={platform()} />);
    expect(screen.getByTestId("wallet-away")).toHaveTextContent("LND");
    expect(screen.queryByTestId("wallet-away-backup")).not.toBeInTheDocument();
    expect(screen.queryByTestId("wallet-away-expires")).not.toBeInTheDocument();
  });

  it("an unnamed home device is another device; without a platform there is nothing to read", () => {
    renderApp(<WalletAway wallet={{ type: "bark", name: "Bark", home: { device: "" } }} />);
    expect(screen.getByTestId("wallet-away")).toBeInTheDocument();
    expect(screen.queryByTestId("wallet-away-backup")).not.toBeInTheDocument();
  });
});
