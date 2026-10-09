import { expect, test, type Page } from "@playwright/test";

/**
 * Idle loops rest off screen (components/site/IdleLoops.tsx): every CSS animation inside a `data-offscreen` loop
 * really is paused. The loops' own `animation:` shorthands set the play state back to running, so a pause rule that
 * loses the cascade marks them and leaves them all running (the rising particles, the stages' bob and twinkles). The
 * footer's sleeping ghost is a loop too. Checked at the top of a page whose footer is far below, and of the home page,
 * whose film has stages and particles well below the fold.
 */

/** The animations under a loop marked off screen that still run, as "name in root". */
const runningOffscreen = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-offscreen]")].flatMap((root) =>
      [root, ...root.querySelectorAll("*")].flatMap((el) =>
        el
          .getAnimations()
          .filter((a) => a.playState === "running")
          .map((a) => `${(a as CSSAnimation).animationName} in ${root.getAttribute("class")}`),
      ),
    ),
  );

for (const path of ["/cli", "/"]) {
  test(`off-screen loops are paused at the top of ${path}`, async ({ page }) => {
    await page.goto(path);
    const footer = page.locator("footer");
    await expect(footer.locator(".particles")).toHaveAttribute("data-offscreen", "");
    await expect(footer.locator(".footer-sleeper")).toHaveAttribute("data-offscreen", "");
    await expect.poll(() => runningOffscreen(page)).toEqual([]);

    // In view, they run again.
    await footer.scrollIntoViewIfNeeded();
    await expect(footer.locator(".particles")).not.toHaveAttribute("data-offscreen");
    const running = await footer.locator(".particles span").first().evaluate((el) => el.getAnimations().map((a) => a.playState));
    expect(running).toContain("running");
  });
}
