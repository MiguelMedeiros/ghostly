import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";

/**
 * The site runs its own scripts only (next.config.ts, Content-Security-Policy): its pages work with the policy on,
 * nothing of theirs is refused, and a third-party script put into a page (as Cloudflare's Web Analytics beacon was, by
 * the proxy in front of the site) is refused.
 *
 * No other site shows a page of this one inside a frame: every answer says so, a file of the site's included, and a page
 * of another origin that frames the site, an invite in the address, gets an empty frame.
 */
const PAGES = ["/", "/cli", "/wisps", "/wisps/401-paired-chat", "/roadmap", "/developers", "/privacy"];
// The pages, a page that is not there and files from public/.
const ANSWERS = [...PAGES, "/no-such-page", "/favicon.svg", "/site.webmanifest"];
// WISP 801's test vector (synthetic bytes), as e2e/join-landing.spec.ts has it.
const CODE = "ghostly1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q5j52ev95hz7vp3xgengdfkxuurjw3m8s7nu06qg9pyx3z9ger5sj22fdxy6nj02pg4y56524t9wkzetfd4ch27tasxzcnrv3jkvemgd94xkmrddehhqutjwd682anh0puh57mu04l8794pd4k";

async function violations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (e) => seen.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
});

for (const path of PAGES) {
  test(`${path} works with the site's script policy and none of its own scripts is refused`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const response = await page.goto(path);
    expect(response?.headers()["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline'");
    // eval() is for React's development build only (next.config.ts): the served site never allows it.
    expect(response?.headers()["content-security-policy"]).not.toContain("unsafe-eval");
    await page.waitForLoadState("networkidle");
    // The head script ran (it marks the page as having JavaScript), and React took the page over.
    await expect(page.locator("html")).toHaveClass(/\bjs\b/);
    expect(await violations(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("the download buttons are there with the policy on", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const downloads = page.locator('a[href*="github.com/MiguelMedeiros/ghostly/releases"], a[href*="chromewebstore.google.com"]');
  expect(await downloads.count()).toBeGreaterThan(0);
  expect(await violations(page)).toEqual([]);
});

test("a third-party script put into a page is refused", async ({ page }) => {
  await page.goto("/");
  const ran = await page.evaluate(() => new Promise<boolean>((resolve) => {
    const script = document.createElement("script");
    script.src = "https://static.cloudflareinsights.com/beacon.min.js";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.append(script);
  }));
  expect(ran).toBe(false);
  expect((await violations(page)).some((v) => v.includes("static.cloudflareinsights.com"))).toBe(true);
});

for (const path of ANSWERS) {
  test(`${path} is answered with the headers that keep it out of another site's frame`, async ({ request }) => {
    const headers = (await request.get(path, { maxRedirects: 0 })).headers();
    const policy = headers["content-security-policy"]!.split(";").map((directive) => directive.trim());
    expect(policy).toContain("frame-ancestors 'none'");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });
}

test("a script of the build is answered with them too", async ({ page, request }) => {
  await page.goto("/");
  const script = await page.locator('script[src^="/_next/static/"]').first().getAttribute("src");
  const headers = (await request.get(script!)).headers();
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
});

for (const path of ["/", `/#${CODE}`, "/privacy"]) {
  test(`another site that frames ${path.slice(0, 10)} gets an empty frame`, async ({ page, baseURL }) => {
    const refused: string[] = [];
    page.on("console", (message) => { if (/frame-ancestors/.test(message.text())) refused.push(message.text()); });
    // Another origin, served from this machine (a browser lets no page from the internet frame an address of the machine).
    const other = createServer((_, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><title>another site</title><iframe id="site" allow="clipboard-write" src="${baseURL}${path}" onload="document.title = 'loaded'"></iframe>`);
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    try {
      const host = new URL(baseURL!).hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
      await page.goto(`http://${host}:${(other.address() as AddressInfo).port}/`);
      await expect(page).toHaveTitle("loaded");
      const frame = page.frames().find((candidate) => candidate.parentFrame() === page.mainFrame())!;
      // The browser's own error page, not a page of the site: no invite dialog, nothing of the site's to click.
      expect(new URL(frame.url()).origin).not.toBe(new URL(baseURL!).origin);
      await expect(page.frameLocator("#site").locator("[data-testid], main, .btn")).toHaveCount(0);
      expect(refused).toHaveLength(1);
    } finally {
      other.close();
    }
  });
}
