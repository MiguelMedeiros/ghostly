import { expect, test, type Page } from "@playwright/test";

/**
 * On a phone a draft's list of WISPs goes under the article, but it comes first in the HTML. With the stylesheet cached
 * the browser can paint while the article is still arriving: the list was then alone at the top, and jumped off the
 * screen when the article came (a layout shift of 0.5 to 0.75 on a slow connection). The list waits for the article's end.
 */

const DRAFT = "/wisps/301-nostr";

/** The page as the browser holds it while the HTML is still arriving: cut inside the article, and no scripts. */
async function openCut(page: Page, cut: string) {
  await page.route("**/*.js", (route) => route.abort());
  await page.route(DRAFT, async (route) => {
    const res = await route.fetch();
    const html = await res.text();
    const at = html.indexOf(cut);
    expect(at).toBeGreaterThan(0);
    await route.fulfill({ response: res, body: html.slice(0, at) });
  });
  await page.goto(DRAFT);
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const [where, cut] of [
    ["before the article starts", '<article class="reader-main"'],
    ["inside the article", '<div class="reader-prose"'],
  ]) {
    test(`the list of WISPs is not laid out ${where}`, async ({ page }) => {
      await openCut(page, cut);
      await expect(page.locator(".reader-crumbs")).toBeVisible();
      await expect(page.locator(".reader-side")).toBeHidden();
    });
  }

  test("the list of WISPs is under the whole article once the page is there", async ({ page }) => {
    await page.goto(DRAFT);
    await expect(page.locator(".reader-side")).toBeVisible();
    const [side, foot] = await Promise.all([page.locator(".reader-side").boundingBox(), page.locator(".reader-foot").boundingBox()]);
    expect(side!.y).toBeGreaterThanOrEqual(foot!.y + foot!.height);
  });
});

test("on a wide screen the list of WISPs is beside the article as soon as it is there", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openCut(page, '<article class="reader-main"');
  await expect(page.locator(".reader-side")).toBeVisible();
});
