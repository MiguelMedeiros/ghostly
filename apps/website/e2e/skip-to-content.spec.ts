import { expect, test } from "@playwright/test";

/**
 * "Skip to content" on the home page leads to the story's first action, "Open in your browser". The story rail is
 * fixed to the bottom of the screen, so where it sits in the DOM does not move it, but before the story it put its
 * 9 chapter marks between the skip link and the hero's buttons.
 */
test("Skip to content and one Tab land on the hero's first action, not the story rail", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-mark")).toHaveCount(9);
  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.locator(".hero-actions .btn--primary")).toBeFocused();
});
