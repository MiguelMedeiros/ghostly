import { expect, test } from "@playwright/test";
import brand from "../lib/brand/brand.json";
import { axe } from "./axe";

// /brand, the brand manual: its chapters, the footer link, the press kit the build makes (scripts/brand-kit.mjs), the
// contrast table computed from lib/brand/brand.json, and a page that reads well and stays still when asked.

const CHAPTERS = ["foundation", "logo", "color", "type", "icons", "imagery", "voice", "ui", "applications", "use", "press-kit"];

test("/brand renders its title and every chapter, each reachable from the contents", async ({ page }) => {
  await page.goto("/brand");
  await expect(page).toHaveTitle("Brand | Ghostly");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("The Ghostly brand");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://ghostly.tools/brand");
  const toc = page.getByRole("navigation", { name: "On this page" });
  for (const id of CHAPTERS) {
    await expect(page.locator(`section#${id} h2`)).toBeVisible();
    await expect(toc.locator(`a[href="#${id}"]`)).toHaveCount(1);
  }
  await toc.locator('a[href="#press-kit"]').click();
  await expect(page.locator("section#press-kit h2")).toBeInViewport();
});

test("the footer links the brand page, and the sitemap lists it", async ({ page, request }) => {
  await page.goto("/");
  const link = page.locator("footer").getByRole("link", { name: "Brand", exact: true });
  await expect(link).toHaveAttribute("href", "/brand");
  await link.click();
  await expect(page).toHaveURL(/\/brand$/);
  const xml = await (await request.get("/sitemap.xml")).text();
  expect(xml).toContain("<loc>https://ghostly.tools/brand</loc>");
});

test("the press kit downloads as a zip, and every logo link on the page answers", async ({ page, request }) => {
  await page.goto("/brand");
  const zip = await request.get("/brand/ghostly-press-kit.zip");
  expect(zip.status()).toBe(200);
  const bytes = await zip.body();
  expect(bytes.subarray(0, 4).toString("binary")).toBe("PK\u0003\u0004");
  for (const name of ["ghostly-press-kit/README.txt", "ghostly-press-kit/boilerplate.txt", "ghostly-press-kit/colors/ghostly-colors.ase", "ghostly-press-kit/logo/svg/ghostly-lockup-cyan.svg"])
    expect(bytes.includes(Buffer.from(name)), name).toBe(true);

  const hrefs = await page.locator(".br-files a[download], .br-kit-list a").evaluateAll((links) => [...new Set(links.map((a) => a.getAttribute("href")!))]);
  expect(hrefs.length).toBeGreaterThan(20);
  for (const href of hrefs) expect((await request.head(href)).status(), href).toBe(200);
  const svg = await (await request.get("/brand/ghostly-press-kit/logo/svg/ghostly-icon-navy.svg")).text();
  expect(svg).toContain(brand.logo.iconPath);
  expect(svg).toContain('fill="#060a10"');
});

test("the copy buttons copy the boilerplate", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/brand");
  await page.getByRole("button", { name: "Copy the short description" }).click();
  await expect(page.getByRole("button", { name: "Copied" }).first()).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(brand.foundation.boilerplate.short);
});

test("the press contact is a mail link, and the social card carries the short tagline", async ({ page }) => {
  await page.goto("/brand");
  await expect(page.locator("#use a.br-contact-mail")).toHaveAttribute("href", `mailto:${brand.press.contact}`);
  await expect(page.locator(".br-app-social-title")).toHaveText(brand.foundation.taglineShort);
  await expect(page.locator("#foundation .br-tagline")).toHaveText(brand.foundation.tagline);
});

test("the contrast table shows every pair, the don't pair failing", async ({ page }) => {
  await page.goto("/brand");
  const rows = page.locator(".br-contrast tbody tr");
  await expect(rows).toHaveCount(brand.colors.contrast.length);
  const avoid = page.locator('.br-contrast tr[data-use="avoid"]');
  await expect(avoid).toContainText("Ghost cyan on white");
  await expect(avoid).toContainText("1.81:1");
  await expect(avoid.locator("td").nth(1)).toContainText("Fail");
  await expect(rows.filter({ hasText: "Mist on Night" }).locator("td").nth(1)).toContainText("Pass");
});

test("the first Tab stop skips to the text", async ({ page }) => {
  await page.goto("/brand");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveText("Skip to content");
});

test("/brand: axe finds nothing serious, wide or at 320 px, and nothing scrolls sideways", async ({ page }) => {
  test.setTimeout(120_000);
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/brand", { waitUntil: "networkidle" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `scroll width at ${width}px`).toBe(width);
    expect(await axe(page, "main"), `/brand at ${width}px`).toEqual([]);
  }
});

test("with reduced motion the duration demos stay still", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/brand");
  const row = page.locator(".br-durs li").first();
  await row.hover();
  const dot = row.locator(".br-dur-dot");
  await page.waitForTimeout(400);
  expect(await dot.evaluate((el) => getComputedStyle(el).left)).toBe("0px");
});
