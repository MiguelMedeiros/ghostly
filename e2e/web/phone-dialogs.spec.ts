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
    await page.goto("/#/settings/privacy");
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

for (const screen of [{ name: "an iPad mini on its side", width: 1133, height: 744, keyboard: 360, bar: 66 }, { name: "an iPhone on its side", width: 874, height: 402, keyboard: 200, bar: 68 }]) {
  test(`${screen.name}: two panes, and the message field stands above the keyboard`, { tag: ["@feature:app.mobile-layout", "@feature:app.responsive"] }, async ({ peer }) => {
    // From 768px the app shows two panes, and they kept the screen's height with the keyboard up: the message field
    // was under it. In the iOS Simulator (iPad mini on its side) Safari scrolled the whole page to reach the field,
    // and left it scrolled, a blank band under the panes, once the keyboard went.
    const { page } = await peer("tablet", { mobile: true, viewport: { width: screen.width, height: screen.height } });
    await iosKeyboard(page);
    await page.getByTitle("New Chat").first().click();
    const input = page.getByPlaceholder("Message…");
    await input.focus();
    // Under 16px, iOS zooms into the field on focus and the page stays zoomed: the panes' fields are 16px on a touch screen.
    expect(await input.evaluate((field) => parseFloat(getComputedStyle(field).fontSize))).toBeGreaterThanOrEqual(16);
    await keyboard(page, screen.keyboard);
    await within(input, screen.height - screen.keyboard);
    await within(page.getByTestId("chat-options"), screen.height - screen.keyboard);
    await keyboard(page, 0);
    await expect.poll(async () => { const box = (await input.boundingBox())!; return box.y + box.height > screen.height - screen.keyboard; }).toBe(true);

    // A hardware keyboard: iOS shows only its shortcut bar (66-68px in the Simulator), too short to be taken for a
    // keyboard, and it covered the message field. While a field has the focus, it counts.
    await keyboard(page, screen.bar);
    await within(input, screen.height - screen.bar);
    await keyboard(page, 0);
    await input.blur();
    // With nothing focused, a gap that small is a toolbar sliding away: the panes keep the screen's height.
    await keyboard(page, screen.bar);
    await expect.poll(async () => { const box = (await input.boundingBox())!; return box.y + box.height > screen.height - screen.bar; }).toBe(true);
  });
}

test("an iPhone with a hardware keyboard: the message field stays above the shortcut bar when the phone turns", { tag: ["@feature:app.mobile-layout", "@feature:app.responsive"] }, async ({ peer }) => {
  // Turned with the bar up, iOS reports the whole screen again a moment later and keeps it while the bar stays over
  // the field (iOS 26 Simulator, installed app: 402 of 402 on its side with the bar showing; r6c saw "68px short").
  const BAR = 68;
  const { page } = await peer("turning", { mobile: true, viewport: { width: 402, height: 874 } });
  await iosKeyboard(page);
  await page.getByTitle("New Chat").first().click();
  const input = page.getByPlaceholder("Message…");
  await input.focus();
  await keyboard(page, BAR);
  await within(input, 874 - BAR);

  await page.setViewportSize({ width: 874, height: 402 });
  await keyboard(page, 0);
  await within(input, 402 - BAR);
  await page.setViewportSize({ width: 402, height: 874 });
  await within(input, 874 - BAR);

  // Done: the field loses the focus and the bar goes.
  await input.blur();
  await expect.poll(async () => { const box = (await input.boundingBox())!; return box.y + box.height > 874 - BAR; }).toBe(true);
});

test("on an iPhone: a message's quick bar opened while typing puts the keyboard down", { tag: ["@feature:app.mobile-layout", "@feature:chat.reactions", "@feature:app.menus"] }, async ({ peer }) => {
  const { page } = await peer("hold-typing", { mobile: true, viewport: PHONE });
  await iosKeyboard(page);
  // iOS moves no focus to a button from a timer (the long press): the quick bar's first reaction took none, and the
  // message field kept it, the keyboard up over the bar's rows and the keys going into the field behind it (iOS 26
  // Simulator). Chromium would move it, so the page plays iOS here.
  await page.evaluate(() => { HTMLButtonElement.prototype.focus = () => {}; });
  await page.getByTitle("New Chat").first().click();
  const input = page.getByPlaceholder("Message…");
  await input.fill("hold me while typing");
  await input.press("Enter");
  await expect(input).toBeFocused();
  await keyboard(page, KEYBOARD);

  const row = page.locator(".chat-wallpaper [data-message-row]").filter({ hasText: "hold me while typing" }).last();
  const box = (await row.boundingBox())!;
  const at = { pointerType: "touch", button: 0, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, bubbles: true };
  await row.dispatchEvent("pointerdown", at);
  await page.waitForTimeout(700);
  await row.dispatchEvent("pointerup", at);
  await expect(page.getByTestId("reaction-bar")).toBeVisible();
  await expect(input).not.toBeFocused();
});

test("an iPhone on its side with the keyboard up: the floating card is never over the field it is about", { tag: ["@feature:app.mobile-layout", "@feature:settings.lock.password"] }, async ({ peer }) => {
  // About 200px are left above the keyboard: the card at the page's bottom covered the refocused password field and
  // the error line under it (r9e, iPhone Air Simulator).
  const SIDE = { width: 874, height: 402 }, KEYS = 200;
  const { page } = await peer("lock-side", { mobile: true, viewport: SIDE });
  await iosKeyboard(page);
  await page.goto("/#/settings/privacy");
  await page.getByRole("switch", { name: "Lock Screen" }).click();
  const field = page.getByTestId("settings-password-new");
  await field.fill("boo");
  await page.getByTestId("settings-password-confirm").fill("boo");
  await field.focus();
  await keyboard(page, KEYS);
  await page.getByRole("button", { name: "Set password" }).click();
  const card = page.getByTestId("settings-notice");
  await expect(card).toContainText("Password not set");
  await expect(field).toBeFocused();
  const error = page.getByTestId("settings-password-new-error");
  await expect(error).toBeVisible();

  const clear = async (visible: number) => {
    const [c, f, e] = await Promise.all([card, field, error].map((at) => at.boundingBox({ timeout: 500 }).catch(() => null)));
    if (!c || !f || !e) return "not drawn";
    const over = (b: typeof c) => c.x < b.x + b.width && b.x < c.x + c.width && c.y < b.y + b.height && b.y < c.y + c.height;
    if (over(f)) return "over the field";
    if (over(e)) return "over its error";
    if (c.y < 0 || c.y + c.height > visible + 1) return "out of the visible area";
    return "clear";
  };
  // Within the card's five seconds.
  await expect.poll(() => clear(SIDE.height - KEYS), { timeout: 4_000 }).toBe("clear");
  // With the keyboard down, refused again: a new card, clear of the field too.
  await keyboard(page, 0);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(field).toBeFocused();
  await expect.poll(() => clear(SIDE.height), { timeout: 4_000 }).toBe("clear");
});
