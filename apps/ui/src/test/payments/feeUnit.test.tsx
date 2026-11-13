import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WalletView } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../../components/MessageBubble";
import { satsIn } from "../../components/NetworkTag";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletState } from "../../lib/platform";
import { translateWith } from "../../locales/translate";
import { fakeEngine, linkView, walletView } from "../fakeEngine";
import { LANGUAGES, LOCALES } from "../i18n/locales";
import { renderApp } from "../render";
import { lightningSource, liveMainnetInvoice, mint, REAL_MINT, TEST_MINT } from "./fixtures";

// covers: payments.lightning.invoice-card, payments.mainnet-confirm, wallet.cashu.test-sats, wallet.lightning.card

/**
 * A pasted invoice's Pay ("Pay 2,000 + up to 5 fee"), its real-money step's fee and a history row's fee ("fee 2") said
 * no unit, while every amount beside them said sats or test sats. Now they say it, in its form for the count.
 */

describe("a Lightning invoice in a message", () => {
  const invoice = liveMainnetInvoice(2_100);
  const show = (wallet: Partial<WalletView>, feeReserve: number) => {
    fakeEngine.setState({ links: [linkView()], wallet });
    const view = renderApp(<MessageBubble message={{ id: "m1", text: invoice, sender: "peer", timestamp: Date.now(), status: "delivered" } as never} peerPubKey="peer" />);
    view.engine.on("walletQuoteInvoice", () => ({ quote: "melt-1", mint: REAL_MINT, amount: 2_100, feeReserve })).on("walletPayQuote", () => ({ paid: true }));
    return view;
  };

  it("with test sats, Pay says test sats", async () => {
    const { user } = show({ mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }, 5);
    const card = screen.getByTestId("invoice-bubble");
    await user.click(within(card).getByTestId("invoice-pay"));
    expect(await within(card).findByTestId("invoice-confirm")).toHaveTextContent(/^Pay 2,100 test sats \+ up to 5 fee$/);
  });

  it("with real money, Pay says sats and the real-money step says the fee's unit, singular for one", async () => {
    const { user } = show({ mints: [mint(REAL_MINT, 5_000)], balance: 5_000 }, 1);
    const card = screen.getByTestId("invoice-bubble");
    await user.click(within(card).getByTestId("invoice-pay"));
    const pay = await within(card).findByTestId("invoice-confirm");
    expect(pay).toHaveTextContent(/^Pay 2,100 sats \+ up to 1 fee$/);
    await user.click(pay);
    expect(screen.getByTestId("review-mainnet-confirm")).toHaveTextContent("This sends 2,100 sats (plus a fee of up to 1 sat) that cannot be taken back");
  });
});

describe("a wallet's history", () => {
  const wallet = servicesPlatform!.wallet;

  it("a Cashu row's fee says test sats, as the Fees paid line above it does", async () => {
    const state = networkState(walletView({ mints: [mint(TEST_MINT, 100)], balance: 100, feesPaid: 2, history: [
      { id: "out", timestamp: 1, mint: TEST_MINT, kind: "lightning-out", amount: 50, fee: 2 },
    ] }) as WalletState, "testnet");
    const { user } = renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    await user.click(screen.getByTestId("wallet-history"));
    expect(screen.getByTestId("wallet-fees-paid")).toHaveTextContent("Fees paid: 2 test sats");
    expect(screen.getByTestId("wallet-tx")).toHaveTextContent(/fee 2 test sats$/);
  });

  it("a Lightning card's Recent row says the fee's unit, singular for one", () => {
    const ln = lightningSource({ mode: "testnet", recent: [
      { direction: "out", providerId: "cln-1", mode: "testnet", paymentHash: "h2", invoice: "lntb2", amount: 70, expiresAt: 0, createdAt: 0, state: "paid", fee: 1 },
    ] } as never);
    const state = networkState(walletView({ mints: [mint(TEST_MINT, 0)], lightning: ln }) as WalletState, "testnet");
    renderApp(<CashuWallet wallet={wallet} state={state} rail="lightning" onOpenCashu={() => {}} />);
    expect(screen.getByTestId("lightning-op")).toHaveTextContent(/fee 1 test sat(?!s)/);
  });
});

describe("in every language", () => {
  it.each(LANGUAGES)("in %s, each fee string writes the unit", (language) => {
    const t = translateWith(LOCALES[language], language);
    const unit = satsIn(t, "testnet");
    expect(t("payments.invoice.payWithFee", { amount: "2", fee: "5", unit })).toContain(unit);
    expect(t("wallet.cashu.history.fee", { amount: "2", unit })).toContain(unit);
    const real = t("payments.invoice.confirmWhat", { amount: "5", fee: "5", unit: satsIn(t, "mainnet"), feeUnit: satsIn(t, "mainnet", 5) });
    expect(real.split(satsIn(t, "mainnet", 5)).length - 1).toBe(2);
  });
});
