import { expect, openWallet, test, useFakeProviders, useTestnet } from "../support/fixtures";

/**
 * Where Lightning and on-chain Bitcoin come from: a source per wallet mode, picked on the card. The
 * sources here are the fake ones (regtest, in memory), so nothing leaves this machine; real providers
 * run the same picker with their own form, and their own gated e2e (see e2e/README.md).
 */

test("the Lightning card starts on the Cashu mints and offers only what this mode can run", async ({ peer }) => {
  const alice = await peer("sources-default");
  await openWallet(alice, "lightning");
  const source = alice.page.getByTestId("lightning-source");
  await expect(source.getByTestId("lightning-source-current")).toContainText("Cashu mints");
  await expect(source.getByTestId("lightning-source-current")).toContainText("Default");
  await expect(alice.page.getByTestId("wallet-card-lightning")).toContainText("Invoices via Cashu");
  // Without the test flag the fakes are not there, in either mode. (Counted loosely: every real provider adds one.)
  for (const mode of ["mainnet", "testnet"]) {
    if (mode === "testnet") { await useTestnet(alice); await openWallet(alice, "lightning"); }
    const options = alice.page.getByTestId("lightning-source-select").locator("option");
    await expect(options.first()).toHaveText(/^\d+ available…$/);
    await expect(options.filter({ hasText: "Cashu mints" })).toHaveCount(1);
    await expect(options.filter({ hasText: "(test)" })).toHaveCount(0);
  }
});

test("a Lightning source is picked per mode: invoices go through it, and Mainnet keeps its own", async ({ peer }) => {
  const alice = await peer("sources-lightning");
  await useFakeProviders(alice);
  await useTestnet(alice);
  await openWallet(alice, "lightning");
  const page = alice.page, source = page.getByTestId("lightning-source");

  await source.getByTestId("lightning-source-select").selectOption("fake-lightning");
  const form = source.getByTestId("provider-form-fake-lightning");
  await form.getByLabel("Name").fill("Test node");
  await form.getByLabel("Access token").fill("not-a-real-secret");
  await form.getByTestId("provider-save").click();
  await expect(source.getByTestId("lightning-source-saved")).toBeVisible();
  await expect(source.getByTestId("lightning-source-current")).toContainText("Fake Lightning (test)");
  await expect(source.getByTestId("lightning-source-status")).toContainText("Connected");
  await expect(page.getByTestId("wallet-card-lightning")).toContainText("Via Test node");
  await expect(page.getByTestId("wallet-balance")).toContainText("100,000");
  // The secret is sealed in the engine: never back in the page.
  expect(await page.content()).not.toContain("not-a-real-secret");

  // Receive: the invoice is the source's (regtest), and it is seen paid through the source.
  await page.getByTestId("wallet-receive").click();
  await page.getByTestId("wallet-receive-amount").fill("12");
  await page.getByTestId("wallet-create-invoice").click();
  await expect(page.getByTestId("wallet-invoice")).toHaveText(/^\s*lnbcrt/);
  await expect(page.getByTestId("wallet-paid")).toContainText("12 test sats received", { timeout: 30_000 });
  await expect(page.getByTestId("lightning-recent").getByTestId("lightning-op").first()).toContainText("paid");

  // Mainnet has its own source: still the mints. Back in Testnet, the fake is still there.
  await page.getByTestId("wallet-mode").getByRole("radio", { name: "Mainnet" }).click();
  await expect(page.getByTestId("wallet-card-lightning")).toContainText("Invoices via Cashu");
  await expect(source.getByTestId("lightning-source-current")).toContainText("Cashu mints");
  await page.getByTestId("wallet-mode").getByRole("radio", { name: "Testnet" }).click();
  await expect(page.getByTestId("wallet-card-lightning")).toContainText("Via Test node");

  // Back to the default.
  await source.getByTestId("lightning-source-clear").click();
  await expect(source.getByTestId("lightning-source-current")).toContainText("Cashu mints");
  await expect(page.getByTestId("wallet-card-lightning")).toContainText("Invoices via Cashu");
});

test("the Bitcoin card says no source is configured, and pays on-chain through one once it is", async ({ peer }) => {
  const alice = await peer("sources-bitcoin");
  await openWallet(alice, "bitcoin");
  const page = alice.page, panel = page.getByTestId("bitcoin-wallet");
  await expect(page.getByTestId("wallet-card-bitcoin")).toContainText("No source");
  await expect(panel.getByTestId("bitcoin-empty")).toContainText("No Bitcoin source configured");
  await expect(panel.getByTestId("onchain-source-none-offered")).toBeVisible();

  await useFakeProviders(alice);
  await useTestnet(alice);
  await openWallet(alice, "bitcoin");
  await expect(panel.getByTestId("bitcoin-empty")).toBeVisible();
  // Bitcoin Core is registered, but its RPC has no CORS: it is offered on Desktop only, never here. BDK runs in the page.
  await expect(panel.getByTestId("onchain-source-select").locator("option")).toHaveText(["2 available…", /BDK wallet/, /Fake Bitcoin wallet/]);
  await panel.getByTestId("onchain-source-select").selectOption("fake-onchain");
  await panel.getByTestId("provider-form-fake-onchain").getByLabel("Access token").fill("token");
  await panel.getByTestId("provider-save").click();
  await expect(page.getByTestId("wallet-card-bitcoin")).toContainText("100,000 test sats");

  await panel.getByTestId("bitcoin-new-address").click();
  await expect(panel.getByTestId("bitcoin-address")).toHaveText(/^\s*bcrt1/);

  await page.getByTestId("wallet-send").click();
  await panel.getByLabel("Bitcoin recipient address").fill("bcrt1qs758ursh4q9z627kt3pp5yysm78ddny6txaqgw");
  await panel.getByTestId("bitcoin-amount").fill("1000");
  await panel.getByRole("button", { name: "Review payment" }).click();
  const review = panel.getByTestId("payment-review");
  await expect(review).toContainText("bitcoin · regtest");
  await review.getByRole("button", { name: "Approve payment" }).click();
  await expect(review.getByTestId("review-status")).toHaveText(/submitted|settled/);
  await expect(review.getByTestId("review-status")).toHaveText("settled", { timeout: 30_000 });
});
