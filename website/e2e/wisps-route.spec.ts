import { expect, test } from "@playwright/test";

/**
 * /wisps is the WISPs' main page: a short hero, then the WISPs that work in the app today drawn as layers. Its old
 * addresses (/developers/wisps and its pages, /developers/catalog, and the old protocol page, /docs) redirect there
 * for good in one hop, and links made for the old full list still land somewhere useful.
 */
test("/wisps is the WISPs page, under Protocol in the nav", async ({ page }) => {
  await page.goto("/wisps");
  await expect(page).toHaveTitle(/^WISPs \|/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Every contract, in one place.");
  await expect(page.locator(".wmap-tile[href='/wisps/01-ghost-core']")).toBeVisible();
  await expect(page.locator(".catalog-hero a[href='/roadmap']")).toBeVisible();
  await expect(page.locator("#glossary")).toBeAttached();
  // No search, list or inventory any more.
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(page.locator("#inventory")).toHaveCount(0);
  // The nav marks it as the current section.
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Protocol" })).toHaveAttribute("aria-current", "page");
});

test("the layers stack the families, the core at the top", async ({ page }) => {
  await page.goto("/wisps");
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
  await page.goto("/wisps");
  const layerColors = await page.locator(".wmap-layer").evaluateAll((els) => els.map((el) => getComputedStyle(el).getPropertyValue("--c").trim()));
  // Core, Link, Talk, In a chat, Many people, Programs: the colours of Meet, Connect, Chat, Payments, Groups, Headless.
  expect(layerColors).toEqual(["#22d3ee", "#60a5fa", "#a78bfa", "#fbbf24", "#fb923c", "#94a3b8"]);
  const bands = await page.locator(".wmap-family").evaluateAll((els) =>
    Object.fromEntries(els.map((el) => [(el as HTMLElement).dataset.group, getComputedStyle(el).getPropertyValue("--c").trim()])),
  );
  expect(bands).toMatchObject({ keep: "#4ade80", services: "#2dd4bf", identity: "#f472b6", files: "#a78bfa" });
  // A tile's number takes its family's colour; the process document stays neutral.
  const num = (href: string) => page.locator(`.wmap-tile[href='${href}'] .wmap-num`).evaluate((el) => getComputedStyle(el).color);
  expect(await num("/wisps/201-cashu")).toBe("rgb(251, 191, 36)");
  expect(await num("/wisps/00-process")).not.toBe("rgb(34, 211, 238)");
});

test("only what works in the app today is drawn; what comes next is on the roadmap", async ({ page }) => {
  await page.goto("/wisps");
  const levels = await page.locator(".wmap-tile").evaluateAll((els) => [...new Set(els.map((el) => (el as HTMLElement).dataset.level))]);
  expect(levels.sort()).toEqual(["available", "none"]);
  await expect(page.locator(".wmap-tile[href='/wisps/303-keet']")).toHaveCount(0);
  // The planned drafts keep their pages, linked from the roadmap and not from the reader's sidebar.
  await page.goto("/roadmap");
  await expect(page.locator(".rm-drafts a[href='/wisps/303-keet']")).toBeVisible();
  await page.goto("/wisps/303-keet");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Keet");
  await expect(page.locator(".reader-all a[href='/wisps/303-keet']")).toHaveCount(0);
  await expect(page.locator(".reader-all a[href='/wisps/301-nostr']")).toBeAttached();
});

test("old links into the full list land on the layers, a draft's page or the roadmap", async ({ page }) => {
  await page.goto("/wisps#family-pay");
  await expect(page.locator("#family-pay")).toBeInViewport();
  await page.goto("/wisps#wisp-401");
  await expect(page.locator("#wisp-401")).toBeInViewport();
  await page.goto("/wisps#list");
  await expect(page.locator("#list")).toBeInViewport();
  // A planned draft is not drawn: its link opens its page.
  await page.goto("/wisps#wisp-303");
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/wisps\/303-keet$/);
  // The adapter inventory moved to the roadmap.
  await page.goto("/wisps#candidate-webrtc");
  await expect(page).toHaveURL(/\/roadmap#candidate-webrtc$/);
  await page.goto("/wisps#inventory");
  await expect(page).toHaveURL(/\/roadmap#inventory-title$/);
});

// Old addresses land on /wisps in one hop.
for (const [from, to] of [
  ["/developers/catalog", "/wisps"],
  ["/developers/wisps", "/wisps"],
  ["/developers/wisps/100-transports", "/wisps/100-transports"],
  ["/docs", "/wisps"],
  ["/docs/anything", "/wisps"],
  ["/wisps/readme", "/wisps"],
  ["/developers/wisps/readme", "/wisps"],
]) {
  test(`${from} redirects permanently to ${to}`, async ({ request }) => {
    const res = await request.get(from, { maxRedirects: 0 });
    expect([301, 308]).toContain(res.status());
    expect(new URL(res.headers()["location"], "http://x").pathname).toBe(to);
  });
}

// Security, Contributing and the two WISP documents that repeat the list are on GitHub only.
for (const [slug, file] of [
  ["security", "main/SECURITY.md"],
  ["contributing", "main/CONTRIBUTING.md"],
  ["implementation", "dev/docs/wisps/IMPLEMENTATION.md"],
  ["numbering", "dev/docs/wisps/NUMBERING.md"],
]) {
  for (const from of [`/wisps/${slug}`, `/developers/wisps/${slug}`]) {
    test(`${from} redirects permanently to ${file} on GitHub`, async ({ request }) => {
      const res = await request.get(from, { maxRedirects: 0 });
      expect([301, 308]).toContain(res.status());
      expect(res.headers()["location"]).toBe(`https://github.com/MiguelMedeiros/ghostly/blob/${file}`);
    });
  }
}

test("the sitemap lists the WISPs page, and neither /docs nor the GitHub-only documents", async ({ request }) => {
  const xml = await (await request.get("/sitemap.xml")).text();
  expect(xml).toContain("<loc>https://ghostly.tools/wisps</loc>");
  expect(xml).toContain("<loc>https://ghostly.tools/wisps/01-ghost-core</loc>");
  expect(xml).not.toContain("/developers/wisps");
  expect(xml).not.toContain("https://ghostly.tools/docs<");
  expect(xml).not.toMatch(/\/wisps\/(security|contributing|readme|implementation|numbering)</);
});

test("the 404 page points at the WISPs", async ({ page }) => {
  await page.goto("/no-such-page");
  await expect(page.getByRole("link", { name: "Read the WISPs" })).toHaveAttribute("href", "/wisps");
});

test("an old link lands on /wisps, anchor kept", async ({ page }) => {
  await page.goto("/developers/catalog#glossary");
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/wisps#glossary$/);
  await expect(page.locator("details#glossary")).toHaveAttribute("open", "");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Every contract, in one place.");
});
