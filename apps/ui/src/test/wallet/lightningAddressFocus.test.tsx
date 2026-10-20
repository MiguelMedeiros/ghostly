import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LightningAddressPay } from "../../components/wallet/LightningAddressPay";
import { servicesPlatform, type LightningAddressInfo } from "../../lib/platform";
import { fakeEngine, walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { mint, TEST_MINT } from "../payments/fixtures";

// covers: payments.lnurl.card

/**
 * Paying a Lightning address from the keyboard: the button pressed keeps the focus while it works (busy, not disabled:
 * a disabled one drops it to the page in Chromium) and after a refusal, and each step that comes takes it.
 */
describe("paying a Lightning address keeps the keyboard's place", () => {
  const info = { id: "addr-1", kind: "address", text: "alice@example.com", domain: "example.com", callbackDomain: "example.com", minSat: 1, maxSat: 100_000, description: "Alice", commentAllowed: 0 } as LightningAddressInfo;
  const later = <T,>() => { let answer!: (value: T) => void; const promise = new Promise<T>((resolve) => { answer = resolve; }); return { promise, answer }; };
  const show = () => {
    fakeEngine.setState({ wallet: walletView({ mode: "testnet", mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }) });
    return renderApp(<LightningAddressPay wallet={servicesPlatform!.wallet.forNetwork("testnet")} text="alice@example.com" />);
  };
  const busy = (button: HTMLElement) => {
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toBeEnabled();
    expect(button).toHaveFocus();
  };

  it("Look up, Get invoice and Pay: busy where they were pressed, then the next step's line", async () => {
    const { user, engine } = show();
    const resolve = later<LightningAddressInfo>(), invoice = later<{ invoice: string; note: string }>(), paid = later<{ paid: boolean }>();
    engine.on("lnurlResolve", () => resolve.promise).on("lnurlInvoice", () => invoice.promise)
      .on("walletQuoteInvoice", () => ({ quote: "melt-1", mint: TEST_MINT, amount: 2_100, feeReserve: 3 })).on("walletPayQuote", () => paid.promise);

    const lookUp = screen.getByTestId("lnurl-lookup");
    lookUp.focus();
    await user.keyboard("{Enter}");
    busy(lookUp);
    await user.keyboard("{Enter}");
    resolve.answer(info);
    await waitFor(() => expect(screen.getByTestId("lnurl-amount")).toHaveFocus());

    await user.keyboard("2100");
    const getInvoice = screen.getByTestId("lnurl-invoice");
    getInvoice.focus();
    await user.keyboard("{Enter}");
    busy(getInvoice);
    invoice.answer({ invoice: "lnbc-invoice", note: "Paid alice@example.com" });
    const pay = await screen.findByTestId("lnurl-pay");
    expect(document.activeElement).toHaveTextContent(/^Pay 2,100 test sats to alice@example\.com/);

    pay.focus();
    await user.keyboard("{Enter}");
    busy(pay);
    await user.keyboard("{Enter}");
    paid.answer({ paid: true });
    await waitFor(() => expect(screen.getByTestId("lnurl-paid")).toHaveFocus());
    expect(engine.callsTo("lnurlResolve")).toHaveLength(1);
    expect(engine.callsTo("walletPayQuote")).toHaveLength(1);
  });

  it("a refused look-up leaves the focus on Look up, by its error", async () => {
    const { user, engine } = show();
    engine.on("lnurlResolve", () => { throw new Error("example.com did not answer"); });
    const lookUp = screen.getByTestId("lnurl-lookup");
    lookUp.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByTestId("lnurl-error")).toBeInTheDocument();
    expect(lookUp).toHaveFocus();
    expect(lookUp).not.toHaveAttribute("aria-busy");
  });
});
