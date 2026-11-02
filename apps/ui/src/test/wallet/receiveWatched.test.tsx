import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MINTS } from "@ghostly/browser/shared/mints";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { REGTEST_INVOICE, mint } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.cashu.receive-lightning

/**
 * agents#2447: the engine asks less and less about an open invoice nobody looks at. While Receive shows one, it says so
 * (`watchInvoice`) and again every minute, so a payment still shows within seconds; once the invoice is paid or left,
 * it stops saying it.
 */
describe("Receive's invoice on screen", () => {
  afterEach(() => { vi.useRealTimers(); });
  const MINT = DEFAULT_MINTS[0];
  type Tx = WalletState["history"][number];
  const at = (history: Tx[]) => networkState(walletView({ mints: [mint(MINT, 5_000)], balance: 5_000, history, mode: "mainnet" }) as WalletState, "mainnet");

  it("is watched while it shows, again every minute, and no more once it is paid", async () => {
    // Only the intervals are fake: the clicks and the waits run on real time.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const watchInvoice = vi.fn(async () => {});
    const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), {
      receiveLightning: async () => ({ quote: "our-quote", invoice: REGTEST_INVOICE, expiresAt: null, source: "cashu-mint" }),
      watchInvoice,
    });
    const card = (state: WalletState) => <CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />;
    const view = renderApp(card(at([])));
    await view.user.click(screen.getByTestId("wallet-receive-amount"));
    await view.user.keyboard("1000{Enter}");
    await waitFor(() => expect(screen.getByTestId("wallet-invoice")).toBeInTheDocument());
    await waitFor(() => expect(watchInvoice).toHaveBeenCalledWith(REGTEST_INVOICE));
    // A new state from the engine (a render) does not say it again.
    view.rerender(card(at([])));
    expect(watchInvoice).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(60_000);
    expect(watchInvoice).toHaveBeenCalledTimes(2);

    const paid: Tx = { id: "tx-paid", timestamp: Date.now() + 1, mint: MINT, kind: "lightning-in", amount: 1_000, fee: 0, quote: "our-quote" };
    view.rerender(card(at([paid])));
    await waitFor(() => expect(screen.getByTestId("wallet-paid")).toBeInTheDocument());
    vi.advanceTimersByTime(5 * 60_000);
    expect(watchInvoice).toHaveBeenCalledTimes(2);
  });
});
