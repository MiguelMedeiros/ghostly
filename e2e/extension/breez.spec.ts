import { BREEZ_TESTNET, counterpart } from "../support/breez";
import { openWallet, useTestnet } from "../support/fixtures";
import { expect, test } from "../support/extension";

/**
 * The Breez source in the extension, where the engine (and so the SDK's WebAssembly) runs in the
 * offscreen document: a wallet made there, an invoice of it paid from outside, and one of the outside
 * wallet's paid back. Breez's hosted regtest; GHOSTLY_BREEZ_TESTNET=1, see e2e/README.md.
 */
test("Breez runs in the extension's offscreen document: in and out on regtest", { tag: ["@network", "@gated", "@feature:wallet.lightning.breez.connect", "@feature:wallet.lightning.breez.pay", "@feature:extension.engine"] }, async ({ extensionPeer }) => {
  test.skip(!BREEZ_TESTNET, "GHOSTLY_BREEZ_TESTNET=1 runs it (Breez's hosted regtest, see e2e/README.md)");
  test.setTimeout(6 * 60_000);
  const other = await counterpart();
  try {
    const alice = await extensionPeer("breez-extension");
    const page = alice.page, source = page.getByTestId("lightning-source");
    await useTestnet(alice);
    await openWallet(alice, "lightning");
    await source.getByTestId("lightning-source-select").selectOption("breez");
    await source.getByTestId("breez-phrase-written").check();
    await source.getByTestId("provider-save").click();
    await expect(source.getByTestId("lightning-source-status")).toHaveText("Connected · regtest", { timeout: 90_000 });

    await page.getByTestId("wallet-receive").click();
    await page.getByTestId("wallet-receive-amount").fill("300");
    await page.getByTestId("wallet-create-invoice").click();
    const invoice = (await page.getByTestId("wallet-invoice").innerText()).trim();
    expect(invoice).toMatch(/^lnbcrt3u1/);
    await other.pay(invoice);
    await expect(page.getByTestId("wallet-paid")).toContainText("300 test sats received", { timeout: 90_000 });

    const before = await other.balance();
    await page.getByTestId("wallet-send").click();
    await page.getByTestId("wallet-pay-input").fill(await other.invoice(100));
    await page.getByRole("button", { name: "Pay 100 sats" }).click();
    await page.getByRole("button", { name: "Pay", exact: true }).click();
    await expect(page.getByTestId("wallet-notice")).toHaveText("Paid.", { timeout: 90_000 });
    await expect.poll(() => other.balance(), { timeout: 60_000 }).toBe(before + 100);
    await expect(page.getByTestId("wallet-balance")).toHaveText(/^(19\d|200)\s*test sats/, { timeout: 60_000 });
  } finally {
    await other.close();
  }
});
