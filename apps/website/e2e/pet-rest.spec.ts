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

// Asleep, its float and z's looped forever: 8 style recalcs a second beside a still pointer, and at the top of every
// page where it sleeps at its start spot (agents#1115). They play a few times and rest, as the footer's sleeper does.
test("the sleeping pointer ghost floats and breathes its z's a few times, then rests", async ({ page }) => {
  await page.clock.install();
  await page.goto("/cli");
  const pet = page.locator(".pet");
  await expect(pet).toHaveCount(1);
  await page.mouse.move(600, 400);
  await page.clock.runFor(120_000);
  await expect(pet).toHaveAttribute("data-mood", "sleeping");
  const loops = () =>
    pet.evaluate((el) =>
      el.getAnimations({ subtree: true }).map((a) => ({
        name: (a as CSSAnimation).animationName,
        iterations: a.effect!.getComputedTiming().iterations,
        end: a.effect!.getComputedTiming().endTime,
      })),
    );
  const asleep = await loops();
  expect(asleep.map((l) => l.name).sort(), "what moves while it sleeps").toEqual(["pet-doze", "zzz", "zzz", "zzz"]);
  expect(asleep.filter((l) => l.iterations === Infinity), "loops that never end").toEqual([]);
  // All of it over within a quarter of a minute.
  expect(Math.max(...asleep.map((l) => Number(l.end)))).toBeLessThanOrEqual(15_000);
  // Awake again, it floats as before.
  await page.mouse.move(300, 200, { steps: 4 });
  await page.clock.runFor(200);
  await expect(pet).not.toHaveAttribute("data-mood", "sleeping");
  expect((await loops()).find((l) => l.name === "pet-float")?.iterations).toBe(Infinity);
});

test("the pointer ghost settles soon after the pointer stops, and neither moves nor floats by a page layout", async ({ page }) => {
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
  expect(await frames(page), "frames asked for after the pointer stops").toBeLessThan(600);
  expect(await pet.boundingBox(), "the ghost has moved").not.toEqual(before);
  await expect(pet).toHaveAttribute("data-mood", "sleeping");

  // It moves by a compositor transform: left/top would lay the page out again at every frame.
  const style = await pet.evaluate((el) => ({ left: (el as HTMLElement).style.left, top: (el as HTMLElement).style.top }));
  expect(style).toEqual({ left: "", top: "" });
  // Its loops (the float, the z's) run on HTML boxes: a CSS animation on an SVG element lays the page out at every
  // frame for as long as the ghost is on screen.
  const loops = await pet.evaluate((el) =>
    el.getAnimations({ subtree: true }).map((a) => {
      const target = (a.effect as KeyframeEffect).target!;
      return `${target.nodeName} ${target instanceof SVGElement ? "svg" : "html"}`;
    }),
  );
  expect(loops.length, "the sleeping ghost's loops").toBeGreaterThan(0);
  expect(loops.filter((l) => l.endsWith("svg")), "loops on an SVG element").toEqual([]);
});
