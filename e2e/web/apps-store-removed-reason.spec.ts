import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { STORE_URL, serveStore, testStore } from "../support/appStore";

/*
 * A store's listing of a version it took down says why, in full (WISP 1200 § Takedowns). The line was cut to one line
 * like a tagline: on a phone it read "Removed by E2E store: It sent the b…", the listing has nothing to open for the
 * rest, and in Arabic the part cut was the store's name and the reason's start.
 */
const PHONE = { width: 320, height: 640 };
const REASON = "It sent the board to a server it did not say it would talk to";

async function useLanguage(page: Page, language: string): Promise<void> {
  await page.evaluate((language) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
  }, language);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
}

for (const language of ["en", "ar"]) {
  test(`on a phone in ${language}, a removed listing shows its store's whole reason`, { tag: ["@feature:apps.page", "@feature:app.mobile-layout"] }, async ({ peer }) => {
    const store = await testStore({ removed: REASON });
    const ana = await peer("ana", { mobile: true, viewport: PHONE });
    await serveStore(ana.context, store);
    await ana.page.goto("/#/apps");
    await useLanguage(ana.page, language);
    await ana.page.getByTestId("apps-add").click();
    await ana.page.getByTestId("apps-add-url").fill(STORE_URL);
    await ana.page.getByTestId("apps-add-check").click();
    await ana.page.getByTestId("apps-add-store-confirm").click();

    const listing = ana.page.getByTestId("app-store").filter({ hasText: store.storeName }).getByTestId("app-listing");
    await expect(listing).toHaveCount(1);
    await expect(listing.getByTestId("app-listing-install")).toHaveCount(0);
    const line = listing.getByText(REASON);
    await expect(line).toContainText(store.storeName);
    await line.scrollIntoViewIfNeeded();
    // Every letter of it is drawn inside its box: nothing past its end, no ellipsis in the place of the rest.
    const drawn = await line.evaluate((element) => {
      const box = element.getBoundingClientRect(), range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      return { cut: element.scrollWidth > element.clientWidth, inside: text.left >= box.left - 1 && text.right <= box.right + 1, ellipsis: getComputedStyle(element).textOverflow === "ellipsis" };
    });
    expect(drawn).toEqual({ cut: false, inside: true, ellipsis: false });
  });
}
