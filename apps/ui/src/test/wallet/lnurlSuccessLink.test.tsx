import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LightningAddressPay } from "../../components/wallet/LightningAddressPay";
import { servicesPlatform, type LightningAddressInfo } from "../../lib/platform";
import { fakeEngine, walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { mint, TEST_MINT } from "../payments/fixtures";

// covers: payments.lnurl.card

/**
 * The link a service leaves after a payment (a LUD-09 `url` success action) reads as the address it opens, as a link
 * in a chat does: a user part does not read as the host, a look-alike host shows in punycode, and the service's own
 * words before it cannot turn it around.
 */
describe("the link a Lightning service leaves after a payment", () => {
  const info = { id: "addr-1", kind: "address", text: "alice@example.com", domain: "example.com", callbackDomain: "example.com", minSat: 1, maxSat: 100_000, description: "Alice", commentAllowed: 0 } as LightningAddressInfo;
  const paidWith = async (successAction: { tag: "url"; description?: string; url: string }) => {
    fakeEngine.setState({ wallet: walletView({ mode: "testnet", mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }) });
    const { user, engine } = renderApp(<LightningAddressPay wallet={servicesPlatform!.wallet.forNetwork("testnet")} text="alice@example.com" />);
    engine.on("lnurlResolve", () => info).on("lnurlInvoice", () => ({ invoice: "lnbc-invoice", note: "Paid alice@example.com", successAction }))
      .on("walletQuoteInvoice", () => ({ quote: "melt-1", mint: TEST_MINT, amount: 21, feeReserve: 1 }))
      .on("walletPayQuote", () => ({ paid: true }));
    await user.click(screen.getByTestId("lnurl-lookup"));
    await user.type(await screen.findByTestId("lnurl-amount"), "21");
    await user.click(screen.getByTestId("lnurl-invoice"));
    await user.click(await screen.findByTestId("lnurl-pay"));
    return screen.findByTestId("lnurl-done");
  };

  it("a user part is left out: the host it reads as is the one it opens", async () => {
    const done = await paidWith({ tag: "url", description: "Your receipt", url: "https://www.paypal.com@evil.example/receipt" });
    const link = done.querySelector("a")!;
    expect(new URL(link.getAttribute("href")!).host).toBe("evil.example");
    expect(link.textContent).toBe("https://evil.example/receipt");
    expect(done.textContent).not.toContain("paypal");
  });

  it("a look-alike host shows in punycode", async () => {
    const done = await paidWith({ tag: "url", description: "Your receipt", url: "https://рaypal.com/receipt" });
    expect(done.querySelector("a")!.textContent).toBe("https://xn--aypal-uye.com/receipt");
  });

  it("the service's words cannot turn the link around", async () => {
    const done = await paidWith({ tag: "url", description: "Receipt ‮", url: "https://evil.example/?x=moc.lapyap.www//:sptth" });
    const words = done.querySelector("bdi")!;
    expect(words.textContent).toBe("Receipt ‮");
    expect(words.contains(done.querySelector("a"))).toBe(false);
  });
});
