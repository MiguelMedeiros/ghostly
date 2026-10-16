import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The home's story stages and the top of /roadmap settle once their ghosts have bobbed, blinked and talked a few times
 * and the network's nodes have twinkled: looped for good, those CSS animations on shapes inside the stages' SVGs laid
 * out the page 15 to 52 times a second for as long as the reader looked (35 ms of main thread a second on the home's
 * network stage at 1280 px, 149 ms on a 4x slower machine). Measured with no pointer, so the pointer ghost stays out
 * of it, as on /developers (developers-rest.spec.ts).
 */
test.use({ viewport: { width: 1280, height: 900 } });

const running = (root: Locator) =>
  root.evaluate((el) => [el, ...el.querySelectorAll("*")].flatMap((e) => e.getAnimations()).filter((a) => a.playState === "running").length);

async function layoutsAtRest(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const layouts = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "LayoutCount")!.value;
  const before = await layouts();
  await page.waitForTimeout(3_000);
  return (await layouts()) - before;
}

test("the home's network stage rests once its nodes and ghosts have settled", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  // The story may draw the stage again while the page settles: scrolled to until it holds.
  const stage = page.locator("svg.stage:has(.dht-node)").first();
  await expect(async () => {
    await stage.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await expect(stage).toBeInViewport();
  }).toPass();
  await expect(stage).not.toHaveAttribute("data-offscreen");

  // They do move first, then rest: three twinkles (12 s), three bobs (12.6 s), two blinks (10 s).
  expect(await running(stage)).toBeGreaterThan(0);
  await expect.poll(() => running(stage), { timeout: 25_000 }).toBe(0);
  // About 150 in 3 s while the loops ran; the few left at rest are the page's own, outside the stage.
  expect(await layoutsAtRest(page), "layouts in 3 s at rest").toBeLessThanOrEqual(10);
});

test("the top of /roadmap lays nothing out once its ghosts have settled", async ({ page }) => {
  await page.goto("/roadmap", { waitUntil: "networkidle" });
  const ghosts = page.locator("main");
  expect(await running(ghosts)).toBeGreaterThan(0);
  await expect.poll(() => running(ghosts), { timeout: 25_000 }).toBe(0);
  expect(await layoutsAtRest(page), "layouts in 3 s at rest").toBeLessThanOrEqual(3);
});
