import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LightningAddressPay } from "../../components/wallet/LightningAddressPay";
import { servicesPlatform, type LightningAddressInfo } from "../../lib/platform";
import { fakeEngine, walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { mint, TEST_MINT } from "../payments/fixtures";

// covers: payments.lnurl.card

/** A refusal belongs to the step that got it: going back a step leaves it behind, so it never reads as being about that one. */
describe("paying a Lightning address, going back a step", () => {
  const info = { id: "addr-1", kind: "address", text: "alice@example.com", domain: "example.com", callbackDomain: "example.com", minSat: 1, maxSat: 100_000, description: "Alice", commentAllowed: 0 } as LightningAddressInfo;
  const show = () => {
    fakeEngine.setState({ wallet: walletView({ mode: "testnet", mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }) });
    return renderApp(<LightningAddressPay wallet={servicesPlatform!.wallet.forNetwork("testnet")} text="alice@example.com" />);
  };

  it("Cancel after a refused payment: the amount step shows no refusal", async () => {
    const { user, engine } = show();
    engine.on("lnurlResolve", () => info).on("lnurlInvoice", () => ({ invoice: "lnbc-invoice", note: "Paid alice@example.com" }))
      .on("walletQuoteInvoice", () => ({ quote: "melt-1", mint: TEST_MINT, amount: 2_100, feeReserve: 3 }))
      .on("walletPayQuote", () => { throw new Error("Invoice already paid"); });
    await user.click(screen.getByTestId("lnurl-lookup"));
    await user.type(await screen.findByTestId("lnurl-amount"), "2100");
    await user.click(screen.getByTestId("lnurl-invoice"));
    await user.click(await screen.findByTestId("lnurl-pay"));
    expect(await screen.findByTestId("lnurl-error")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByTestId("lnurl-amount-form")).toBeInTheDocument();
    expect(screen.queryByTestId("lnurl-error")).toBeNull();
  });

  it("Back after a refused invoice: the look-up step shows no refusal", async () => {
    const { user, engine } = show();
    engine.on("lnurlResolve", () => info).on("lnurlInvoice", () => { throw new Error("example.com did not answer"); });
    await user.click(screen.getByTestId("lnurl-lookup"));
    await user.type(await screen.findByTestId("lnurl-amount"), "2100");
    await user.click(screen.getByTestId("lnurl-invoice"));
    expect(await screen.findByTestId("lnurl-error")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByTestId("lnurl-resolve")).toBeInTheDocument();
    expect(screen.queryByTestId("lnurl-error")).toBeNull();
  });
});
