import { expect, test, type Page } from "@playwright/test";
import { booOver, booSeen, watchBoo } from "./boo-watch";

/**
 * The boo (components/site/Boo.tsx): a long jump on the page, or a page change, shows one ghost saying "boo!"
 * over a veil, then removes it all, so nothing is left over the page. Reduced motion takes the jump at once,
 * with no ghost. The phone's check is boo-transition-phone.spec.ts.
 */

/** Past the first chapter, where the story rail shows, then a click on a chapter mark far below. */
async function railJump(page: Page) {
  const invite = await page.evaluate(() => Math.round(document.getElementById("invite")!.getBoundingClientRect().top + scrollY));
  await page.evaluate((y) => scrollTo({ top: y + 400, behavior: "instant" }), invite);
  await page.waitForTimeout(400);
  const marks = page.locator(".rail-mark");
  const last = marks.nth((await marks.count()) - 1);
  await last.hover();
  const before = await page.evaluate(() => scrollY);
  await watchBoo(page);
  await last.click();
  return before;
}

test("a far jump shows one ghost saying boo, lands, and leaves nothing on the page", async ({ page }) => {
  await page.goto("/");
  const before = await railJump(page);
  await booOver(page);
  const seen = await booSeen(page);
  expect(seen.ghosts, "the ghosts on screen at once").toBe(1);
  expect(seen.text).toBe("boo!");
  expect(seen.said, "the bubble never showed").toBeGreaterThan(0.9);
  // About 720 ms by design; the ceiling leaves a busy CI room.
  expect(seen.gone, "the boo took too long").toBeLessThan(1500);
  const after = await page.evaluate(() => ({ y: scrollY, vh: innerHeight }));
  expect(after.y - before, "the jump did not land far below").toBeGreaterThan(after.vh * 1.5);
  // Gone for good: nothing over the page, and a click in the middle reaches the page.
  await expect(page.locator(".boo")).toHaveCount(0);
  const hit = await page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest(".boo") ?? null);
  expect(hit).toBeNull();
});

test("a page change shows one ghost and lands on the new page", async ({ page }) => {
  await page.goto("/");
  const link = page.locator('a[href^="/"]:not([href="/"]):not([href^="/#"])').filter({ visible: true }).first();
  const href = (await link.getAttribute("href"))!;
  await watchBoo(page);
  await link.click();
  await booOver(page);
  const seen = await booSeen(page);
  expect(seen.ghosts).toBe(1);
  expect(seen.text).toBe("boo!");
  expect(new URL(page.url()).pathname).toBe(new URL(href, page.url()).pathname);
  await expect(page.locator(".boo")).toHaveCount(0);
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("a far jump is taken at once, with no ghost", async ({ page }) => {
    await page.goto("/");
    const before = await railJump(page);
    // The click has returned: the page is already there.
    const after = await page.evaluate(() => ({ y: scrollY, vh: innerHeight }));
    expect(after.y - before, "the jump was not taken at once").toBeGreaterThan(after.vh * 1.5);
    await page.waitForTimeout(600);
    expect((await booSeen(page)).mounted, "a ghost showed under reduced motion").toBe(false);
  });
});
