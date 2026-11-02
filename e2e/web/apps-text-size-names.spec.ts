import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { STORE_URL, serveStore, testStore } from "../support/appStore";

/*
 * The rows that put an app's name beside a button, at the browser's largest text size a person may need (200 %,
 * WCAG 1.4.4) on a 375 px phone: the button goes under the name rather than taking its place. Unwrapped, a chat's
 * + → Apps showed "Chess" in 9 of the 79 px it needs, and the store's listing showed "C." beside Install.
 */
const PHONE = { width: 375, height: 812 };

/** The browser's default text size, as its settings set it (rem follows it). */
async function textSize(page: Page, px: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: px, fixed: Math.round(px * 13 / 16) } });
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(px);
}

/** The row's line with this text shows it whole: as wide as it needs, not cut. */
async function expectWhole(row: Locator, text: string, what: string): Promise<void> {
  const line = row.getByText(text, { exact: true });
  await line.scrollIntoViewIfNeeded();
  const { shown, needs } = await line.evaluate((el) => ({ shown: el.clientWidth, needs: el.scrollWidth }));
  expect.soft(shown, `${what}: ${text} shown in ${shown} of ${needs} px`).toBeGreaterThanOrEqual(needs);
}

test("on a phone at a doubled text size, an app's name shows whole beside its Install or Open", { tag: ["@feature:apps.page", "@feature:apps.chat.card", "@feature:app.accessibility"] }, async ({ peer }) => {
  const store = await testStore();
  const [ana, bob] = await Promise.all([peer("ana"), peer("bob")]);
  await serveStore(ana.context, store);
  await pair(ana, bob);

  const page = ana.page;
  await page.setViewportSize(PHONE);
  await textSize(page, 32);

  // Apps → Add with the store's link: its listing, beside Install.
  await page.goto("/#/apps");
  await page.getByTestId("apps-add").click();
  await page.getByTestId("apps-add-url").fill(STORE_URL);
  await page.getByTestId("apps-add-check").click();
  await page.getByTestId("apps-add-store-confirm").click();
  const listing = page.getByTestId("app-store").filter({ hasText: store.storeName }).getByTestId("app-listing");
  await expect(listing.getByTestId("app-listing-install")).toBeVisible();
  await expectWhole(listing, store.title, "listing");

  // Installed: its row, beside Open, and the listing beside "Installed".
  await listing.getByTestId("app-listing-install").click();
  await page.getByTestId("app-install").getByTestId("app-install-confirm").click();
  const installed = page.getByTestId("installed-app");
  await expect(installed.getByTestId("installed-app-open")).toBeVisible();
  await expectWhole(installed, store.title, "installed row");
  await expectWhole(listing, store.title, "listing, installed");

  // A chat's + → Apps: the app's row, beside Open.
  await page.goto("/#/");
  await page.getByTestId("chat-row").first().click();
  await (await composerRow(page, "composer-apps")).click();
  const row = page.getByTestId("chat-apps").getByTestId("chat-app");
  await expect(row.getByTestId("chat-app-open")).toBeVisible();
  await expectWhole(row, store.title, "chat's apps");
});
