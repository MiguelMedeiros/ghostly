import { expect, test } from "@playwright/test";

/**
 * /cli and /pt-br/cli: the page never scrolls sideways (long commands scroll
 * inside their own block), the install line keeps its copy button in view, and
 * the hero's session fits its window on a laptop.
 */

const SIZES = [
  { width: 1280, height: 900 },
  { width: 820, height: 1180 },
  { width: 390, height: 844 },
];

for (const path of ["/cli", "/pt-br/cli"]) {
  for (const size of SIZES) {
    test(`${path} at ${size.width}px: no sideways scroll, the copy button in view`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto(path, { waitUntil: "networkidle" });
      const doc = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(doc.sw, "the page scrolls sideways").toBeLessThanOrEqual(doc.cw);

      const copy = page.locator(".cl-copy");
      await copy.scrollIntoViewIfNeeded();
      const box = (await copy.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    });
  }
}

test("/cli at 1280px: the hero's session fits its window", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/cli", { waitUntil: "networkidle" });
  const term = await page.locator(".cl-term").evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(term.sw).toBeLessThanOrEqual(term.cw);
});

test("/pt-br/cli is in Portuguese and linked from the Portuguese nav", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/pt-br", { waitUntil: "networkidle" });
  await expect(page.locator(".nav-links a", { hasText: "CLI" })).toHaveAttribute("href", "/pt-br/cli");
  await page.goto("/pt-br/cli", { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ghostly para bots.");
  await expect(page.locator(".nav-links a[aria-current='page']")).toHaveText("CLI");
});
