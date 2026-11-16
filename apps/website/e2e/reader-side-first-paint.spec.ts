import { expect, test, type Page } from "@playwright/test";

/**
 * On a phone a draft's list of WISPs goes under the article. It came first in the HTML: with the stylesheet cached the
 * browser could paint while the article was still arriving, the list alone at the top, then jumping off the screen when
 * the article came (a layout shift of 0.5 to 0.75 on a slow connection), and Tab went down to the list before the
 * article. The list now comes after the article in the HTML, and the grid puts it beside the article on a wide screen.
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

  // Tab follows what the eye reads: from the breadcrumb into the article, not first down to the list under it.
  test("Tab goes from the breadcrumb into the article, and to the list of WISPs after it", async ({ page }) => {
    await page.goto(DRAFT);
    await page.locator(".reader-crumbs a").last().focus();
    await page.keyboard.press("Tab");
    await expect(page.locator(".reader-main :focus")).toHaveCount(1);
    await page.locator(".reader-foot a").last().focus();
    await page.keyboard.press("Tab");
    await expect(page.locator(".reader-side :focus")).toHaveCount(1);
  });
});

test.describe("on a wide screen", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the list of WISPs is beside the article, and Tab reaches it first, as the eye does", async ({ page }) => {
    await page.goto(DRAFT);
    const [side, main] = await Promise.all([page.locator(".reader-side").boundingBox(), page.locator(".reader-main").boundingBox()]);
    expect(side!.x + side!.width).toBeLessThanOrEqual(main!.x);
    expect(side!.y).toBeLessThan(main!.y + 50);
    await page.locator(".reader-crumbs a").last().focus();
    await page.keyboard.press("Tab");
    await expect(page.locator(".reader-side :focus")).toHaveCount(1);
  });
});
