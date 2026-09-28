import { expect, test } from "@playwright/test";

/**
 * The nav (components/site/Nav.tsx): its pages, AI agents among them, and the Open app split button. The main part
 * opens the web app; the chevron opens a menu with the web app and a download (the home page's download section).
 */

test("the nav lists AI agents after the CLI and marks it on its page", async ({ page }) => {
  await page.goto("/developers/agents");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link")).toHaveText(["How it works", "Developers", "Protocol", "Roadmap", "CLI", "AI agents"]);
  await expect(nav.getByRole("link", { name: "AI agents" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Developers" })).not.toHaveAttribute("aria-current", "page");
});

for (const width of [1280, 960]) {
  test(`at ${width}px the nav's links and Open app sit on one line`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/developers");
    const tops = await page.locator(".nav-links a, .nav-open-main").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
    expect(new Set(tops).size, "a link wrapped").toBe(1);
    const nav = await page.locator(".nav-inner").evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(nav.sw).toBeLessThanOrEqual(nav.cw);
  });
}

test("Open app opens the web app; its chevron offers the web app or a download", async ({ page }) => {
  await page.goto("/developers");
  await expect(page.locator(".nav-open-main")).toHaveAttribute("href", "https://app.ghostly.tools");
  const more = page.getByRole("button", { name: "Ways to open Ghostly" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const menu = page.getByRole("menu", { name: "Ways to open Ghostly" });
  const items = menu.getByRole("menuitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute("href", "https://app.ghostly.tools");
  await expect(items.nth(0)).toContainText("Open in your browser");
  await expect(items.nth(1)).toContainText("Download the app");
  // A click anywhere else closes it.
  await page.mouse.click(10, 400);
  await expect(menu).toHaveCount(0);
  // Download lands on the home page's download section.
  await more.click();
  await menu.getByRole("menuitem", { name: /Download the app/ }).click();
  await expect(page).toHaveURL(/\/#download$/);
  await expect(page.locator("#download")).toBeInViewport();
});

test("the open menu works from the keyboard", async ({ page }) => {
  await page.goto("/developers");
  const more = page.getByRole("button", { name: "Ways to open Ghostly" });
  await more.focus();
  await page.keyboard.press("Enter");
  const items = page.getByRole("menu").getByRole("menuitem");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(more).toBeFocused();
  // ArrowUp on the button opens it on the last item.
  await page.keyboard.press("ArrowUp");
  await expect(items.nth(1)).toBeFocused();
});

test("the footer has no link to the old protocol page", async ({ page }) => {
  await page.goto("/developers");
  await expect(page.locator('footer a[href="/docs"]')).toHaveCount(0);
  await expect(page.locator('footer a[href="/wisps"]')).toHaveCount(1);
});
