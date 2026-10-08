import { expect, test, type Page } from "@playwright/test";

/**
 * The pointer ghost stops its frame loop once it is asleep and settled, wherever the pointer rests. Its spot beside
 * the pointer can be past the page's edge (a pointer near the right edge or the page's bottom); it then stops at the
 * edge, and its clock must stop there too instead of chasing a point it can never reach (60 frames a second for as
 * long as the pointer rests). The page's clock is Playwright's, so a minute of gliding and sleeping takes no time.
 */

/** Counts the frames anything asks for from now on. */
async function countFrames(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number };
    w.__frames = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      w.__frames++;
      return raf(cb);
    };
  });
}

const frames = (page: Page) => page.evaluate(() => (window as unknown as { __frames: number }).__frames);

const RESTS: { name: string; at: (w: number, h: number) => { x: number; y: number }; bottom?: boolean }[] = [
  { name: "in the middle", at: (w, h) => ({ x: w / 2, y: h / 2 }) },
  { name: "at the right edge", at: (w, h) => ({ x: w - 4, y: h / 2 }) },
  { name: "at the page's bottom", at: (w, h) => ({ x: w / 2, y: h - 4 }), bottom: true },
];

for (const rest of RESTS) {
  test(`the pointer ghost's clock stops with the pointer ${rest.name}`, async ({ page }) => {
    await page.clock.install();
    await page.goto("/cli");
    const pet = page.locator(".pet");
    await expect(pet).toHaveCount(1);
    if (rest.bottom) await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const { width, height } = page.viewportSize()!;
    const { x, y } = rest.at(width, height);
    await page.mouse.move(x - 30, y - 30);
    await page.mouse.move(x, y, { steps: 4 });

    // Glide over, get bored, fall asleep and settle.
    await page.clock.runFor(120_000);
    await expect(pet).toHaveAttribute("data-mood", "sleeping");

    await countFrames(page);
    await page.clock.runFor(5_000);
    expect(await frames(page), "frames asked for in 5 s of rest").toBe(0);
  });
}
