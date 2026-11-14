import type { Locator, Page } from "@playwright/test";
import { chat, expect, test } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { STORE_URL, serveStore, testStore } from "../support/appStore";

/*
 * An app's version beside its title, as long as a publisher may write it (a pre-release with build data, 29 characters
 * here; a bundle allows 64) on a 375 px phone: the title shows whole and the version is the one cut, at its end. Uncut,
 * the version took the title's place: "Chess" shown in 2 of its 45 px in the installed row, "C…" on the app cards.
 */
const PHONE = { width: 375, height: 812 };
const VERSION = "1.2.0-beta.3+20261106.a1b2c3d";

async function useLanguage(page: Page, language: string): Promise<void> {
  await page.evaluate((language) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
  }, language);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
}

/** In `row`, the title shows whole, and the version's first character shows inside the row, its line cut at its end. */
async function expectTitleWhole(row: Locator, title: string, what: string): Promise<void> {
  await row.scrollIntoViewIfNeeded();
  const titleLine = row.getByText(title, { exact: true });
  const { shown, needs } = await titleLine.evaluate((el) => ({ shown: el.clientWidth, needs: el.scrollWidth }));
  expect.soft(shown, `${what}: ${title} shown in ${shown} of ${needs} px`).toBeGreaterThanOrEqual(needs);
  const version = await row.getByText(VERSION, { exact: true }).evaluate((element, rowElement) => {
    const range = document.createRange();
    range.setStart(element.firstChild!, 0);
    range.setEnd(element.firstChild!, 1);
    const first = range.getBoundingClientRect(), box = element.getBoundingClientRect(), outer = (rowElement as HTMLElement).getBoundingClientRect();
    return { firstShows: first.left >= box.left - 1 && first.right <= box.right + 1, insideRow: box.left >= outer.left - 1 && box.right <= outer.right + 1 };
  }, await row.elementHandle());
  expect.soft(version, `${what}: the version`).toEqual({ firstShows: true, insideRow: true });
}

for (const language of ["en", "ar"]) {
  test(`${language}: a long version is cut beside an app's title, never the title`, { tag: ["@feature:apps.page", "@feature:apps.chat.card"] }, async ({ peer }) => {
    const title = "Chess";
    const store = await testStore({ version: VERSION });
    const [ana, bob] = await Promise.all([peer("ana"), peer("bob")]);
    await serveStore(ana.context, store);
    await serveStore(bob.context, store);
    const page = ana.page;
    await page.getByTestId("account-apps").click();
    await page.getByTestId("apps-add").click();
    await page.getByTestId("apps-add-url").fill(STORE_URL);
    await page.getByTestId("apps-add-check").click();
    await page.getByTestId("apps-add-store-confirm").click();
    await page.getByTestId("app-store").filter({ hasText: store.storeName }).getByTestId("app-listing-install").click();
    await page.getByTestId("app-install").getByTestId("app-install-confirm").click();
    await expect(page.getByTestId("installed-app")).toContainText(VERSION);
    await page.goto("/#/");
    await pair(ana, bob);
    await (await composerRow(page, "composer-apps")).click();
    await page.getByTestId("chat-apps").getByTestId("chat-app-open").click();
    const app = page.getByTestId("mini-app");
    await expect(app).toBeVisible();
    await app.getByRole("button", { name: "Close" }).click();
    await expect(app).toBeHidden();
    const anaChat = page.url();
    const theirs = chat(bob).getByTestId("app-card");
    await expect(theirs.getByTestId("app-card-install")).toBeVisible();
    const bobChat = bob.page.url();

    await page.setViewportSize(PHONE);
    await useLanguage(page, language);
    // Ana's own card, for the app she has: its installed version.
    await page.goto(anaChat);
    const mine = chat(ana).getByTestId("app-card");
    await expect(mine.getByTestId("app-card-open")).toBeVisible();
    await expectTitleWhole(mine.getByTestId("app-card-title"), title, "my card");
    // The installed app's row on the Apps page.
    await page.goto("/#/apps");
    await expectTitleWhole(page.getByTestId("installed-app"), title, "installed row");

    // Bob's card, from what Ana's says: the same version.
    const other = bob.page;
    await other.setViewportSize(PHONE);
    await useLanguage(other, language);
    await other.goto(bobChat);
    await expect(theirs.getByTestId("app-card-install")).toBeVisible();
    await expectTitleWhole(theirs.getByTestId("app-card-title"), title, "contact's card");
  });
}
