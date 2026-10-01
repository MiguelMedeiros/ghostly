import { expect, test } from "../support/extension";

/**
 * The extension makes a new profile's Mainnet wallets by itself, but never in an automated browser: its peer runs in
 * the offscreen document, which reads `navigator.webdriver` too. Under test a new profile starts with no wallet.
 */
test("under test the extension makes no wallet by itself: a new profile shows the first-wallet screen", { tag: ["@feature:wallet.instances.first-run"] }, async ({ extensionPeer }) => {
  const { page } = await extensionPeer("first-run-off");
  await page.getByTestId("wallet-chip").click();
  await expect(page.getByTestId("wallet-first")).toBeVisible();
  // Long enough for a setup that would run to have made its first wallet.
  await page.waitForTimeout(3_000);
  await expect(page.locator('[data-testid^="wallet-card-"]')).toHaveCount(0);
  await expect(page.getByTestId("wallet-setup")).toHaveCount(0);
});
