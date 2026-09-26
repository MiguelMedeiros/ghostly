import { createWallet, expect, openWallet, test, useFakeProviders, type Peer, type WalletNetwork } from "../support/fixtures";
import { mockMainnetMints } from "../support/mint";
import { choose, optionsOf, close } from "../support/select";

/**
 * Where Lightning and on-chain Bitcoin come from: a source per wallet, each wallet on its own network. New makes
 * one with the source picked in its dialog; a wallet already made changes its source on its card. The sources here
 * are the fake ones (regtest, in memory), so nothing leaves this machine; real providers run the same picker with
 * their own form, and their own gated e2e (see e2e/README.md). Mainnet Cashu runs against mocked mints.
 */

/** Wallets → New → a network (→ a kind), the dialog left open. */
async function newDialog(p: Peer, network: WalletNetwork, kind?: string) {
  await openWallet(p);
  await expect(p.page.getByTestId("wallet")).toBeVisible();
  await p.page.getByTestId("wallet-add").click();
  const dialog = p.page.getByTestId("new-wallet");
  await dialog.getByRole("radio", { name: network === "testnet" ? "Testnet" : "Mainnet" }).click();
  if (kind) await dialog.getByTestId(`new-wallet-type-${kind}`).click();
  return dialog;
}

async function closeDialog(p: Peer) {
  await p.page.keyboard.press("Escape");
  await expect(p.page.getByTestId("new-wallet")).toHaveCount(0);
}

test("a Cashu wallet's Lightning card starts on its mints, and each network offers only what it can run", { tag: ["@feature:wallet.lightning.sources", "@feature:wallet.instances.networks"] }, async ({ peer }) => {
  const alice = await peer("sources-default");
  await mockMainnetMints(alice.context);
  // Without the test flag the fakes are not there, on either network. (Counted loosely: every real provider adds one.)
  for (const network of ["mainnet", "testnet"] as const) {
    await createWallet(alice, "cashu", network);
    await openWallet(alice, `lightning-${network}`);
    const source = alice.page.getByTestId("lightning-source");
    await expect(source.getByTestId("lightning-source-current")).toContainText("Cashu mints");
    await expect(source.getByTestId("lightning-source-current")).toContainText("Default");
    await expect(alice.page.getByTestId(`wallet-card-lightning-${network}`)).toContainText("Invoices via Cashu");
    const select = source.getByTestId("lightning-source-select");
    await expect(select).toHaveText(/^\d+ available…$/);
    const options = await optionsOf(select);
    await expect(options.filter({ hasText: "Cashu mints" })).toHaveCount(1);
    await expect(options.filter({ hasText: "(test)" })).toHaveCount(0);
    await close(select);

    // New offers the other sources, for a Lightning wallet of their own: never the mints (they come with Cashu), never a fake.
    const dialog = await newDialog(alice, network, "lightning");
    await expect(dialog.getByTestId("new-wallet-type-lightning-status")).toHaveText("Choose a source");
    const picker = dialog.getByTestId("new-wallet-provider-select");
    const offered = await optionsOf(picker);
    expect(await offered.count()).toBeGreaterThan(0);
    await expect(offered.filter({ hasText: "Cashu mints" })).toHaveCount(0);
    await expect(offered.filter({ hasText: "(test)" })).toHaveCount(0);
    await close(picker);
    await closeDialog(alice);
  }
});

