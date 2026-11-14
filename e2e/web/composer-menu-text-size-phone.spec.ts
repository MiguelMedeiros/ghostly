import type { Page } from "@playwright/test";
import { connect, expect, link, test } from "../support/fixtures";

/**
 * The composer's + sheet on a 375px phone at 200% of the browser's text size. The menu's floor was 13rem, 416px
 * there: the sheet and its rows ran past the screen's right edge, and a row's end (Payment's hint in Japanese) was
 * cut at the screen, not at the row. Its labels were 15px at any text size while the hint under Payment followed
 * the text size, and was larger than the word it explains.
 */
const PHONE = { width: 375, height: 667 };

/** The browser's default text size, as its settings set it (rem follows it). */
async function textSize(page: Page, px: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: px, fixed: Math.round(px * 13 / 16) } });
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(px);
}

async function useLanguage(page: Page, language: string): Promise<void> {
  await page.evaluate((language) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
  }, language);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  // Payment's hint (what the contact can take) is there only once the chat is live again.
  await expect(page.getByTestId("connection-options")).toHaveAttribute("data-state", "connected", { timeout: 90_000 });
}

test("on a 375px phone at 200% text size the composer's + sheet fits the screen, each hint no larger than its label", { tag: ["@feature:app.mobile-layout", "@feature:app.composer.attach"] }, async ({ peer }) => {
  const alice = await peer("alice");
  const bob = await peer("bob", { mobile: true, viewport: PHONE });
  await link(alice, bob);
  await connect(alice, bob);
  const page = bob.page;
  await textSize(page, 32);
  for (const language of ["en", "fr", "ja"]) {
    await useLanguage(page, language);
    await page.getByTestId("composer-more").click();
    const menu = page.getByTestId("composer-menu");
    await expect(menu).toHaveAttribute("data-menu", "sheet");
    await expect(menu.getByTestId("payment-button").locator("[data-menu-text]"), `${language}: Payment's hint`).toHaveCount(2);
    const sheet = (await menu.boundingBox())!;
    expect.soft(sheet.x + sheet.width, `${language} sheet`).toBeLessThanOrEqual(PHONE.width);
    const rows = await menu.locator("[data-menu-item]").evaluateAll((rows) => rows.map((row) => {
      const box = row.getBoundingClientRect();
      const [label, hint] = [...row.querySelectorAll("[data-menu-text]")].map((line) => parseFloat(getComputedStyle(line).fontSize));
      return { action: row.getAttribute("data-action"), left: box.left, right: box.right, label, hint };
    }));
    expect(rows.length, language).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      expect.soft(row.left, `${language} ${row.action}`).toBeGreaterThanOrEqual(0);
      expect.soft(row.right, `${language} ${row.action}`).toBeLessThanOrEqual(PHONE.width);
      if (row.hint !== undefined) expect.soft(row.hint, `${language} ${row.action}: hint against label ${row.label}px`).toBeLessThanOrEqual(row.label);
    }
    await page.getByTestId("menu-backdrop").click({ position: { x: 10, y: 10 } });
    await expect(menu).toHaveCount(0);
  }
});
