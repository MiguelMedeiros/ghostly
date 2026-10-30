import { Wallet, getEncodedToken } from "@cashu/cashu-ts";
import type { Page } from "@playwright/test";
import { expect, getTestCoins, openWallet, TEST_COINS, test, useTestnet, type Peer } from "../support/fixtures";
import { invoice, lookup, pay } from "../support/mint-lnd-regtest/regtest.mjs";
import { endpoints } from "../infra/env.mjs";

/**
 * An invoice with no amount, against a real mint: GHOSTLY_MINT_LND_REGTEST=1 with e2e/infra up (npm run e2e:infra:up).
 * mintd on a regtest LND node really routes the payment to a peer's node, and the peer's node says what arrived. The
 * suite's other mint is on a fake Lightning backend, which refuses such an invoice, as most mints do. Worthless sats.
 */
test.skip(process.env.GHOSTLY_MINT_LND_REGTEST !== "1", "Requires e2e/infra (npm run e2e:infra:up) and GHOSTLY_MINT_LND_REGTEST=1");

/** The card's balance, in sats. */
const sats = async (page: Page) => Number((await page.getByTestId("wallet-balance").innerText()).replace(/[^\d]/g, ""));

/** A token for `amount` sats of this mint, paid for over Lightning by the peer's node. */
async function ecash(mint: string, amount: number): Promise<string> {
  const wallet = new Wallet(mint, { unit: "sat" });
  await wallet.loadMint();
  const quote = await wallet.createMintQuoteBolt11(amount);
  pay(quote.request);
  await expect.poll(async () => (await wallet.checkMintQuoteBolt11(quote.quote)).state, { timeout: 30_000 }).toBe("PAID");
  return getEncodedToken({ mint, unit: "sat", proofs: await wallet.mintProofsBolt11(amount, quote.quote) });
}

/** A Testnet Cashu wallet with the mint on LND added and `amount` sats on it. Leaves Send open. */
async function walletOnTheMint(alice: Peer, amount: number): Promise<Page> {
  await useTestnet(alice);
  await openWallet(alice, "cashu-testnet");
  const page = alice.page;
  const own = endpoints.mintOnLnd;
  await page.getByTestId("wallet-mint-url").fill(own);
  await page.getByTestId("wallet-add-mint").click();
  await expect(page.getByTestId("mint-row").filter({ hasText: own.replace(/^https?:\/\//, "") })).toBeVisible();

  // Sats in, as ecash from someone else: an invoice on this machine's mint is held for a payer's word in the app
  // (`paysItsOwnInvoices`), so the test process mints them, with the peer's node really paying the mint's invoice.
  await page.getByTestId("wallet-send").click();
  await page.getByTestId("wallet-pay-input").fill(await ecash(own, amount));
  await page.getByRole("button", { name: "Redeem" }).click();
  await expect.poll(() => sats(page), { timeout: 30_000 }).toBe(amount);
  return page;
}

test("a mint on real Lightning pays an invoice with no amount, for the amount typed", { tag: ["@gated", "@feature:wallet.cashu.pay-no-amount"] }, async ({ peer }) => {
  test.setTimeout(180_000);
  const page = await walletOnTheMint(await peer("alice"), 1000);

  // The test mint comes first in the list, and is not asked: only the mint that says it takes one is.
  const { payment_request: request, r_hash: hash } = invoice();
  await page.getByTestId("wallet-pay-input").fill(request);
  await expect(page.getByTestId("wallet-pay-choose")).toBeVisible();
  await page.getByTestId("wallet-pay-amount").fill("90");
  await page.getByRole("button", { name: "Pay 90 test sats" }).click();
  await expect(page.getByTestId("wallet-pay-review")).toContainText("Pay 90 test sats", { timeout: 30_000 });
  await page.getByTestId("wallet-pay-confirm").click();
  await expect(page.getByTestId("wallet-send-result").getByTestId("wallet-notice")).toHaveText("Paid.", { timeout: 60_000 });

  // The other side of the channel got exactly what was typed.
  await expect.poll(() => lookup(hash).state, { timeout: 30_000 }).toBe("SETTLED");
  expect(lookup(hash).amt_paid_sat).toBe("90");
  // The 90 sats left the card; what is left of the fee reserve came back.
  await expect.poll(() => sats(page), { timeout: 30_000 }).toBeLessThanOrEqual(910);
  expect(await sats(page)).toBeGreaterThanOrEqual(900);
});

test("Max on a real mint comes down by its fee, and all of what the review says arrives", { tag: ["@gated", "@feature:wallet.cashu.pay-no-amount"] }, async ({ peer }) => {
  test.setTimeout(180_000);
  const page = await walletOnTheMint(await peer("alice"), 200);

  const { payment_request: request, r_hash: hash } = invoice();
  await page.getByTestId("wallet-pay-input").fill(request);
  await page.getByTestId("wallet-pay-max").click();
  await expect(page.getByTestId("wallet-pay-amount")).toHaveValue("200");
  await page.getByRole("button", { name: "Pay 200 test sats" }).click();
  const review = page.getByTestId("wallet-pay-review");
  await expect(review).toContainText(/Pay 19\d test sats/, { timeout: 30_000 });
  const reviewed = Number(/Pay (\d+) test sats/.exec(await review.innerText())![1]);
  await page.getByTestId("wallet-pay-confirm").click();
  await expect(page.getByTestId("wallet-send-result").getByTestId("wallet-notice")).toHaveText("Paid.", { timeout: 60_000 });
  await expect.poll(() => lookup(hash).state, { timeout: 30_000 }).toBe("SETTLED");
  expect(lookup(hash).amt_paid_sat).toBe(String(reviewed));
});

test("a mint on fake Lightning does not say it takes one, and Send says so before anything is spent", { tag: ["@gated", "@feature:wallet.cashu.pay-no-amount"] }, async ({ peer }) => {
  const alice = await peer("alice");
  await useTestnet(alice);
  await getTestCoins(alice);
  const page = alice.page;
  // The balance counts up to what arrived.
  await expect.poll(() => sats(page)).toBe(TEST_COINS);

  await page.getByTestId("wallet-send").click();
  await page.getByTestId("wallet-pay-input").fill(invoice().payment_request);
  await page.getByTestId("wallet-pay-amount").fill("90");
  await page.getByRole("button", { name: "Pay 90 test sats" }).click();
  await expect(page.getByTestId("wallet-error")).toContainText("None of your mints can pay an invoice with no amount");
  await expect(page.getByTestId("wallet-pay-review")).toHaveCount(0);
  expect(await sats(page)).toBe(TEST_COINS);
});
