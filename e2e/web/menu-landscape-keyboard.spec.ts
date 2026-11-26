import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { iosKeyboard, keyboard } from "../support/keyboard";

/**
 * A menu opened while typing on a phone on its side (844 by 390: two panes, so a menu is a popover, not a sheet).
 * iOS keeps the page's height under the keyboard and moves no focus to a button from a tap, so the message field kept
 * the focus and the keyboard stayed up: the composer's + menu opened downwards, all four rows under the keyboard, and
 * the chat's ⋮ menu had its last rows there. Held upright a menu is a sheet and already put the keyboard down.
 */
const SIDE = { width: 844, height: 390 };
const KEYBOARD = 240;
const INSETS = { left: 47, right: 47, top: 0, bottom: 21 };

/**
 * Each row of the menu, scrolled to where the menu is taller than its room (the chat's ⋮ on a screen 390px high): on
 * what the keyboard leaves of the screen, and taking a tap at its centre.
 */
const rowsOf = (menu: Locator) => menu.locator("[data-menu-item]").evaluateAll((rows) => rows.map((row) => {
  row.scrollIntoView({ block: "nearest" });
  const box = row.getBoundingClientRect();
  const visible = window.visualViewport?.height ?? window.innerHeight;
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return box.top >= -1 && box.bottom <= visible + 1 && !!hit && row.contains(hit) ? "in view" : `${Math.round(box.top)}..${Math.round(box.bottom)} of 0..${Math.round(visible)}`;
}));

async function typing(page: Page) {
  const field = page.locator(".composer-textarea");
  await field.focus();
  await keyboard(page, KEYBOARD);
  await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");
  return field;
}

test("a phone on its side: a menu opened while typing puts the keyboard down and shows every row", { tag: ["@feature:app.mobile-layout", "@feature:app.menus", "@feature:app.composer.attach"] }, async ({ peer }) => {
  const { page } = await peer("menu-side", { mobile: true, viewport: SIDE });
  // The page plays iOS: a tap on a button, and a button focused from its handler, take no focus from the field.
  await page.context().addInitScript(() => {
    document.addEventListener("mousedown", (event) => { if ((event.target as Element).closest?.("button")) event.preventDefault(); }, true);
    HTMLButtonElement.prototype.focus = () => {};
  });
  await iosKeyboard(page);
  await (await page.context().newCDPSession(page)).send("Emulation.setSafeAreaInsetsOverride", { insets: INSETS });
  await page.getByTestId("sidebar-new-chat").first().click();

  for (const [opener, id] of [["composer-more", "composer-menu"], ["chat-options", "chat-options-menu"]] as const) {
    const field = await typing(page);
    await page.getByTestId(opener).click();
    const menu = page.getByTestId(id);
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("data-menu", "popover");
    // The field gives the focus up, so iOS takes the keyboard down.
    await expect(field, `${opener}: the message field keeps no focus`).not.toBeFocused();
    await keyboard(page, 0);
    await expect(page.locator("html")).toHaveAttribute("data-keyboard", "false");
    // The composer is back at the bottom of the screen: the menu follows its button and every row is in reach.
    await expect.poll(async () => (await rowsOf(menu)).filter((row) => row !== "in view"), `${opener}: every row on the screen`).toEqual([]);
    await test.info().attach(`${opener} opened while typing`, { body: await page.screenshot({ animations: "disabled" }), contentType: "image/png" });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
});
