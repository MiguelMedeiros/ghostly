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

test("the pointer ghost settles soon after the pointer stops, and moves without a page layout", async ({ page }) => {
  await page.clock.install();
  await page.goto("/privacy");
  const pet = page.locator(".pet");
  await expect(pet).toHaveCount(1);
  // Let it come over to the pointer and settle, then read across a line for 2 s and stop.
  await page.mouse.move(600, 400);
  await page.clock.runFor(120_000);
  for (let i = 0; i < 40; i++) {
    await page.mouse.move(600 + i * 8, 400 + (i % 5) * 6);
    await page.clock.runFor(50);
  }
  await countFrames(page);
  const before = await pet.boundingBox();

  // A glide of a few seconds, then nothing: it used to creep its last pixels for 45-57 s at 60 frames a second.
  await page.clock.runFor(60_000);
  console.log(`frames after the pointer stops: ${await frames(page)}`);
  expect(await frames(page), "frames asked for after the pointer stops").toBeLessThan(600);
  expect(await pet.boundingBox(), "the ghost has moved").not.toEqual(before);

  // It moves by a compositor transform: left/top would lay the page out again at every frame.
  const style = await pet.evaluate((el) => ({ left: (el as HTMLElement).style.left, top: (el as HTMLElement).style.top }));
  expect(style).toEqual({ left: "", top: "" });
});
