import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { REGTEST_INVOICE, mint } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.cashu.receive, wallet.cashu.pay-invoice

/**
 * Receive's invoice and Send's quote take the place of the form that had the focus. The focus goes to their first line,
 * not to the page: the next Tab is the invoice's Copy or the quote's Pay, and a screen reader says what came.
 */
describe("the focus after a wallet step", () => {
  const TEST_MINT = TEST_MINTS[0];
  const state = networkState(walletView({ mints: [mint(TEST_MINT, 1_000)], balance: 1_000 }) as WalletState, "testnet");
  const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), {
    receiveLightning: async () => ({ invoice: REGTEST_INVOICE, expiresAt: null, paymentHash: "hash" }),
    quoteInvoice: async () => ({ quote: "quote-1", mint: TEST_MINT, amount: 5, feeReserve: 1 }),
  });

  for (const rail of ["cashu", "lightning"] as const) {
    it(`goes to the invoice once Receive made it (${rail} card)`, async () => {
      const { user } = renderApp(<CashuWallet wallet={wallet} state={state} rail={rail} onOpenCashu={() => {}} />);
      await user.click(screen.getByTestId("wallet-receive-amount"));
      await user.keyboard("21{Enter}");
      await waitFor(() => expect(screen.getByTestId("wallet-invoice")).toBeInTheDocument());
      expect(screen.getByText(/Invoice for/)).toHaveFocus();
      await user.tab();
      // Its text (where it scrolls) or its Copy button: inside the invoice either way.
      expect(screen.getByTestId("wallet-invoice-external")).toContainElement(document.activeElement as HTMLElement);
    });
  }

  it("goes to the quote once Send asked the mint, then on to Pay", async () => {
    const { user } = renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    await user.click(screen.getByRole("tab", { name: "Send" }));
    await user.click(screen.getByTestId("wallet-pay-input"));
    await user.paste(REGTEST_INVOICE);
    await user.tab();
    await user.keyboard("{Enter}");
    const pay = await screen.findByTestId("wallet-pay-confirm");
    expect(screen.getByText(/in fees/).closest("p")).toHaveFocus();
    await user.tab();
    expect(pay).toHaveFocus();
  });
});
