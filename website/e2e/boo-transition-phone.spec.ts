import { expect, test, type Page } from "@playwright/test";
import { booOver, booSeen, watchBoo } from "./boo-watch";

/**
 * The boo on a phone (Pixel 7): the logo far down the home page goes back to the top behind one ghost saying
 * "boo!", which then leaves nothing on the page; with reduced motion the jump is taken at once. The desktop's
 * checks are boo-transition.spec.ts.
 */

async function logoJump(page: Page) {
  await page.evaluate(() => document.getElementById("wallets")!.scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => scrollY);
  await watchBoo(page);
  await page.locator('a[href="/"]').filter({ visible: true }).first().click();
  return before;
}

test("the logo far down the page: one ghost says boo, the page is back at the top", async ({ page }) => {
  await page.goto("/");
  const before = await logoJump(page);
  expect(before).toBeGreaterThan(1000);
  await booOver(page);
  const seen = await booSeen(page);
  expect(seen.ghosts).toBe(1);
  expect(seen.text).toBe("boo!");
  expect(seen.said).toBeGreaterThan(0.5);
  expect(seen.gone).toBeLessThan(1500);
  expect(await page.evaluate(() => scrollY)).toBeLessThan(2);
  await expect(page.locator(".boo")).toHaveCount(0);
  // Nothing wider than the screen was left behind.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the logo far down the page jumps to the top at once, with no ghost", async ({ page }) => {
    await page.goto("/");
    await logoJump(page);
    expect(await page.evaluate(() => scrollY)).toBeLessThan(2);
    await page.waitForTimeout(600);
    expect((await booSeen(page)).mounted).toBe(false);
  });
});
