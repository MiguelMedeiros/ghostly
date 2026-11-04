import { expect, test } from "@playwright/test";

/**
 * The "page not found" page's headings say what happened. Someone who moves by headings hears one `h1` that says the
 * page was not found, then the line under it, not the big number split into its digits (the 0 is a box of its own
 * with a ring around it). The digits are drawn only: hidden from the accessibility tree.
 */
test("the 404 page's one h1 says the page was not found", async ({ page }) => {
  await page.goto("/no-such-page", { waitUntil: "networkidle" });
  const h1 = page.getByRole("heading", { level: 1 });
  await expect(h1).toHaveCount(1);
  await expect(h1).toHaveAccessibleName("404: Page not found");
  // The big digits are still on screen, out of the accessibility tree.
  await expect(h1.locator('[aria-hidden="true"]')).toBeVisible();
  await expect(h1.locator('[aria-hidden="true"]')).toHaveText("404");
  await expect(page.getByRole("heading", { level: 2 })).toHaveAccessibleName("This page vanished into the DHT");
});
