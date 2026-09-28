import { expect, test } from "@playwright/test";

/**
 * /developers/wisps is the WISPs' main page: the searchable catalog. Its old address,
 * /developers/catalog, redirects there for good, so links out there still land.
 */
test("/developers/wisps is the WISP catalog", async ({ page }) => {
  await page.goto("/developers/wisps");
  await expect(page).toHaveTitle(/^WISPs \|/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Every contract, in one place.");
  await expect(page.getByRole("searchbox", { name: "Search the WISPs" })).toBeVisible();
  await expect(page.locator(".catalog-row a[href='/developers/wisps/01-ghost-core']").first()).toBeAttached();
  await expect(page.locator("#glossary")).toBeAttached();
  // The nav marks it as the current section.
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "WISPs" })).toHaveAttribute("aria-current", "page");
});

test("the map stacks the families as layers, the core at the bottom", async ({ page }) => {
  await page.goto("/developers/wisps");
  const layers = page.locator(".wmap-layer");
  await expect(layers.first().locator(".wmap-layer-label")).toHaveText("Programs");
  await expect(layers.last().locator(".wmap-layer-label")).toHaveText("Core");
  await expect(layers.last().locator(".wmap-family").first()).toHaveAttribute("data-group", "meet");
  // Each family is one full-width band with its tiles side by side.
  const bands = page.locator(".wmap-family");
  await expect(bands).toHaveCount(11);
  const stack = await page.locator(".wmap-bands").first().boundingBox();
  const band = await bands.first().boundingBox();
  expect(Math.abs(band!.width - stack!.width)).toBeLessThan(1);
  const tiles = page.locator(".wmap-family[data-group='connect'] .wmap-tile");
  const a = await tiles.nth(1).boundingBox();
  const b = await tiles.nth(2).boundingBox();
  expect(b!.x).toBeGreaterThan(a!.x);
  expect(b!.y).toBe(a!.y);
});

test("the full list searches and filters from a side column, as on a WISP's page", async ({ page }) => {
  await page.goto("/developers/wisps");
  const rows = page.locator(".catalog-row");
  const total = await rows.count();
  const count = page.locator(".catalog-count");
  await expect(count).toHaveText(`${total} of ${total} drafts`);
  await page.getByRole("searchbox", { name: "Search the WISPs" }).fill("401");
  await expect(rows).toHaveCount(1);
  await expect(page.locator("#wisp-401")).toBeVisible();
  await expect(count).toHaveText(`1 of ${total} drafts`);
  await page.getByRole("button", { name: "Clear filters" }).click();
  const payments = page.locator(".catalog-family", { hasText: "Payments" });
  const n = Number(await payments.locator(".reader-group-count").textContent());
  await payments.click();
  await expect(payments).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(n);
  await expect(page.locator(".catalog-group")).toHaveCount(1);
  await expect(page.locator("#family-pay")).toBeVisible();
  const side = await page.locator(".catalog-side").boundingBox();
  const main = await page.locator(".catalog-main").boundingBox();
  expect(side!.x + side!.width).toBeLessThan(main!.x);
});

test("/developers/catalog redirects permanently to /developers/wisps", async ({ request }) => {
  const res = await request.get("/developers/catalog", { maxRedirects: 0 });
  expect([301, 308]).toContain(res.status());
  expect(new URL(res.headers()["location"], "http://x").pathname).toBe("/developers/wisps");
});

test("an old catalog link lands on /developers/wisps, anchor kept", async ({ page }) => {
  await page.goto("/developers/catalog#glossary");
  await expect(page).toHaveURL(/\/developers\/wisps#glossary$/);
  await expect(page.locator("details#glossary")).toHaveAttribute("open", "");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Every contract, in one place.");
});
