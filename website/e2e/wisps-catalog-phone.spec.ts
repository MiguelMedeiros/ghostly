import { expect, test } from "@playwright/test";

/** The WISP catalog on a phone: the layers and the list fit the screen, and the title and controls come before the list. */
test("the WISP catalog fits a phone, layers and list", async ({ page }) => {
  await page.goto("/developers/wisps");
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  const band = await page.locator(".wmap-family[data-group='identity']").boundingBox();
  expect(band!.x).toBeGreaterThanOrEqual(0);
  expect(band!.x + band!.width).toBeLessThanOrEqual(width);
  const title = await page.locator("#list-title").boundingBox();
  const search = await page.getByRole("searchbox", { name: "Search the WISPs" }).boundingBox();
  const list = await page.locator(".catalog-main").boundingBox();
  expect(title!.y).toBeLessThan(search!.y);
  expect(search!.y).toBeLessThan(list!.y);
});
