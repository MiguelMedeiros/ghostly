import { expect, test, type Page } from "@playwright/test";

/**
 * /developers links to WISP pages from the explainer's "WISP nn" chips (eight step cards drawn on top of each other, so
 * every card's chips are on screen at once) and from the path list further down. Each one loads its page when the reader
 * is about to open it (pointer, focus, touch), not as it scrolls into view: before, the page fetched 15 WISP pages
 * (1,144 KB, 35% of what it loaded). The hero's button stays prefetched: the page a reader opens next.
 */
function prefetches(page: Page): Set<string> {
  const seen = new Set<string>();
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.searchParams.has("_rsc")) seen.add(url.pathname);
  });
  return seen;
}

const wispPages = (seen: Set<string>) => [...seen].filter((p) => p.startsWith("/wisps/")).sort();
const HERO = "/wisps/01-ghost-core";

test("/developers loads no WISP page but the hero button's until the reader points at or focuses its link", async ({ page }) => {
  const seen = prefetches(page);
  await page.goto("/developers");
  await page.waitForLoadState("networkidle");
  // The whole page, as a reader who scrolls to its end.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 450) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y);
    await page.waitForTimeout(100);
  }
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  expect(wispPages(seen)).toEqual([HERO]);

  const chip = page.locator(".psx-card[data-state='current'] .psx-wisp[href='/wisps/03-capabilities']");
  await chip.scrollIntoViewIfNeeded();
  await chip.hover();
  await expect.poll(() => seen.has("/wisps/03-capabilities")).toBe(true);

  const link = page.locator(".dvx-step-links a[href='/wisps/protocol']");
  await link.focus();
  await expect.poll(() => seen.has("/wisps/protocol")).toBe(true);
  expect(wispPages(seen)).toEqual([HERO, "/wisps/03-capabilities", "/wisps/protocol"].sort());

  await link.click();
  await expect(page).toHaveURL(/\/wisps\/protocol$/);
});
