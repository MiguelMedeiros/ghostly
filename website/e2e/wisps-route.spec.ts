import { expect, test } from "@playwright/test";

/**
 * /developers/wisps is the WISPs' main page: a short hero, then the WISPs that work in the app today drawn as
 * layers. Its old address, /developers/catalog, redirects there for good, and links made for the old full
 * list still land somewhere useful.
 */
test("/developers/wisps is the WISPs page", async ({ page }) => {
  await page.goto("/developers/wisps");
  await expect(page).toHaveTitle(/^WISPs \|/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Every contract, in one place.");
  await expect(page.locator(".wmap-tile[href='/developers/wisps/01-ghost-core']")).toBeVisible();
  await expect(page.locator(".catalog-hero a[href='/roadmap']")).toBeVisible();
  await expect(page.locator("#glossary")).toBeAttached();
  // No search, list or inventory any more.
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(page.locator("#inventory")).toHaveCount(0);
  // The nav marks it as the current section.
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "WISPs" })).toHaveAttribute("aria-current", "page");
});

test("the layers stack the families, the core at the top", async ({ page }) => {
  await page.goto("/developers/wisps");
  const layers = page.locator(".wmap-layer");
  await expect(layers.first().locator(".wmap-layer-label")).toHaveText("Core");
  await expect(layers.first().locator(".wmap-family").first()).toHaveAttribute("data-group", "meet");
  await expect(layers.last().locator(".wmap-layer-label")).toHaveText("Programs");
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

test("each layer and family wears its colour from the roadmap's map", async ({ page }) => {
  await page.goto("/developers/wisps");
  const layerColors = await page.locator(".wmap-layer").evaluateAll((els) => els.map((el) => getComputedStyle(el).getPropertyValue("--c").trim()));
  // Core, Link, Talk, In a chat, Many people, Programs: the colours of Meet, Connect, Chat, Payments, Groups, Headless.
  expect(layerColors).toEqual(["#22d3ee", "#60a5fa", "#a78bfa", "#fbbf24", "#fb923c", "#94a3b8"]);
  const bands = await page.locator(".wmap-family").evaluateAll((els) =>
    Object.fromEntries(els.map((el) => [(el as HTMLElement).dataset.group, getComputedStyle(el).getPropertyValue("--c").trim()])),
  );
  expect(bands).toMatchObject({ keep: "#4ade80", services: "#2dd4bf", identity: "#f472b6", files: "#a78bfa" });
  // A tile's number takes its family's colour; the process document stays neutral.
  const num = (href: string) => page.locator(`.wmap-tile[href='${href}'] .wmap-num`).evaluate((el) => getComputedStyle(el).color);
  expect(await num("/developers/wisps/201-cashu")).toBe("rgb(251, 191, 36)");
  expect(await num("/developers/wisps/00-process")).not.toBe("rgb(34, 211, 238)");
});

test("only what works in the app today is drawn; what comes next is on the roadmap", async ({ page }) => {
  await page.goto("/developers/wisps");
  const levels = await page.locator(".wmap-tile").evaluateAll((els) => [...new Set(els.map((el) => (el as HTMLElement).dataset.level))]);
  expect(levels.sort()).toEqual(["available", "none"]);
  await expect(page.locator(".wmap-tile[href='/developers/wisps/303-keet']")).toHaveCount(0);
  // The planned drafts keep their pages, linked from the roadmap and not from the reader's sidebar.
  await page.goto("/roadmap");
  await expect(page.locator(".rm-drafts a[href='/developers/wisps/303-keet']")).toBeVisible();
  await page.goto("/developers/wisps/303-keet");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Keet");
  await expect(page.locator(".reader-all a[href='/developers/wisps/303-keet']")).toHaveCount(0);
  await expect(page.locator(".reader-all a[href='/developers/wisps/301-nostr']")).toBeAttached();
});

test("old links into the full list land on the layers, a draft's page or the roadmap", async ({ page }) => {
  await page.goto("/developers/wisps#family-pay");
  await expect(page.locator("#family-pay")).toBeInViewport();
  await page.goto("/developers/wisps#wisp-401");
  await expect(page.locator("#wisp-401")).toBeInViewport();
  await page.goto("/developers/wisps#list");
  await expect(page.locator("#list")).toBeInViewport();
  // A planned draft is not drawn: its link opens its page.
  await page.goto("/developers/wisps#wisp-303");
  await expect(page).toHaveURL(/\/developers\/wisps\/303-keet$/);
  // The adapter inventory moved to the roadmap.
  await page.goto("/developers/wisps#candidate-webrtc");
  await expect(page).toHaveURL(/\/roadmap#candidate-webrtc$/);
  await page.goto("/developers/wisps#inventory");
  await expect(page).toHaveURL(/\/roadmap#inventory-title$/);
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
