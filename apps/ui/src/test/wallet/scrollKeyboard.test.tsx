import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { PayExternally } from "../../components/PayExternally";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { mint } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.history, payments.external

/**
 * A box that scrolls is reached with Tab, so its end can be read with the keys. Chromium takes Tab into a scrolling box
 * by itself; WebKit (Safari, the iPhone app, the Desktop app's WebView) only when the box is focusable.
 */
describe("scrolling wallet boxes take the keyboard", () => {
  const invoice = `lntbs12340n1p${"q".repeat(300)}`;

  it("an invoice's text, before its Copy button", async () => {
    const { user } = renderApp(<PayExternally uri={`lightning:${invoice}`} value={invoice} testId="wallet-invoice" />);
    await user.tab();
    expect(screen.getByTestId("wallet-invoice")).toHaveFocus();
    await user.tab();
    expect(screen.getByTestId("wallet-invoice-copy")).toHaveFocus();
  });

  it("a Cashu wallet's history", async () => {
    const TEST_MINT = TEST_MINTS[0];
    const history = Array.from({ length: 12 }, (_, i) => ({ id: `tx${i}`, kind: "lightning-in" as const, amount: 100 + i, fee: 0, timestamp: 1_791_000_000_000 + i, mint: TEST_MINT }));
    const state = networkState(walletView({ mints: [mint(TEST_MINT, 1_266)], balance: 1_266, history }) as WalletState, "testnet");
    const { user } = renderApp(<CashuWallet wallet={servicesPlatform!.wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    await user.click(screen.getByRole("tab", { name: "History" }));
    const list = screen.getByLabelText("History", { selector: "div" });
    expect(list).toHaveAttribute("tabindex", "0");
    expect(list.querySelectorAll("[data-testid=wallet-tx]")).toHaveLength(12);
  });
});
