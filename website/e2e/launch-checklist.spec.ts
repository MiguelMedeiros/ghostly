import { expect, test } from "@playwright/test";

/**
 * What a crawler or a share sees: robots.txt and the sitemap are valid, and every page in the sitemap answers with
 * its own title, description and share card (a 1200x630 image under 300 KB at an absolute address). A missing page has a title of
 * its own, no picture on the home page lacks alt text, and no page calls another site or sets a cookie (the site has
 * no analytics, so it needs no cookie banner).
 */
const SITE = "https://ghostly.tools";

type Head = {
  title: string;
  description: string | null;
  canonical: string | null;
  ogTitle: string | null;
  ogUrl: string | null;
  ogImage: string | null;
  ogWidth: string | null;
  ogHeight: string | null;
  twitterCard: string | null;
  twitterImage: string | null;
  twitterCreator: string | null;
};

function head(html: string): Head {
  const tag = (re: RegExp) => html.match(re)?.[1] ?? null;
  const meta = (attr: string, key: string) =>
    tag(new RegExp(`<meta ${attr}="${key.replace(/:/g, "\\:")}" content="([^"]*)"`));
  const decode = (s: string | null) => s?.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"') ?? null;
  return {
    title: decode(tag(/<title>([^<]*)<\/title>/)) ?? "",
    description: decode(meta("name", "description")),
    canonical: tag(/<link rel="canonical" href="([^"]*)"/),
    ogTitle: decode(meta("property", "og:title")),
    ogUrl: meta("property", "og:url"),
    ogImage: meta("property", "og:image"),
    ogWidth: meta("property", "og:image:width"),
    ogHeight: meta("property", "og:image:height"),
    twitterCard: meta("name", "twitter:card"),
    twitterImage: meta("name", "twitter:image"),
    twitterCreator: meta("name", "twitter:creator"),
  };
}

async function sitemapPaths(request: import("@playwright/test").APIRequestContext) {
  const res = await request.get("/sitemap.xml");
  expect(res.status()).toBe(200);
  const xml = await res.text();
  expect(xml).toMatch(/^<\?xml [^>]*\?>\s*<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  expect(locs.length).toBe((xml.match(/<url>/g) ?? []).length);
  return locs.map((loc) => {
    expect(loc.startsWith(SITE)).toBe(true);
    return loc.slice(SITE.length) || "/";
  });
}

test("robots.txt allows the site and points at the sitemap", async ({ request }) => {
  const res = await request.get("/robots.txt");
  expect(res.status()).toBe(200);
  const text = await res.text();
  expect(text).toMatch(/^User-Agent: \*\nAllow: \/$/im);
  expect(text).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  expect(text).not.toMatch(/^Disallow: \/$/m);
});

test("the sitemap lists each page once, and only pages that answer", async ({ request }) => {
  const paths = await sitemapPaths(request);
  expect(new Set(paths).size).toBe(paths.length);
  // Addresses that now redirect or are gone.
  for (const gone of ["/docs", "/developers/wisps", "/developers/catalog", "/wisps/readme", "/wisps/implementation", "/wisps/numbering", "/wisps/security", "/wisps/contributing"])
    expect(paths).not.toContain(gone);
  for (const path of paths) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(200);
  }
});

