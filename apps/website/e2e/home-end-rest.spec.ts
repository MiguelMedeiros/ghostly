import { expect, test, type Page } from "@playwright/test";

/**
 * At the end of the home (the download panel and the footer), nothing off screen keeps an infinite loop running: the
 * finale title's gradient words a screen above (background-position, never on the compositor), Act I's field drift
 * and the pointer ghost left above by a scroll under a still pointer each kept the page restyling 60 times a second,
 * 84-92 ms a second at 1280 and 213 on a throttled phone (agents#1056). What runs is on screen, or within the quarter
 * screen IdleLoops starts things early for. The particles of a field on screen are not counted: they rise across it,
 * in and out of view, and run on the compositor.
 */

/** Infinite CSS animations still running on an element that is not near the screen, as "name on class". */
const runningOffscreen = (page: Page) =>
  page.evaluate(() => {
    const margin = window.innerHeight / 4;
    return document
      .getAnimations()
      .filter((a): a is CSSAnimation => a instanceof CSSAnimation && a.playState === "running" && a.effect?.getTiming().iterations === Infinity)
      .filter((a) => {
        const target = (a.effect as KeyframeEffect).target as Element;
        const field = target.closest(".particles");
        if (field && !field.hasAttribute("data-offscreen")) return false;
        const box = target.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) return false;
        return box.bottom < -margin || box.top > window.innerHeight + margin;
      })
      .map((a) => {
        const target = (a.effect as KeyframeEffect).target as Element;
        return `${a.animationName} on ${target.getAttribute("class") ?? target.parentElement?.getAttribute("class")}`;
      });
  });

test("the end of the home runs no loop that is off screen", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  // The pointer ghost comes for a pointer near the top, then the page scrolls under the still pointer.
  await page.mouse.move(400, 300);
  await page.mouse.move(420, 320);
  await expect(page.locator(".pet")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(page.locator("#download")).toBeInViewport();
  await expect(page.locator(".fin-title .text-gradient-animated").first()).toHaveAttribute("data-offscreen", "");
  await expect(page.locator(".act-field-drift").first()).toHaveAttribute("data-offscreen", "");
  await expect(page.locator(".pet")).toHaveAttribute("data-offscreen", "");
  await expect.poll(() => runningOffscreen(page)).toEqual([]);

  // Back in view, they run again.
  await page.locator(".fin-title").scrollIntoViewIfNeeded();
  const words = page.locator(".fin-title .text-gradient-animated").first();
  await expect(words).not.toHaveAttribute("data-offscreen");
  await expect.poll(() => words.evaluate((el) => el.getAnimations().map((a) => a.playState))).toContain("running");
});
