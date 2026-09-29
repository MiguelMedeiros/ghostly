import type { Page } from "@playwright/test";
import { createWallet, expect, getTestCoins, openWallet, test, useTestnet } from "../support/fixtures";
import { mockMainnetMints } from "../support/mint";

/**
 * The backup reminder: the first real money in a Mainnet wallet brings one calm card to the Wallet page and a dot to
 * the wallet icon. "Later" puts it off until the next receive; for Cashu (no recovery phrase) its button opens the
 * profile's backups, and a profile backup made then ends it for good. Test coins only: Mainnet runs against the
 * suite's own mint (mockMainnetMints), whose sats are worthless, and no real mint is reached.
 */

/** Sats in over Lightning into the chosen Cashu card, from the suite's own mint (it settles its invoices by itself). */
async function receive(page: Page, amount: number) {
  await page.getByTestId("wallet-receive").click();
  await page.getByTestId("wallet-receive-amount").fill(String(amount));
  await page.getByTestId("wallet-create-invoice").click();
  await expect(page.getByTestId("wallet-paid")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("wallet-panel").getByRole("button", { name: "Done", exact: true }).click();
}

test("the first real money asks once for a backup; Later waits for the next receive; a profile backup ends it", { tag: ["@feature:wallet.backup-reminder", "@feature:backup.profile.file"] }, async ({ peer }, testInfo) => {
  const alice = await peer("backup-reminder");
  await mockMainnetMints(alice.context);
  await createWallet(alice, "cashu", "mainnet");
  const page = alice.page;
  const reminder = page.getByTestId("backup-reminder");
  const dot = page.getByTestId("wallet-backup-due");
  const balance = () => page.getByTestId("wallet-balance").innerText().then((text) => text.trim());

  // An empty wallet asks nothing.
  await openWallet(alice, "cashu-mainnet");
  await expect(reminder).toHaveCount(0);
  await expect(dot).toHaveCount(0);

  await receive(page, 50);
  await expect.poll(balance, { timeout: 15_000 }).toMatch(/^50\s*sats/);
  await expect(reminder).toBeVisible();
  await expect(reminder).toHaveAttribute("data-wallet", "cashu:mainnet");
  await expect(reminder).toContainText("You have real money in Cashu");
  await expect(reminder.getByTestId("backup-reminder-go")).toHaveText("Back up profile");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(dot).toBeVisible();
  await expect(page.getByTestId("wallet-chip")).toHaveAttribute("aria-label", /backup needed$/);
  await reminder.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("backup-reminder.png") });
  await reminder.getByTestId("row-info").click();
  await expect(reminder.getByTestId("row-info-text")).toContainText("Cashu has no recovery phrase");
  await reminder.screenshot({ path: testInfo.outputPath("backup-reminder-info.png") });
  await page.getByTestId("account-bar").screenshot({ path: testInfo.outputPath("backup-reminder-dot.png") });

  // Later: gone, the dot too, and still gone after a reload (the engine keeps it, not the page).
  await reminder.getByTestId("backup-reminder-later").click();
  await expect(reminder).toHaveCount(0);
  await expect(dot).toHaveCount(0);
  await page.reload();
  await openWallet(alice, "cashu-mainnet");
  await expect.poll(balance, { timeout: 15_000 }).toMatch(/^50\s*sats/);
  await expect(reminder).toHaveCount(0);

  // The next receive brings it back, once.
  await receive(page, 20);
  await expect.poll(balance, { timeout: 15_000 }).toMatch(/^70\s*sats/);
  await expect(reminder).toBeVisible();

  // Its button: the profile's backups, open, the passphrase in focus. A profile backup made now ends it.
  await reminder.getByTestId("backup-reminder-go").click();
  await expect(page.getByTestId("profile-page")).toBeVisible();
  const backups = page.getByTestId("profile-backups");
  await expect(backups.getByTestId("backup-passphrase")).toBeFocused();
  await backups.getByTestId("backup-passphrase").fill("a reminder backup passphrase");
  await backups.getByTestId("backup-confirm").fill("a reminder backup passphrase");
  const downloading = page.waitForEvent("download");
  await backups.getByTestId("backup-download").click();
  await downloading;
  await expect(backups.getByTestId("backup-done")).toContainText("Downloaded");
  await expect(dot).toHaveCount(0);

  await openWallet(alice, "cashu-mainnet");
  await expect.poll(balance, { timeout: 15_000 }).toMatch(/^70\s*sats/);
  await expect(reminder).toHaveCount(0);
  await page.reload();
  await openWallet(alice, "cashu-mainnet");
  await expect.poll(balance, { timeout: 15_000 }).toMatch(/^70\s*sats/);
  await expect(reminder).toHaveCount(0);
  await expect(dot).toHaveCount(0);
});

test("test coins never ask for a backup", { tag: ["@feature:wallet.backup-reminder"] }, async ({ peer }) => {
  const bob = await peer("backup-reminder-test");
  await useTestnet(bob);
  await getTestCoins(bob);
  await expect(bob.page.getByTestId("wallet-balance")).toHaveText(/^10,000\s*test sats/);
  await expect(bob.page.getByTestId("backup-reminder")).toHaveCount(0);
  await expect(bob.page.getByTestId("wallet-backup-due")).toHaveCount(0);
});
