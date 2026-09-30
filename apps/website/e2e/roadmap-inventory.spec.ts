import { expect, test } from "@playwright/test";

/**
 * The roadmap's inventory ("Every possibility, classified") folds into one closed category per
 * section of the source. A link to an entry opens its category and lands on it.
 */

test("the inventory's categories start closed and open one by one", async ({ page }) => {
  await page.goto("/roadmap");
  const cats = page.locator("details.rm-cat");
  expect(await cats.count()).toBeGreaterThanOrEqual(6);
  for (const open of await cats.evaluateAll((all) => all.map((d) => (d as HTMLDetailsElement).open))) expect(open).toBe(false);
  // A closed category still says what it holds.
  await expect(cats.first().locator("summary .rm-cat-count")).toHaveText(/^\d+ entries$/);
  await expect(cats.first().locator("summary .level").first()).toBeVisible();
  await expect(cats.first().locator("li").first()).toBeHidden();

  await cats.nth(1).locator(":scope > summary").click();
  await expect(cats.nth(1)).toHaveAttribute("open", "");
  await expect(cats.nth(1).locator("li").first()).toBeVisible();
  await expect(cats.first()).not.toHaveAttribute("open", "");

  const all = page.getByTestId("inventory-toggle-all");
  await all.click();
  for (const open of await cats.evaluateAll((a) => a.map((d) => (d as HTMLDetailsElement).open))) expect(open).toBe(true);
  await expect(all).toHaveText("Close all");
  await all.click();
  for (const open of await cats.evaluateAll((a) => a.map((d) => (d as HTMLDetailsElement).open))) expect(open).toBe(false);
});

test("a link to an entry opens its category and scrolls to it", async ({ page }) => {
  await page.goto("/roadmap#candidate-profile");
  const entry = page.locator("#candidate-profile");
  await expect(entry.locator("xpath=ancestor::details[contains(@class,'rm-cat')]")).toHaveAttribute("open", "");
  await expect(entry).toBeInViewport();

  // A hash change on the page does the same.
  await page.evaluate(() => (location.hash = "#candidate-tor"));
  const tor = page.locator("#candidate-tor");
  await expect(tor.locator("xpath=ancestor::details[contains(@class,'rm-cat')]")).toHaveAttribute("open", "");
  await expect(tor).toBeInViewport();
});