test("a Lightning source is picked per wallet: invoices go through it, and the Mainnet wallet keeps its own", { tag: ["@feature:wallet.lightning.sources", "@feature:wallet.instances.networks"] }, async ({ peer }) => {
  const alice = await peer("sources-lightning");
  await mockMainnetMints(alice.context);
  await useFakeProviders(alice);
  await createWallet(alice, "cashu", "testnet");
  await createWallet(alice, "cashu", "mainnet");
  await openWallet(alice, "lightning-testnet");
  const page = alice.page, source = page.getByTestId("lightning-source");
  const testnetCard = page.getByTestId("wallet-card-lightning-testnet"), mainnetCard = page.getByTestId("wallet-card-lightning-mainnet");

  await choose(source.getByTestId("lightning-source-select"), "fake-lightning");
  const form = source.getByTestId("provider-form-fake-lightning");
  await form.getByLabel("Name").fill("Test node");
  await form.getByLabel("Access token").fill("not-a-real-secret");
  await form.getByTestId("provider-save").click();
  await expect(source.getByTestId("lightning-source-saved")).toBeVisible();
  await expect(source.getByTestId("lightning-source-current")).toContainText("Fake Lightning (test)");
  await expect(source.getByTestId("lightning-source-status")).toContainText("Connected");
  await expect(testnetCard).toContainText("Via Test node");
  await expect(page.getByTestId("wallet-balance")).toContainText("100,000");
  // The secret is sealed in the engine: never back in the page.
  expect(await page.content()).not.toContain("not-a-real-secret");

  // Receive: the invoice is the source's (regtest), and it is seen paid through the source.
  await page.getByTestId("wallet-receive").click();
  await page.getByTestId("wallet-receive-amount").fill("12");
  await page.getByTestId("wallet-create-invoice").click();
  await expect(page.getByTestId("wallet-invoice")).toHaveText(/^\s*lnbcrt/);
  await expect(page.getByTestId("wallet-paid")).toContainText("12 sats received", { timeout: 30_000 });
  await expect(page.getByTestId("lightning-recent").getByTestId("lightning-op").first()).toContainText("paid");

  // The Mainnet Lightning wallet has its own source, open beside it: still the mints. The Testnet one keeps the fake.
  await openWallet(alice, "lightning-mainnet");
  await expect(mainnetCard).toContainText("Invoices via Cashu");
  await expect(source.getByTestId("lightning-source-current")).toContainText("Cashu mints");
  await expect(testnetCard).toContainText("Via Test node");

  // Back to the default.
  await openWallet(alice, "lightning-testnet");
  await source.getByTestId("lightning-source-clear").click();
  await expect(source.getByTestId("lightning-source-current")).toContainText("Cashu mints");
  await expect(testnetCard).toContainText("Invoices via Cashu");
});

test("no Bitcoin wallet until New makes one with a source, on Testnet only; then it pays on-chain through it", { tag: ["@feature:wallet.onchain.sources", "@feature:wallet.instances.create"] }, async ({ peer }) => {
  const alice = await peer("sources-bitcoin");
  const page = alice.page, panel = page.getByTestId("bitcoin-wallet");
  // Nothing is made by itself: no Bitcoin card.
  await openWallet(alice);
  await expect(page.getByTestId("wallet-first")).toBeVisible();
  await expect(page.locator("[data-testid^=wallet-card-bitcoin-]")).toHaveCount(0);
  // Mainnet: no on-chain source runs in a browser yet.
  const dialog = await newDialog(alice, "mainnet");
  const bitcoin = dialog.getByTestId("new-wallet-type-bitcoin");
  await expect(bitcoin).toHaveAttribute("aria-disabled", "true");
  await expect(dialog.getByTestId("new-wallet-type-bitcoin-status")).toHaveText("Not yet");
  await expect(bitcoin).toContainText("No on-chain wallet runs on Mainnet here yet");
  // Testnet, without the test flag: BDK alone, which runs in the page. Bitcoin Core's RPC has no CORS: Desktop only.
  await dialog.getByRole("radio", { name: "Testnet" }).click();
  await bitcoin.click();
  await expect(dialog.getByTestId("new-wallet-provider").getByTestId("provider-form-bdk")).toBeVisible();
  await expect(dialog.getByTestId("new-wallet-provider-select")).toHaveCount(0);
  await closeDialog(alice);

  await useFakeProviders(alice);
  const again = await newDialog(alice, "testnet", "bitcoin");
  const picker = again.getByTestId("new-wallet-provider-select");
  await expect(await optionsOf(picker)).toHaveText([/BDK wallet/, /Fake Bitcoin wallet/]);
  await close(picker);
  await choose(picker, "fake-onchain");
  const form = again.getByTestId("provider-form-fake-onchain");
  await form.getByLabel("Access token").fill("token");
  await form.getByTestId("provider-save").click();
  await expect(again).toHaveCount(0);
  await expect(page.getByTestId("wallet-card-bitcoin-testnet")).toContainText("100,000 test sats");
  await expect(page.getByTestId("wallet-card-bitcoin-testnet").getByTestId("wallet-card-network")).toHaveText("Testnet");

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
