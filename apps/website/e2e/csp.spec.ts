import { expect, test, type Page } from "@playwright/test";

/**
 * The site runs its own scripts only (next.config.ts, Content-Security-Policy): its pages work with the policy on,
 * nothing of theirs is refused, and a third-party script put into a page (as Cloudflare's Web Analytics beacon was, by
 * the proxy in front of the site) is refused.
 */
const PAGES = ["/", "/cli", "/wisps", "/wisps/401-paired-chat", "/roadmap", "/developers", "/privacy"];

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
