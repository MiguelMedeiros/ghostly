import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { REGTEST_INVOICE, mint } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.cashu.pay-invoice

/**
 * Send's result takes the review's place and its Done takes the keys: a screen reader hears "Done, button" and nothing
 * else unless the result is in a live region that was there, empty, before its text came.
 */
describe("Send's result is said to a screen reader", () => {
  const TEST_MINT = TEST_MINTS[0];
  const show = (paid: boolean, rail: "cashu" | "lightning") => {
    const base = networkState(walletView({ mode: "testnet", mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }) as WalletState, "testnet");
    // The Lightning card on a node rather than the mints: its own pending line.
    const state = rail === "lightning" ? { ...base, lightning: { mode: "testnet", providerId: "lnd", status: "ready", balance: 5_000, offered: [], recent: [] } } as unknown as WalletState : base;
    const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), {
      getState: () => state, quoteInvoice: async () => ({ quote: "q-1", mint: TEST_MINT, amount: 5, feeReserve: 1 }), payQuote: async () => paid,
    });
    return renderApp(<CashuWallet wallet={wallet} state={state} rail={rail} onOpenCashu={() => {}} />);
  };

  for (const [paid, rail, line] of [
    [true, "cashu", "Paid."],
    [false, "cashu", "The payment is still pending at the mint."],
    [false, "lightning", "The payment is still pending. It is being checked; nothing is paid again."],
  ] as const) {
    it(`${rail} card, ${paid ? "paid" : "pending"}: "${line}" comes into a status line that was already there`, async () => {
      const { user } = show(paid, rail);
      await user.click(screen.getByRole("tab", { name: "Send" }));
      await user.click(screen.getByTestId("wallet-pay-input"));
      await user.paste(REGTEST_INVOICE);
      await user.click(screen.getByRole("button", { name: /^Pay/ }));
      const pay = await screen.findByTestId("wallet-pay-confirm");
      const before = new Set(screen.queryAllByRole("status"));
      await user.click(pay);
      await waitFor(() => expect(screen.getByTestId("wallet-send-done")).toHaveFocus());
      const said = [...before].filter((el) => el.isConnected && el.textContent === line);
      expect(said).toHaveLength(1);
    });
  }
});
