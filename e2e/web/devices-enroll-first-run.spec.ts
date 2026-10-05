import type { BrowserContext, Page } from "@playwright/test";
import { expect, test, walletCard } from "../support/fixtures";
import { pasteInvite } from "../support/clipboard";
import { DEVICE_SET_PASSWORD } from "../support/devices";
import { mockEthereum } from "../support/ethereum";
import { mockMainnetMints } from "../support/mint";

/**
 * A phone adds itself to the desktop's profile once its new profile made its first-run Mainnet wallets, as every new
 * profile of the installed web app does: Cashu, which brings the Cashu mints' Lightning card, and USDT. Those hold
 * nothing, so the profile is not in use. Under test the apps never make them by themselves (an automated browser):
 * this spec turns the setup on with its test switch, and answers the mints and the Ethereum RPC itself.
 *
 * The phone is in use (a chat, a lock password), so it goes through "Add this device to another profile": the new
 * profile starts locked like the one it came from, gets its own first-run wallets, and then joins.
 */

const setupOn = (context: BrowserContext) => context.addInitScript(() => { try { localStorage.setItem("ghostly-test-wallet-setup", "on"); } catch { /* opaque origin */ } });

async function setLock(page: Page, password: string): Promise<void> {
  await page.goto("/#/settings/privacy");
  await page.getByRole("switch", { name: "Lock Screen" }).click();
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Password set successfully")).toBeVisible();
}

test("a phone in use adds itself in another profile after that profile made its first-run wallets", { tag: ["@feature:devices.enroll", "@feature:wallet.instances.first-run"] }, async ({ peer }) => {
  const [desktop, phone] = await Promise.all([
    peer("desktop"),
    peer("phone", { mobile: true, beforeOpen: async (context) => { await mockMainnetMints(context); await mockEthereum(context); await setupOn(context); } }),
  ]);
  const page = phone.page;

  // The phone is in use: a chat, and a lock password.
  await page.getByTitle("New Chat").click();
  await page.goto("/#/");
  await setLock(page, DEVICE_SET_PASSWORD);

  // Add this device to another profile: the new profile opens behind the same lock, at the device's name.
  await page.goto("/#/profile");
  await page.getByTestId("profile-join-another").click();
  await page.getByTestId("device-join-another-go").click();
  await expect(page.getByText("Ghostly is locked")).toBeVisible();
  await page.getByPlaceholder("Password").fill(DEVICE_SET_PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("device-join-name-form")).toBeVisible();

  // Before it joins, the new profile has made its first-run wallets, as it does on a phone left open for a moment.
  await page.keyboard.press("Escape");
  await page.goto("/#/wallet");
  await expect(walletCard(page, "cashu-mainnet")).toBeVisible({ timeout: 60_000 });
  await expect(walletCard(page, "usdt-mainnet")).toBeVisible({ timeout: 60_000 });

  await desktop.page.goto("/#/profile");
  await desktop.page.getByTestId("device-add-open").click();
  const add = desktop.page.getByTestId("device-add");
  await add.getByTestId("device-add-password").fill(DEVICE_SET_PASSWORD);
  await add.getByTestId("device-add-password-again").fill(DEVICE_SET_PASSWORD);
  await add.getByTestId("device-add-next").click();
  const code = (await add.getByTestId("device-add-code").getAttribute("data-code"))!;

  // I already use Ghostly, on the new profile's empty chat list: the wallets it made by itself do not stop it.
  await page.goto("/#/");
  await page.getByTestId("sidebar-already").click();
  await page.getByTestId("device-join-add").click();
  await page.getByTestId("device-join-name").fill("Phone");
  await page.getByTestId("device-join-next").click();
  await pasteInvite(page, code);
  await expect(page.getByTestId("device-join-another")).toHaveCount(0);

  const desktopDigits = add.getByTestId("device-add-digits");
  await expect(desktopDigits).toBeVisible();
  await expect(page.getByTestId("device-join-digits")).toHaveAttribute("data-digits", (await desktopDigits.getAttribute("data-digits"))!);
  await add.getByTestId("device-add-match").click();
  await expect(add.getByTestId("device-add-done")).toHaveText("Phone added. It is on standby.");
  await expect(page.getByTestId("device-join-done")).toHaveAttribute("data-step", "done");
});
