import type { BrowserContext, Page } from "@playwright/test";
import { expect, test, walletCard } from "../support/fixtures";
import { pasteInvite } from "../support/clipboard";
import { DEVICE_SET_PASSWORD, finishJoin } from "../support/devices";
import { mockEthereum } from "../support/ethereum";
import { mockMainnetMints } from "../support/mint";

/**
 * A phone adds itself to the desktop's profile with first-run Mainnet wallets on, as every new profile of the installed
 * web app makes them: Cashu, which brings the Cashu mints' Lightning card, and USDT. Those hold nothing, so they never
 * make a profile "in use". Under test the apps never make them by themselves (an automated browser): this spec turns
 * the setup on with its test switch, and answers the mints and the Ethereum RPC itself. Phone width throughout.
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

/** The desktop's Add a device, up to the QR code: its link, as the phone's camera reads it. */
async function showCode(page: Page) {
  await page.goto("/#/profile");
  await page.getByTestId("device-add-open").click();
  const add = page.getByTestId("device-add");
  await add.getByTestId("device-add-password").fill(DEVICE_SET_PASSWORD);
  await add.getByTestId("device-add-password-again").fill(DEVICE_SET_PASSWORD);
  await add.getByTestId("device-add-next").click();
  const link = (await add.getByTestId("device-add-code").getAttribute("data-link"))!;
  return { add, link };
}

/**
 * From here on the phone asks a new profile "What should people call you?" as a person's app does (`NameStep`, off under
 * test), so a profile added from another device shows it never asks.
 */
const nameStepOn = (page: Page) => page.evaluate(() => localStorage.setItem("ghostly-test-name-step", "on"));
/** Whether a profile on this page still has the first-run name question pending. */
const namePending = (page: Page) => page.evaluate(() => Object.keys(localStorage).some((key) => key.endsWith("name_step") && localStorage.getItem(key) === "ask"));

const phoneOptions = { mobile: true, beforeOpen: async (context: BrowserContext) => { await mockMainnetMints(context); await mockEthereum(context); await setupOn(context); } };

test("a locked phone in use opens the code's link: one password, one button, and the new profile joins with its first-run wallets on", { tag: ["@feature:devices.enroll", "@feature:wallet.instances.first-run"] }, async ({ peer }) => {
  const [desktop, phone] = await Promise.all([peer("desktop"), peer("phone", phoneOptions)]);
  let page = phone.page;

  // The phone is in use: a chat, and a lock password. The app opens a new chat once it is made, so the chat is made
  // before the test goes on: on a busy machine it opened over Settings and took the lock's form away.
  await page.getByTitle("New Chat").click();
  await expect(page.getByTestId("invite-card")).toBeVisible();
  await page.goto("/#/");
  await expect(page.getByTestId("chat-row")).toHaveCount(1);
  await setLock(page, DEVICE_SET_PASSWORD);
  await nameStepOn(page);

  const { add, link } = await showCode(desktop.page);

  // The camera opens the link: the phone's own lock first (it is the phone's), then the one screen.
  const origin = new URL(page.url()).origin;
  await page.close();
  page = await phone.context.newPage();
  await page.goto(link.replace(/^https?:\/\/[^/]+/, origin));
  await expect(page.getByText("Ghostly is locked")).toBeVisible();
  await page.getByPlaceholder("Password").fill(DEVICE_SET_PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();
  const form = page.getByTestId("device-join-confirm");
  await expect(form).toHaveAttribute("data-place", "new");
  await page.getByTestId("device-join-name").fill("Phone");
  await page.getByTestId("device-join-next").click();

  // The new profile has the same lock, passed a moment ago in this tab: it is not asked again. It starts, makes its
  // first-run wallets, and goes on to the digits by itself.
  const desktopDigits = add.getByTestId("device-add-digits");
  await expect(desktopDigits).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Ghostly is locked")).toHaveCount(0);
  await expect(page.getByTestId("device-join-digits")).toHaveAttribute("data-digits", (await desktopDigits.getAttribute("data-digits"))!);
  await add.getByTestId("device-add-match").click();
  await expect(add.getByTestId("device-add-done")).toHaveText("Phone added. It is on standby.");
  await expect(page.getByTestId("device-join-done")).toHaveAttribute("data-step", "done");
  // And on to the standby screen, still without the password a second time.
  await finishJoin(page);
  await expect(page.getByText("Ghostly is locked")).toHaveCount(0);
  // The profile made for the code is not a new one: it never asks for a name (the question opens just after a start).
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId("name-step")).toHaveCount(0);
});

test("a new profile that already made its first-run wallets joins in place: the one screen sees it is not in use", { tag: ["@feature:devices.enroll", "@feature:wallet.instances.first-run"] }, async ({ peer }) => {
  const [desktop, phone] = await Promise.all([peer("desktop"), peer("phone", phoneOptions)]);
  const page = phone.page;

  // A new profile, left open for a moment: it makes its first-run wallets.
  await page.goto("/#/wallet");
  await expect(walletCard(page, "cashu-mainnet")).toBeVisible({ timeout: 60_000 });
  await expect(walletCard(page, "usdt-mainnet")).toBeVisible({ timeout: 60_000 });
  // Its first start would ask for a name; it is added to a profile instead.
  expect(await namePending(page)).toBe(true);
  await nameStepOn(page);

  const { add, link } = await showCode(desktop.page);

  // I already use Ghostly, on its empty chat list; the code pasted as the scanner reads it.
  await page.goto("/#/");
  await page.getByTestId("sidebar-already").click();
  await page.getByTestId("device-join-add").click();
  await pasteInvite(page, link);
  await expect(page.getByTestId("device-join-confirm")).toHaveAttribute("data-place", "here");
  await page.getByTestId("device-join-name").fill("Phone");
  await page.getByTestId("device-join-next").click();

  const desktopDigits = add.getByTestId("device-add-digits");
  await expect(desktopDigits).toBeVisible();
  await expect(page.getByTestId("device-join-digits")).toHaveAttribute("data-digits", (await desktopDigits.getAttribute("data-digits"))!);
  await add.getByTestId("device-add-match").click();
  await expect(add.getByTestId("device-add-done")).toHaveText("Phone added. It is on standby.");
  await expect(page.getByTestId("device-join-done")).toHaveAttribute("data-step", "done");
  // Added to a profile from another device: the first start's name question is gone, for the standby and after.
  await finishJoin(page);
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId("name-step")).toHaveCount(0);
  expect(await namePending(page)).toBe(false);
});
