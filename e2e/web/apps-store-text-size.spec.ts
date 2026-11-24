import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { STORE_URL, serveStore, testStore } from "../support/appStore";

/*
 * The Apps page's stores on a phone at the browser's doubled text size (Chrome's Settings → Font size): a store's
 * Refresh (or Read) and Remove sat in a box that did not wrap, so Remove ran past the screen's end and the page
 * scrolled sideways.
 */
const PHONE = { width: 375, height: 812 };

/** The browser's default text size, as its settings set it (rem follows it). */
async function textSize(page: Page, px: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: px, fixed: Math.round(px * 13 / 16) } });
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(px);
}

test("on a phone at a doubled text size, each store's Refresh and Remove are on the screen and the page does not scroll sideways", { tag: ["@feature:apps.page", "@feature:app.accessibility", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const store = await testStore();
  const ana = await peer("ana", { mobile: true, viewport: PHONE });
  await serveStore(ana.context, store);
  await ana.page.goto("/#/apps");
  await ana.page.getByTestId("apps-add").click();
  await ana.page.getByTestId("apps-add-url").fill(STORE_URL);
  await ana.page.getByTestId("apps-add-check").click();
  await ana.page.getByTestId("apps-add-store-confirm").click();
  await expect(ana.page.getByTestId("app-store").filter({ hasText: store.storeName }).getByTestId("app-store-refresh")).toHaveText("Refresh");

  await textSize(ana.page, 32);
  const stores = ana.page.getByTestId("app-store");
  expect(await stores.count()).toBeGreaterThanOrEqual(1);
  // Their sides, read before anything scrolls (a scroll into view of Remove moved the whole page left).
  for (const block of await stores.all()) {
    const name = await block.getAttribute("data-key");
    for (const id of ["app-store-refresh", "app-store-remove"]) {
      const { left, right } = await block.getByTestId(id).evaluate((button) => button.getBoundingClientRect());
      expect.soft(left, `${name} ${id} starts on the screen`).toBeGreaterThanOrEqual(0);
      expect.soft(right, `${name} ${id} ends on the screen`).toBeLessThanOrEqual(PHONE.width);
    }
  }
  // Nothing on the page can scroll sideways: not the document, not the page's own scrolling column.
  const sideways = () => ana.page.evaluate(() => [document.documentElement, ...document.querySelectorAll<HTMLElement>("body *")]
    .filter((el) => el.scrollLeft !== 0 || (el.scrollWidth > el.clientWidth + 1 && (el === document.documentElement || /auto|scroll/.test(getComputedStyle(el).overflowX))))
    .map((el) => el.dataset.testid ?? el.className.toString().slice(0, 60)));
  expect(await sideways()).toEqual([]);
  await stores.last().getByTestId("app-store-remove").scrollIntoViewIfNeeded();
  expect(await sideways()).toEqual([]);

  // Remove asks first: the question in place of the buttons fits the screen too, and Cancel keeps the store.
  const added = stores.filter({ hasText: store.storeName });
  await added.getByTestId("app-store-remove").click();
  const question = added.getByTestId("app-store-remove-question");
  await expect(question).toContainText(store.storeName);
  for (const button of await question.getByRole("button").all()) {
    const { left, right } = await button.evaluate((el) => el.getBoundingClientRect());
    expect.soft(left, `${await button.textContent()} starts on the screen`).toBeGreaterThanOrEqual(0);
    expect.soft(right, `${await button.textContent()} ends on the screen`).toBeLessThanOrEqual(PHONE.width);
  }
  expect(await sideways()).toEqual([]);
  await question.getByRole("button", { name: "Cancel" }).click();
  await expect(added.getByTestId("app-store-remove")).toBeFocused();
});

test("on a phone, a store's name, an installed app's row, the store's search and Show more each take a tap in 44 px", { tag: ["@feature:apps.page", "@feature:app.accessibility", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  // A store long enough for its search and Show more (over 50 listings), and one app of it installed.
  const store = await testStore({ more: 60 });
  const ana = await peer("ana", { mobile: true, viewport: PHONE });
  await serveStore(ana.context, store);
  await ana.page.goto("/#/apps");
  await ana.page.getByTestId("apps-add").click();
  await ana.page.getByTestId("apps-add-url").fill(STORE_URL);
  await ana.page.getByTestId("apps-add-check").click();
  await ana.page.getByTestId("apps-add-store-confirm").click();
  const added = ana.page.getByTestId("app-store").filter({ hasText: store.storeName });
  const name = added.getByRole("button", { name: new RegExp(`^${store.storeName}`) });
  // Beside the official store, a store this long starts closed.
  await name.click();
  await expect(name).toHaveAttribute("aria-expanded", "true");
  await added.getByTestId("app-listing").filter({ hasText: store.title }).getByTestId("app-listing-install").click();
  await ana.page.getByTestId("app-install").getByTestId("app-install-confirm").click();
  await expect(ana.page.getByTestId("installed-app")).toContainText(store.title);

  const targets = {
    "the store's name": name,
    "the installed app's row": ana.page.getByTestId("installed-app").getByRole("button", { name: new RegExp(store.title) }).first(),
    "the store's search": added.getByTestId("app-store-filter"),
    "Show more": added.getByTestId("app-store-more"),
  };
  for (const [name, target] of Object.entries(targets)) {
    const { width, height } = (await target.boundingBox())!;
    expect.soft(Math.round(height), `${name} is 44 px tall`).toBeGreaterThanOrEqual(44);
    expect.soft(Math.round(width), `${name} is 44 px wide`).toBeGreaterThanOrEqual(44);
  }
});
