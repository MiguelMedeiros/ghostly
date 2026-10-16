import { expect, test, type Page } from "@playwright/test";

/**
 * The roadmap's page data is 310 KB (its whole inventory) and a WISP's up to 230 KB. Every page links the roadmap from
 * the nav and the footer, and several link WISPs ("read more", the roadmap's drafts and source): before, each page
 * prefetched the roadmap as it opened (over half of the 553 KB it prefetched), and /roadmap, /cli and /developers/agents
 * up to four WISP pages on top (356 KB). /brand's is 219 KB, linked from every footer. A link to one of them loads its
 * page when the reader is about to open it (pointer, focus, touch).
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

const heavy = (seen: Set<string>) => [...seen].filter((p) => p === "/roadmap" || p === "/brand" || p.startsWith("/wisps/"));

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
  test(`${path} loads neither the roadmap, /brand nor a WISP's page while it is read`, async ({ page }) => {
    const seen = prefetches(page);
    await page.goto(path);
    await readToTheEnd(page);
    expect(heavy(seen)).toEqual(KEPT[path] ?? []);
  });
}

/**
 * The scripts of the pages the nav and the footer link to are large too: the home's alone is 41 KB on the wire (121 KB
 * decoded), and /developers, /developers/agents, /wisps and /cli add about as much. Before, a page that is only read
 * loaded them all as its nav, its footer and a WISP's breadcrumb came into view (about 110 KB, 150-300 ms of a phone's
 * main thread per page view). Every one of those links loads its page when the reader is about to open it.
 */
function scripts(page: Page): Set<string> {
  const seen = new Set<string>();
  page.on("request", (r) => {
    if (r.resourceType() === "script" && new URL(r.url()).pathname.startsWith("/_next/")) seen.add(new URL(r.url()).pathname);
  });
  return seen;
}

/** The nav's and the footer's pages, by their own paths. */
const SITE_PAGES = ["/", "/developers", "/developers/agents", "/wisps", "/cli", "/roadmap", "/brand", "/privacy", "/terms"];

for (const path of ["/privacy", "/terms", "/wisps/01-ghost-core"]) {
  test(`${path} loads no other page's scripts while it is read`, async ({ page }) => {
    const loaded = scripts(page);
    const seen = prefetches(page);
    const html = await (await page.goto(path))!.text();
    await readToTheEnd(page);
    // A script the page's own HTML does not name is another page's, loaded ahead by a link.
    expect([...loaded].filter((p) => !html.includes(p.split("/").pop()!))).toEqual([]);
    expect([...seen].filter((p) => SITE_PAGES.includes(p))).toEqual([]);
  });
}

test("the nav's CLI link loads its page when the reader points at it, and opens it", async ({ page }) => {
  const seen = prefetches(page);
  await page.goto("/privacy");
  await page.waitForLoadState("networkidle");
  const link = page.locator(".nav-links a[href='/cli']");
  await link.hover();
  await expect.poll(() => seen.has("/cli")).toBe(true);
  await link.click();
  await expect(page).toHaveURL(/\/cli$/);
});

test("the footer's home link loads the home when it gets the focus", async ({ page }) => {
  const seen = prefetches(page);
  await page.goto("/terms");
  await page.waitForLoadState("networkidle");
  await page.locator("footer a.brand").focus();
  await expect.poll(() => seen.has("/")).toBe(true);
});

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

test("the footer's brand link loads /brand when it gets the focus", async ({ page }) => {
  const seen = prefetches(page);
  await page.goto("/terms");
  await page.waitForLoadState("networkidle");
  await page.locator("footer a[href='/brand']").focus();
  await expect.poll(() => seen.has("/brand")).toBe(true);
});
