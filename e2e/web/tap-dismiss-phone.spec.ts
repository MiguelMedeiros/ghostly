import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * On a phone, a tap on the dimmed area around a dialog or a menu sheet only closes it. The surface closes on the
 * tap's pointerup, and the click the touch screen sends right after landed on what was under it: New Chat made a
 * chat, the Wallets tab went to the wallets, the chat's Back went to the list.
 */

/** Counts the clicks the page gets, before the app sees them: the one a tap leaves behind is counted too. */
async function countClicks(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as unknown as { __clicks?: number };
    if (w.__clicks === undefined) window.addEventListener("click", () => { w.__clicks!++; }, { capture: true });
    w.__clicks = 0;
  });
  return () => page.evaluate(() => (window as unknown as { __clicks: number }).__clicks);
}

/** Taps the screen where `under` is, over whatever covers it, and waits for the click that tap sends. */
async function tapOver(page: Page, under: Locator): Promise<void> {
  const box = (await under.boundingBox())!;
  const clicks = await countClicks(page);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(clicks).toBe(1);
}

const hash = (page: Page) => page.evaluate(() => location.hash);

test("on a phone a tap outside a dialog or a menu sheet closes it and presses nothing under it", { tag: ["@feature:app.mobile-layout", "@feature:app.menus", "@feature:groups.create"] }, async ({ peer }) => {
  const { page } = await peer("tapper", { mobile: true });
  const newChat = page.getByTitle("New Chat");
  await expect(newChat).toBeVisible();
  const home = await hash(page);

  // A dialog (New group), over the Wallets tab.
  await page.getByTestId("sidebar-new-more").tap();
  await page.getByTestId("new-group").tap();
  const dialog = page.getByTestId("new-group-dialog");
  await expect(dialog).toBeVisible();
  const wallets = page.getByTestId("mobile-tab-wallet");
  await tapOver(page, wallets);
  await expect(dialog).toHaveCount(0);
  expect(await hash(page)).toBe(home);
  await expect(wallets).not.toBeFocused();

  // A menu drawn as a sheet (New ▾), over New Chat.
  await page.getByTestId("sidebar-new-more").tap();
  const newMenu = page.getByTestId("sidebar-new-menu");
  await expect(newMenu).toHaveAttribute("data-menu", "sheet");
  await tapOver(page, newChat);
  await expect(newMenu).toHaveCount(0);
  expect(await hash(page)).toBe(home);

  // The chat's ⋮ as a sheet, over the chat's Back button.
  await newChat.tap();
  await expect(page.getByTestId("chat-back")).toBeVisible();
  const chat = await hash(page);
  expect(chat).not.toBe(home);
  await page.getByTestId("chat-options").tap();
  const chatMenu = page.getByTestId("chat-options-menu");
  await expect(chatMenu).toHaveAttribute("data-menu", "sheet");
  await tapOver(page, page.getByTestId("chat-back"));
  await expect(chatMenu).toHaveCount(0);
  expect(await hash(page)).toBe(chat);
  await expect(page.getByTestId("chat-back")).toBeVisible();

  // The next tap is the person's own.
  await page.getByTestId("chat-back").tap();
  await expect(newChat).toBeVisible();
});