test("every page in the sitemap has its own title, description and share card", async ({ request }) => {
  const paths = await sitemapPaths(request);
  const titles = new Map<string, string>();
  const descriptions = new Map<string, string>();
  const shareTitles = new Map<string, string>();
  for (const path of paths) {
    const h = head(await (await request.get(path)).text());
    const url = path === "/" ? SITE : `${SITE}${path}`;
    expect(h.title, path).not.toBe("");
    expect(h.description, path).toBeTruthy();
    expect(h.description!.length, `${path} description`).toBeLessThanOrEqual(200);
    expect(`${h.title} ${h.description}`, path).not.toContain("—");
    // A canonical, when a page has one, is its own address (never the home page's).
    if (h.canonical !== null) expect(h.canonical.replace(/\/$/, ""), path).toBe(url);
    expect(h.ogTitle, path).toBeTruthy();
    expect(h.ogUrl?.replace(/\/$/, ""), path).toBe(url);
    expect(h.ogImage, path).toMatch(/^https:\/\/ghostly\.tools\/.+\.(png|jpe?g|webp)$/);
    expect([h.ogWidth, h.ogHeight], path).toEqual(["1200", "630"]);
    expect(h.twitterCard, path).toBe("summary_large_image");
    expect(h.twitterImage, path).toMatch(/^https:\/\//);
    // /privacy writes its own card; every page built by lib/pageMeta.ts names the author.
    if (path !== "/privacy") expect(h.twitterCreator, path).toBe("@_miguelmedeiros");
    for (const [seen, key] of [[titles, h.title], [descriptions, h.description!], [shareTitles, h.ogTitle!]] as const) {
      expect(seen.get(key), `${path} repeats ${seen.get(key)}: ${key}`).toBeUndefined();
      seen.set(key, path);
    }
  }
});

test("the share image is 1200x630 and under 300 KB", async ({ request, page }) => {
  const h = head(await (await request.get("/")).text());
  const local = new URL(h.ogImage!).pathname;
  const res = await request.get(local);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/^image\//);
  // Some apps drop a share picture over their limit (WhatsApp's is about 300 KB); scripts/og-image.mjs keeps it small.
  expect((await res.body()).length).toBeLessThan(300 * 1024);
  await page.goto("/");
  const size = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  }, local);
  expect(size).toEqual([1200, 630]);
});

test("the icons and the manifest answer", async ({ request }) => {
  const html = await (await request.get("/")).text();
  for (const rel of ["icon", "apple-touch-icon", "manifest"]) expect(html, rel).toMatch(new RegExp(`<link rel="${rel}" href="[^"]+"`));
  const manifest = await (await request.get("/site.webmanifest")).json();
  for (const icon of manifest.icons) expect((await request.get(icon.src)).status(), icon.src).toBe(200);
  expect((await request.get("/apple-touch-icon.png")).status()).toBe(200);
});

test("a missing page answers 404 with a title of its own", async ({ page, request }) => {
  const home = head(await (await request.get("/")).text());
  const res = await page.goto("/no-such-page");
  expect(res?.status()).toBe(404);
  await expect(page).toHaveTitle(/^Page not found \|/);
  expect(await page.title()).not.toBe(home.title);
  // Next adds its own noindex; the page must not also say index.
  const robots = await page.locator('meta[name="robots"]').evaluateAll((all) => all.map((m) => m.getAttribute("content")));
  expect(robots.length).toBeGreaterThan(0);
  for (const content of robots) expect(content).toMatch(/noindex/);
});

test("no page calls another site or sets a cookie", async ({ page, context, request }) => {
  test.setTimeout(300_000);
  const paths = [...(await sitemapPaths(request)), "/no-such-page"];
  const origin = new URL(page.url() === "about:blank" ? test.info().project.use.baseURL! : page.url()).origin;
  const elsewhere: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(origin) && !/^(data|blob):/.test(r.url())) elsewhere.push(r.url());
  });
  for (const path of paths) {
    await page.goto(path, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
  }
  expect(elsewhere).toEqual([]);
  expect(await context.cookies()).toEqual([]);
  expect(await page.evaluate(() => document.cookie)).toBe("");
});

test("no picture on the home page lacks alt text", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += innerHeight) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 30));
    }
  });
  const images = page.locator("img");
  expect(await images.count()).toBeGreaterThan(0);
  await expect(page.locator("img:not([alt])")).toHaveCount(0);
  await expect(page.locator('svg[role="img"]:not([aria-label]):not([aria-labelledby])')).toHaveCount(0);
});
