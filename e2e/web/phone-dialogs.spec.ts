import type { Locator } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { iosKeyboard, keyboard } from "../support/keyboard";

/**
 * Dialogs and sheets on an iPhone with the keyboard up. iOS keeps the page's height and only shortens what is
 * visible (e2e/support/keyboard.ts plays that here), so a dialog centred in the page, or a sheet standing on its
 * bottom edge, had its buttons and fields under the keyboard.
 */
const PHONE = { width: 390, height: 844 };
const KEYBOARD = 336;
const VISIBLE = PHONE.height - KEYBOARD;

async function within(locator: Locator, bottom: number) {
  await expect.poll(async () => { const box = (await locator.boundingBox())!; return box.y >= 0 && box.y + box.height <= bottom + 1; }).toBe(true);
}

test("on an iPhone: a dialog and a sheet stand above the keyboard, and back where they were once it closes", { tag: ["@feature:app.mobile-layout", "@feature:groups.create"] }, async ({ peer }) => {
  const { page } = await peer("alice", { mobile: true, viewport: PHONE });
  await iosKeyboard(page);
  await expect(page.getByTitle("New Chat")).toBeVisible();

  // New group: its name field has the focus, and Create must stay in reach while typing it.
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-group").click();
  const dialog = page.getByTestId("new-group-dialog");
  await expect(page.getByTestId("new-group-name")).toBeFocused();
  await keyboard(page, KEYBOARD);
  await within(dialog, VISIBLE);
  await within(page.getByTestId("new-group-name"), VISIBLE);
  await page.getByTestId("new-group-name").fill("Ghosts");
  await page.getByTestId("new-group-create").scrollIntoViewIfNeeded();
  await within(page.getByTestId("new-group-create"), VISIBLE);
  await keyboard(page, 0);
  await expect.poll(async () => { const box = (await dialog.boundingBox())!; return box.y + box.height / 2; }).toBeGreaterThan(VISIBLE / 2 + 50);
  await page.keyboard.press("Escape");

  // A sheet (New wallet) stands on the keyboard, not on the bottom edge under it.
  await page.getByTestId("mobile-tabs").getByRole("button", { name: "Wallets" }).click();
  await page.getByTestId("wallet-add").click();
  const sheet = page.getByTestId("new-wallet");
  await expect(sheet).toBeVisible();
  await keyboard(page, KEYBOARD);
  await within(sheet, VISIBLE);
  await keyboard(page, 0);
  await expect.poll(async () => { const box = (await sheet.boundingBox())!; return Math.round(box.y + box.height); }).toBe(PHONE.height);
});

for (const phone of [{ width: 402, height: 874, keyboard: 336 }, { width: 375, height: 667, keyboard: 260 }]) {
  test(`on an iPhone ${phone.width}×${phone.height}: the lock screen's password and Unlock stand above the keyboard`, { tag: ["@feature:app.mobile-layout", "@feature:settings.lock.startup"] }, async ({ peer }) => {
    // Centred in the whole screen, the field and Unlock sat under the keyboard (an iPhone 17's Unlock 4px into it, a
    // small iPhone's field too). At start the app that keeps the visible height is not there until it is unlocked.
    const { page } = await peer("lock-phone", { mobile: true, viewport: { width: phone.width, height: phone.height } });
    await page.goto("/#/settings");
    await page.getByRole("switch", { name: "Lock Screen" }).click();
    await page.getByLabel("New password", { exact: true }).fill("phone secret");
    await page.getByLabel("Confirm password", { exact: true }).fill("phone secret");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByText("Password set successfully")).toBeVisible();

    await iosKeyboard(page);
    await expect(page.getByText("Ghostly is locked")).toBeVisible();
    const field = page.getByPlaceholder("Password");
    await field.focus();
    await keyboard(page, phone.keyboard);
    await within(field, phone.height - phone.keyboard);
    await within(page.getByRole("button", { name: "Unlock" }), phone.height - phone.keyboard);

    await field.fill("phone secret");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByText("Ghostly is locked")).toHaveCount(0);
  });
}
