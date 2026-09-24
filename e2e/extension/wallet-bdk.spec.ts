import { execFileSync } from "node:child_process";
import { BDK_REGTEST } from "../support/bdk-regtest/regtest.mjs";
import { expect, test } from "../support/extension";

/**
 * The BDK wallet in the extension, where the engine runs in an offscreen document: its WebAssembly loads
 * there, syncs from the local regtest Esplora, signs and broadcasts. GHOSTLY_BDK_REGTEST=1 only (see e2e/README.md).
 */
test("BDK on regtest in the extension: a wallet that receives and sends", { tag: ["@gated", "@feature:wallet.onchain.bdk.send", "@feature:extension.engine"] }, async ({ extensionPeer }) => {
  test.skip(process.env.GHOSTLY_BDK_REGTEST !== "1", "Requires e2e/infra (npm run e2e:infra:up) and GHOSTLY_BDK_REGTEST=1");
  test.setTimeout(5 * 60_000);
  const regtest = (...args: string[]) => execFileSync(process.execPath, ["e2e/support/bdk-regtest/regtest.mjs", ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  regtest("ready");
  const { page } = await extensionPeer("bdk-ext");
  await page.getByTestId("wallet-chip").click();
  await page.getByTestId("wallet-mode").getByRole("radio", { name: "Testnet" }).click();
  await page.getByTestId("wallet-card-bitcoin").click();
  const panel = page.getByTestId("bitcoin-wallet");
  await panel.getByTestId("onchain-source-select").selectOption("bdk");
  const form = panel.getByTestId("provider-form-bdk");
  await panel.getByTestId("bdk-written").check();
  await form.getByLabel("Network").selectOption("regtest");
  await form.getByLabel("Esplora server").fill(BDK_REGTEST.esplora);
  await form.getByTestId("provider-save").click();
  await expect(panel.getByTestId("onchain-source-status")).toContainText(/Connected · BDK BIP84/, { timeout: 60_000 });
  await panel.getByTestId("bitcoin-new-address").click();
  const address = (await panel.getByTestId("bitcoin-address").innerText()).trim();
  const funded = regtest("send", address, "50000");
  const balance = panel.getByTestId("bitcoin-balance");
  const sats = async () => { await panel.getByRole("button", { name: "Refresh now" }).click(); return Number((await balance.innerText()).trim().match(/^[\d,]*/)![0].replace(/,/g, "") || NaN); };
  await expect.poll(sats, { timeout: 60_000, intervals: [2_000] }).toBe(50_000);

  await page.getByTestId("wallet-send").click();
  await panel.getByLabel("Bitcoin recipient address").fill(regtest("address"));
  await panel.getByTestId("bitcoin-amount").fill("10000");
  await panel.getByRole("button", { name: "Review payment" }).click();
  const review = panel.getByTestId("payment-review");
  await review.getByRole("button", { name: "Approve payment" }).click();
  await expect(review.getByTestId("review-status")).toHaveText("submitted", { timeout: 60_000 });
  await review.getByText("Payment details").click();
  const sent = (await review.locator("dt:text-is('Transaction') + dd").innerText()).trim();
  await expect.poll(() => { regtest("mine", "1"); return review.getByTestId("review-status").innerText(); }, { timeout: 90_000, intervals: [5_000] }).toBe("settled");
  expect(JSON.parse(regtest("tx", sent)).confirmations).toBeGreaterThan(0);
  await expect.poll(sats, { timeout: 60_000 }).toBeLessThan(40_000);
  console.log("BDK extension evidence:", JSON.stringify({ funded, sent, balance: await sats() }));
});
