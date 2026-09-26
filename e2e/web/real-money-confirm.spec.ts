import { createWallet, expect, openWallet, test } from "../support/fixtures";
import { mockMainnetMints } from "../support/mint";

/**
 * Real money leaves only once confirmed as such: Pay on a Mainnet wallet opens a second step that says so in words,
 * Back sends nothing, and only Send real money pays (the engine refuses a Mainnet spend without it). Test coins only:
 * Mainnet runs against the suite's own mint (mockMainnetMints), whose sats are worthless.
 */

test("the Cashu card's Pay on Mainnet asks once more in words; Back pays nothing, Send real money pays", { tag: ["@network", "@feature:payments.mainnet-confirm", "@feature:wallet.cashu.pay-invoice"] }, async ({ peer }) => {
  const alice = await peer("real-confirm");
  await mockMainnetMints(alice.context);
  await createWallet(alice, "cashu", "mainnet");
  const page = alice.page;
  const balance = () => page.getByTestId("wallet-balance").innerText().then((text) => text.trim());

  // Sats in over Lightning, from the suite's own mint (worthless, self-settling), into the Mainnet card.
  await openWallet(alice, "cashu-mainnet");
  await page.getByTestId("wallet-receive").click();
  await page.getByTestId("wallet-receive-amount").fill("50");
  await page.getByTestId("wallet-create-invoice").click();
  await expect(page.getByTestId("wallet-paid")).toBeVisible({ timeout: 60_000 });
  await expect.poll(balance, { timeout: 15_000 }).toMatch(/^50\s*sats/);

  // An invoice to pay: one more of the same mint's, which settles itself once paid.
  await page.getByRole("button", { name: "New amount" }).click();
  await page.getByTestId("wallet-receive-amount").fill("10");
  await page.getByTestId("wallet-create-invoice").click();
  const invoice = (await page.getByTestId("wallet-invoice").textContent())!.trim();
  expect(invoice).toMatch(/^lnbc/);

  await page.getByTestId("wallet-send").click();
  await page.getByTestId("wallet-pay-input").fill(invoice);
  await page.getByRole("button", { name: "Pay 10 sats" }).click();
  await page.getByTestId("wallet-pay-confirm").click();
  const confirm = page.getByTestId("review-mainnet-confirm");
  await expect(confirm).toContainText("Real money. This sends 10 sats");
  await expect(confirm).toContainText("Nothing has gone out yet.");
  // Focus waits on Back: a second Enter on Pay is not the confirmation.
  await expect(confirm.getByTestId("review-confirm-back")).toBeFocused();
  await confirm.getByTestId("review-confirm-back").click();
  await expect(confirm).toHaveCount(0);
  await expect.poll(balance).toMatch(/^50\s*sats/);

  await page.getByTestId("wallet-pay-confirm").click();
  await page.getByTestId("review-confirm-send").click();
  await expect(page.getByText("Paid.", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("review-mainnet-confirm")).toHaveCount(0);
});
