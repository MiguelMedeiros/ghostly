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
