import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { mint } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.cashu.receive-lightning
describe("Receive's Create invoice waits for an amount above zero", () => {
  /**
   * An amount of 0 (or 00) is no amount: Create invoice stays off, as it is for an empty field and as the Fedimint card's
   * does. It was on, and a press asked the mint for nothing and came back "Enter an amount in sats", sats on a test card.
   */
  it("0 and 00 leave it off, 21 turns it on", async () => {
    let calls = 0;
    const state = networkState(walletView({ mode: "testnet", mints: [mint(TEST_MINTS[0], 5_000)], balance: 5_000 }) as WalletState, "testnet");
    const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), { receiveLightning: async () => { calls++; throw new Error("not asked here"); } });
    const { user } = renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    const field = screen.getByTestId("wallet-receive-amount");
    const create = screen.getByTestId("wallet-create-invoice");
    for (const zero of ["0", "00"]) {
      await user.clear(field);
      await user.type(field, zero);
      expect(create, zero).toBeDisabled();
      await user.type(field, "{Enter}");
    }
    expect(calls).toBe(0);
    expect(screen.queryByTestId("wallet-error")).toBeNull();
    await user.clear(field);
    await user.type(field, "21");
    expect(create).toBeEnabled();
  });
});
