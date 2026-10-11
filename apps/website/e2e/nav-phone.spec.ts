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

// The sheet is as tall as the screen below the nav and scrolls inside it. It used to be at least that tall and never
// scrolled, so on a phone on its side, or a short one with the browser's bars showing, its last entries sat below the
// screen's edge, where no swipe or Tab could bring them.
for (const [width, height] of [
  [844, 390],
  [375, 553],
]) {
  test(`${width}x${height}: the phone menu scrolls to its last entry`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/developers");
    await page.getByLabel("Menu").click();
    const sheet = page.locator(".nav-sheet");
    const box = await sheet.evaluate((el) => ({ bottom: el.getBoundingClientRect().bottom, screen: window.innerHeight }));
    expect(box.bottom, "the sheet ends below the screen").toBeLessThanOrEqual(box.screen);
    const last = sheet.getByRole("link", { name: "Download the app" });
    // From the keyboard: the browser brings the focused entry into view, which only a sheet that scrolls allows.
    await last.focus();
    await expect(last).toBeInViewport({ ratio: 1 });
    await last.click();
    await expect(page).toHaveURL(/\/#download$/);
    await expect(sheet).toBeHidden();
  });
}
