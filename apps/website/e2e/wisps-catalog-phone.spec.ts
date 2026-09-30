import { expect, test } from "@playwright/test";

/** The WISPs page on a phone: the layers fit the screen, with no sideways scroll. */
test("the WISPs page fits a phone", async ({ page }) => {
  await page.goto("/wisps");
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  for (const group of ["meet", "identity", "headless"]) {
    const band = await page.locator(`.wmap-family[data-group='${group}']`).boundingBox();
    expect(band!.x).toBeGreaterThanOrEqual(0);
    expect(band!.x + band!.width).toBeLessThanOrEqual(width);
  }
});
