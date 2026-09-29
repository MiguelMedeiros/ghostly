import { expect, test } from "@playwright/test";

/** On a phone the nav folds into a menu: every page, AI agents included, and both ways to open Ghostly. */

test("the phone menu has every page and both ways to open Ghostly", async ({ page }) => {
  await page.goto("/developers");
  await expect(page.locator(".nav-open")).toBeHidden();
  await page.getByLabel("Menu").click();
  const sheet = page.locator(".nav-sheet");
  await expect(sheet.getByRole("link", { name: "AI agents" })).toHaveAttribute("href", "/developers/agents");
  await expect(sheet.getByRole("link", { name: /Open in your browser/ })).toHaveAttribute("href", "https://app.ghostly.tools");
  await sheet.getByRole("link", { name: "Download the app" }).click();
  await expect(page).toHaveURL(/\/#download$/);
  await expect(sheet).toBeHidden();
});
