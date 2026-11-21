import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { APP_URL, STORE_URL, serveStore, testStore } from "../support/appStore";

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

  test(`on a phone in ${language}, the install screen and the app's screen break a reason with no space, and never scroll sideways`, { tag: ["@feature:apps.page", "@feature:app.mobile-layout"] }, async ({ peer }) => {
    // A reason is one line of up to 200 characters and may hold no space (a link): unbroken, both screens scrolled 933 px
    // sideways at 320 px, and in Arabic the reason's start was drawn far off the screen's left side.
    const reason = `See https://example.org/advisories/${"a".repeat(160)}`;
    const store = await testStore({ removed: reason });
    const ana = await peer("ana", { mobile: true, viewport: PHONE });
    await serveStore(ana.context, store);
    await ana.page.goto("/#/apps");
    await useLanguage(ana.page, language);
    const sideways = (screen: string, line: string) => ana.page.getByTestId(screen).evaluate((el, line) => {
      const range = document.createRange();
      range.selectNodeContents(el.querySelector(`[data-testid="${line}"]`)!);
      const text = range.getBoundingClientRect(), box = el.getBoundingClientRect();
      return { screen: el.scrollWidth - el.clientWidth, page: document.documentElement.scrollWidth - innerWidth, inside: text.left >= box.left && text.right <= box.right };
    }, line);
    // Installed first, then the store that took it down is added: the app's screen says why it stays stopped.
    await ana.page.getByTestId("apps-add").click();
    await ana.page.getByTestId("apps-add-url").fill(APP_URL);
    await ana.page.getByTestId("apps-add-check").click();
    await ana.page.getByTestId("app-install").getByTestId("app-install-confirm").click();
    await expect(ana.page.getByTestId("app-install")).toHaveCount(0);
    await ana.page.getByTestId("apps-add").click();
    await ana.page.getByTestId("apps-add-url").fill(STORE_URL);
    await ana.page.getByTestId("apps-add-check").click();
    await ana.page.getByTestId("apps-add-store-confirm").click();
    await ana.page.getByTestId("installed-app").getByRole("button").first().click();
    await expect(ana.page.getByTestId("app-run-line")).toContainText(store.storeName);
    expect(await sideways("app-details", "app-run-line")).toEqual({ screen: 0, page: 0, inside: true });
    // Uninstalled, its link again: the install screen says why it cannot be installed.
    await ana.page.getByTestId("app-uninstall-open").click();
    await ana.page.getByTestId("app-uninstall-confirm").click();
    await expect(ana.page.getByTestId("app-details")).toHaveCount(0);
    await ana.page.getByTestId("apps-add").click();
    await ana.page.getByTestId("apps-add-url").fill(APP_URL);
    await ana.page.getByTestId("apps-add-check").click();
    await expect(ana.page.getByTestId("app-install-blocked")).toContainText(store.storeName);
    expect(await sideways("app-install", "app-install-blocked")).toEqual({ screen: 0, page: 0, inside: true });
  });
}
