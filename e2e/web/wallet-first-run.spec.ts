import type { BrowserContext } from "@playwright/test";
import { expect, openWallet, showNetwork, test, walletCard } from "../support/fixtures";
import { mockEthereum } from "../support/ethereum";
import { MAINNET_MINTS, mockMainnetMints } from "../support/mint";

/**
 * A new profile's Mainnet wallets, made by themselves on first run. Never against Mainnet: the default mints are the
 * suite's own (mockMainnetMints: fake Lightning, worthless sats) and the Ethereum RPC is answered here (mockEthereum);
 * the `mainnetGuard` fixture fails the test if anything gets past them. Under test the apps never do this by
 * themselves (an automated browser): these specs turn it on with its test switch, before the app loads.
 */
const setupOn = (context: BrowserContext) => context.addInitScript(() => { try { localStorage.setItem("ghostly-test-wallet-setup", "on"); } catch { /* opaque origin */ } });

test("a new profile gets Cashu and USDT on Mainnet by itself; a removed one does not come back after a reload", { tag: ["@feature:wallet.instances.first-run"] }, async ({ peer }) => {
  const alice = await peer("first-run", { beforeOpen: async (context) => { await mockMainnetMints(context); await mockEthereum(context); await setupOn(context); } });
  const page = alice.page;
  await openWallet(alice);
  await expect(walletCard(page, "cashu-mainnet")).toBeVisible({ timeout: 60_000 });
  await expect(walletCard(page, "usdt-mainnet")).toBeVisible({ timeout: 60_000 });
  // Real money, said so; no on-chain card while Mainnet has no on-chain wallet here; no first-wallet screen.
  await expect(page.getByTestId("wallet-network-mainnet")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("wallet-network-about")).toHaveText("Money you own: spend it with care.");
  await expect(page.locator('[data-testid^="wallet-card-bitcoin-"]')).toHaveCount(0);
  await expect(page.getByTestId("wallet-first")).toHaveCount(0);
  await expect(page.getByTestId("wallet-setup")).toHaveCount(0);

  // The person removes USDT: it stays removed, after a reload too.
  await openWallet(alice, "usdt-mainnet");
  await page.getByTestId("wallet-remove").click();
  const dialog = page.getByTestId("wallet-remove-dialog");
  const understood = dialog.getByTestId("wallet-remove-understood");
  if (await understood.count()) await understood.check();
  await dialog.getByTestId("wallet-remove-confirm").click();
  await expect(dialog).toHaveCount(0);
  await expect(walletCard(page, "usdt-mainnet")).toHaveCount(0);

  await page.reload();
  await openWallet(alice);
  await showNetwork(page, "mainnet");
  await expect(walletCard(page, "cashu-mainnet")).toBeVisible();
  // Long enough for a setup that would run again to have made it.
  await page.waitForTimeout(3_000);
  await expect(walletCard(page, "usdt-mainnet")).toHaveCount(0);
});

test("a wallet that could not be made says why on the Wallet page, and Try again makes it", { tag: ["@feature:wallet.instances.first-run"] }, async ({ peer }) => {
  const mintsDown = async (context: BrowserContext) => {
    for (const mint of MAINNET_MINTS) await context.route((url) => url.origin === new URL(mint).origin, (route) => route.abort("connectionrefused"));
  };
  const alice = await peer("first-run-down", { beforeOpen: async (context) => { await mintsDown(context); await mockEthereum(context); await setupOn(context); } });
  const page = alice.page;
  await openWallet(alice);
  await expect(walletCard(page, "usdt-mainnet")).toBeVisible({ timeout: 60_000 });
  const error = page.getByTestId("wallet-setup-error-cashu");
  await expect(error).toContainText("Mainnet Cashu:", { timeout: 60_000 });
  await expect(page.getByTestId("wallet-setup")).toContainText("Ghostly tries again at its next start");
  // New says so too, on the Cashu card of Mainnet.
  await page.getByTestId("wallet-add").click();
  await page.getByTestId("new-wallet-network-mainnet").click();
  await expect(page.getByTestId("new-wallet-type-cashu-reason")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("new-wallet")).toHaveCount(0);

  // The mints answer again (the suite's own, in their place): Try again makes it, and the notice goes.
  await mockMainnetMints(alice.context);
  await page.getByTestId("wallet-setup-retry-cashu").click();
  await expect(walletCard(page, "cashu-mainnet")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("wallet-setup")).toHaveCount(0);
});

test("under test, with no switch, a new profile makes nothing by itself: the first-wallet screen", { tag: ["@feature:wallet.instances.first-run"] }, async ({ peer }) => {
  const alice = await peer("first-run-off");
  await openWallet(alice);
  await expect(alice.page.getByTestId("wallet-first")).toBeVisible();
  await alice.page.waitForTimeout(2_000);
  await expect(alice.page.locator('[data-testid^="wallet-card-"]')).toHaveCount(0);
});
