import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeInvoice } from "@ghostly/browser/engine/paymentAdapters/providers/testing";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { LightningAddressPay } from "../../components/wallet/LightningAddressPay";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type LightningAddressInfo, type WalletState } from "../../lib/platform";
import { fakeEngine, walletView } from "../fakeEngine";
import { mint, TEST_MINT } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.cashu.pay-invoice, wallet.lightning.address, app.i18n

/**
 * A memo is text someone else wrote, in any script: in the wallet too it is laid out in its own direction, as the
 * chat's invoice card does (InvoiceBubble). Bare in an Arabic line, "1 cup coffee" read "1 · cup coffee": its "1" went
 * before the separator.
 */
const MEMO = "1 cup coffee";

describe("in Arabic, someone else's memo in the wallet keeps its own direction", () => {
  it("a pasted invoice's description in Send", async () => {
    const state = networkState(walletView({ mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }) as WalletState, "testnet");
    const { user } = renderApp(<CashuWallet wallet={servicesPlatform!.wallet} state={state} rail="cashu" onOpenCashu={() => {}} />, { language: "ar" });
    await user.click(screen.getByTestId("wallet-send"));
    await user.click(screen.getByTestId("wallet-pay-input"));
    await user.paste(fakeInvoice(1_000, new Uint8Array(32).fill(7), MEMO));
    const memo = await screen.findByText(MEMO);
    expect(memo.tagName).toBe("BDI");
    expect(screen.getByTestId("wallet-pay-preview")).toContainElement(memo);
  });

  it("a Lightning address's description, before and after the invoice", async () => {
    const info = { id: "addr-1", kind: "address", text: "alice@example.com", domain: "example.com", callbackDomain: "example.com", minSat: 1, maxSat: 100_000, description: MEMO, commentAllowed: 0 } as LightningAddressInfo;
    fakeEngine.setState({ wallet: walletView({ mints: [mint(TEST_MINT, 5_000)] }) });
    const { user, engine } = renderApp(<LightningAddressPay wallet={servicesPlatform!.wallet.forNetwork("testnet")} text="alice@example.com" />, { language: "ar" });
    engine.on("lnurlResolve", () => info).on("lnurlInvoice", () => ({ invoice: "lnbc-invoice", note: "Paid alice@example.com" }))
      .on("walletQuoteInvoice", () => ({ quote: "melt-1", amount: 2_100, feeReserve: 3, mint: TEST_MINT, expiry: Date.now() / 1000 + 600 }));
    await user.click(screen.getByTestId("lnurl-lookup"));
    expect((await screen.findByText(MEMO)).tagName).toBe("BDI");
    await user.type(screen.getByTestId("lnurl-amount"), "2100");
    await user.click(screen.getByTestId("lnurl-invoice"));
    await screen.findByTestId("lnurl-review");
    expect(screen.getByText(MEMO)).toHaveAttribute("dir", "auto");
  });
});
