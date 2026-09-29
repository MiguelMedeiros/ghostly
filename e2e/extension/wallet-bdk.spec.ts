import { execFileSync } from "node:child_process";
import { BDK_REGTEST } from "../support/bdk-regtest/regtest.mjs";
import { createWallet, openWallet } from "../support/fixtures";
import { expect, test } from "../support/extension";
import { choose } from "../support/select";

/**
 * The BDK wallet in the extension, where the engine runs in an offscreen document: its WebAssembly loads
 * there, syncs from the local regtest Esplora, signs and broadcasts. GHOSTLY_BDK_REGTEST=1 only (see e2e/README.md).
 */
test("BDK on regtest in the extension: a wallet that receives and sends", { tag: ["@gated", "@feature:wallet.onchain.bdk.send", "@feature:extension.engine"] }, async ({ extensionPeer }) => {
  test.skip(process.env.GHOSTLY_BDK_REGTEST !== "1", "Requires e2e/infra (npm run e2e:infra:up) and GHOSTLY_BDK_REGTEST=1");
  test.setTimeout(5 * 60_000);
  const regtest = (...args: string[]) => execFileSync(process.execPath, ["e2e/support/bdk-regtest/regtest.mjs", ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  regtest("ready");
  const alice = await extensionPeer("bdk-ext");
  const { page } = alice;
  // A Testnet Bitcoin wallet, made with New: BDK is the one on-chain source a browser runs.
  await createWallet(alice, "bitcoin", "testnet", { timeout: 60_000, fill: async (area) => {
    await area.getByTestId("bdk-written").check();
    await choose(area.getByTestId("provider-form-bdk").getByLabel("Network"), "regtest");
    await area.getByLabel("Esplora server").fill(BDK_REGTEST.esplora);
    await area.getByTestId("provider-save").click();
  } });
  await openWallet(alice, "bitcoin-testnet");
  const panel = page.getByTestId("bitcoin-wallet");
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
