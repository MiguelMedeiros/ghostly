import { expect, test, type Page } from "@playwright/test";

/**
 * The WISP pages show dozens of WISP links (the map's tiles, the reader's panel, a WISP's related ones). Each one loads
 * its page when the reader is about to open it (pointer, focus, touch), not as it scrolls into view: before, /wisps
 * prefetched 50 pages (738 KB, 61% of what it loaded) and a WISP page 36.
 */
function prefetches(page: Page): Set<string> {
  const seen = new Set<string>();
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.searchParams.has("_rsc")) seen.add(url.pathname);
  });
  return seen;
}

/** At most the main nav's few links, never a WISP's page. */
const wispPages = (seen: Set<string>) => [...seen].filter((p) => p.startsWith("/wisps/"));

test("/wisps loads no WISP page until the reader points at its tile", async ({ page }) => {
  const seen = prefetches(page);
  await page.goto("/wisps");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  expect(wispPages(seen)).toEqual([]);
  expect(seen.size).toBeLessThanOrEqual(8);

  const tile = page.locator(".wmap-tile[href='/wisps/01-ghost-core']");
  await tile.hover();
  await expect.poll(() => seen.has("/wisps/01-ghost-core")).toBe(true);
  expect(wispPages(seen)).toEqual(["/wisps/01-ghost-core"]);
  await tile.click();
  await expect(page).toHaveURL(/\/wisps\/01-ghost-core$/);
});

test("a WISP page loads no other WISP page until the reader points at or focuses its link", async ({ page }) => {
  const seen = prefetches(page);
  await page.goto("/wisps/06-devices");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  // The pager's previous and next stay prefetched: the one or two pages a reader opens next.
  const pager = await page.locator(".reader-pager-prev, .reader-pager-next").evaluateAll((links) => links.map((a) => a.getAttribute("href")));
  expect(wispPages(seen).filter((p) => !pager.includes(p))).toEqual([]);

  const link = page.locator(".reader-group-panel a[href^='/wisps/']:not([aria-current])").first();
  const href = (await link.getAttribute("href"))!;
  await link.focus();
  await expect.poll(() => seen.has(href)).toBe(true);
});
