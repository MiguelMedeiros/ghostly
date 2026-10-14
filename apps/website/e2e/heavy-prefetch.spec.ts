import { expect, test, type Page } from "@playwright/test";

/**
 * The roadmap's page data is 310 KB (its whole inventory) and a WISP's up to 230 KB. Every page links the roadmap from
 * the nav and the footer, and several link WISPs ("read more", the roadmap's drafts and source): before, each page
 * prefetched the roadmap as it opened (over half of the 553 KB it prefetched), and /roadmap, /cli and /developers/agents
 * up to four WISP pages on top (356 KB). A link to one of them loads its page when the reader is about to open it (pointer,
 * focus, touch).
 */
function prefetches(page: Page): Set<string> {
  const seen = new Set<string>();
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.searchParams.has("_rsc")) seen.add(url.pathname);
  });
  return seen;
}

/** /developers keeps its hero button's page ready: the page a reader opens next (developers-prefetch.spec.ts). */
const KEPT: Record<string, string[]> = { "/developers": ["/wisps/01-ghost-core"] };

const heavy = (seen: Set<string>) => [...seen].filter((p) => p === "/roadmap" || p.startsWith("/wisps/"));

/** Brings every link of the page into view, the footer's included. */
async function readToTheEnd(page: Page) {
  await page.waitForLoadState("networkidle");
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 600) {
    await page.mouse.move(0, 0);
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(80);
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
}

for (const path of ["/", "/developers", "/cli", "/developers/agents", "/roadmap", "/wisps", "/terms"]) {
  test(`${path} loads neither the roadmap nor a WISP's page while it is read`, async ({ page }) => {
    const seen = prefetches(page);
    await page.goto(path);
    await readToTheEnd(page);
    expect(heavy(seen)).toEqual(KEPT[path] ?? []);
    // The light pages of the nav and the footer are still loaded ahead.
    expect(seen.has("/cli")).toBe(true);
  });
}

test("the nav's roadmap link loads the roadmap when the reader points at it, and opens it", async ({ page }) => {
  const seen = prefetches(page);
  await page.goto("/cli");
  await page.waitForLoadState("networkidle");
  const link = page.locator(".nav-links a[href='/roadmap']");
  await link.hover();
  await expect.poll(() => seen.has("/roadmap")).toBe(true);
  await link.click();
  await expect(page).toHaveURL(/\/roadmap$/);
  await expect(page.locator(".nav-links a[href='/roadmap']")).toHaveAttribute("aria-current", "page");
});

test("the footer's roadmap link loads the roadmap when it gets the focus", async ({ page }) => {
  const seen = prefetches(page);
  await page.goto("/terms");
  await page.waitForLoadState("networkidle");
  await page.locator("footer a[href='/roadmap']").focus();
  await expect.poll(() => seen.has("/roadmap")).toBe(true);
});
