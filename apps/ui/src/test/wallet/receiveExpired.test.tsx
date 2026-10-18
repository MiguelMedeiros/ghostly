import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { REGTEST_INVOICE, mint } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.cashu.receive-lightning

/**
 * Receive's invoice goes once it has expired: nobody can pay it then, so it is not offered to be copied or scanned, and
 * the screen no longer says it waits for a payment. Until then it stays.
 */
describe("Receive's invoice past its expiry", () => {
  const MINT = TEST_MINTS[0];
  const state = networkState(walletView({ mints: [mint(MINT, 5_000)], balance: 5_000, history: [], mode: "testnet" }) as WalletState, "testnet");
  const walletExpiringIn = (ms: number | null): WalletPlatform => Object.assign(Object.create(servicesPlatform!.wallet), {
    receiveLightning: async () => ({ quote: "our-quote", invoice: REGTEST_INVOICE, expiresAt: ms === null ? null : Date.now() + ms, source: "cashu-mint" }),
  });

  async function showInvoice(wallet: WalletPlatform) {
    const view = renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    await view.user.click(screen.getByTestId("wallet-receive-amount"));
    await view.user.keyboard("1000{Enter}");
    await waitFor(() => expect(screen.getByTestId("wallet-invoice")).toBeInTheDocument());
    return view;
  }

  it("is replaced by a line saying it expired, with New amount", async () => {
    const view = await showInvoice(walletExpiringIn(300));
    // The keys were on the invoice's line (where Create invoice put them): they go on New amount, not to the page.
    expect(document.activeElement?.textContent).toMatch(/^Invoice for/);
    await waitFor(() => expect(screen.queryByTestId("wallet-invoice")).not.toBeInTheDocument(), { timeout: 2_000 });
    expect(screen.getByTestId("wallet-invoice-expired")).toHaveTextContent("This invoice expired: nobody can pay it now.");
    expect(screen.getByRole("alert")).toHaveTextContent("This invoice expired");
    expect(screen.queryByText(/Waiting for the payment/)).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New amount" }));
    await view.user.click(screen.getByRole("button", { name: "New amount" }));
    expect(screen.getByTestId("wallet-receive-amount")).toBeInTheDocument();
  });

  it("stays while it can still be paid", async () => {
    await showInvoice(walletExpiringIn(60 * 60_000));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByTestId("wallet-invoice")).toBeInTheDocument();
    expect(screen.queryByTestId("wallet-invoice-expired")).not.toBeInTheDocument();
  });

  it("stays when the mint gave no expiry", async () => {
    await showInvoice(walletExpiringIn(null));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByTestId("wallet-invoice")).toBeInTheDocument();
  });
});
