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

// The sheet covers the page, so a tap on any entry closes it. It used to close only when the path changed: the entry
// of the page already open left it over the whole screen, and on the home page "How it works" scrolled to the story
// behind it.
for (const [path, entry, lands] of [
  ["/", "How it works", /\/#story$/],
  ["/developers", "Developers", /\/developers$/],
  ["/wisps", "Protocol", /\/wisps$/],
] as const) {
  test(`${path}: a tap on "${entry}" closes the phone menu`, async ({ page }) => {
    await page.goto(path);
    // Once React runs (the desktop chevron, hidden here, is disabled until then): before that a tap is the browser's own.
    await expect(page.locator(".nav-open-more")).toBeEnabled();
    await page.getByLabel("Menu").click();
    const sheet = page.locator(".nav-sheet");
    await sheet.getByRole("link", { name: entry, exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(lands);
  });
}

// The desktop nav marks the page that is open; the sheet lists the same pages and used to mark none of them.
test("the phone menu marks the page that is open", async ({ page }) => {
  await page.goto("/developers");
  await page.getByLabel("Menu").click();
  const sheet = page.locator(".nav-sheet");
  const current = sheet.getByRole("link", { name: "Developers", exact: true });
  await expect(current).toHaveAttribute("aria-current", "page");
  await expect(sheet.locator('[aria-current="page"]')).toHaveCount(1);
  // In the nav's cyan, which the two ways to open Ghostly already wear; the other pages keep the plain text colour.
  const colour = (name: string | RegExp) => sheet.getByRole("link", { name }).evaluate((el) => getComputedStyle(el).color);
  expect(await colour(/^Developers$/)).toBe(await colour("Download the app"));
  expect(await colour("Roadmap")).not.toBe(await colour(/^Developers$/));
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

// The sheet covers the whole screen below the nav, so the focus must never sit on the page behind it. Tab past its
// last entry used to walk through the page's links one by one, all of them out of sight.
test("Tab past the last entry closes the phone menu", async ({ page }) => {
  await page.goto("/developers");
  const menu = page.locator(".nav-menu");
  await page.getByLabel("Menu").click();
  const sheet = page.locator(".nav-sheet");
  // Inside the sheet Tab moves from entry to entry and the sheet stays open.
  await sheet.getByRole("link", { name: /Open in your browser/ }).focus();
  await page.keyboard.press("Tab");
  await expect(sheet.getByRole("link", { name: "Download the app" })).toBeFocused();
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(sheet).toBeHidden();
  expect(await menu.evaluate((el) => el.contains(document.activeElement)), "the focus left the menu").toBe(false);
  await expect(page.locator(":focus")).toBeInViewport();
});

test("Escape closes the phone menu and returns the focus to its button", async ({ page }) => {
  await page.goto("/developers");
  await page.getByLabel("Menu").click();
  const sheet = page.locator(".nav-sheet");
  await sheet.getByRole("link", { name: "Download the app" }).focus();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(page.getByLabel("Menu")).toBeFocused();
});
