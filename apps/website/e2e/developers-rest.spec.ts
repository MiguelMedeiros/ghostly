import { expect, test } from "@playwright/test";

/**
 * The first screen of /developers settles once the protocol explainer's first step has played: its ghosts float and
 * blink a few times and rest, and the connecting line's dashes march only while a step plays. Looped for good, those
 * three CSS animations on shapes inside the scene's SVG laid out the page 60 times a second for as long as the reader
 * stayed at the top (63-81 ms of main thread a second at 375 px, 283 ms on a 4x slower phone). Measured with no
 * pointer, so the pointer ghost stays out of it.
 */
for (const width of [375, 1280]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: width < 800 ? 760 : 900 } });

    test("the top of /developers lays nothing out once its scene has settled", async ({ page }) => {
      await page.goto("/developers", { waitUntil: "networkidle" });
      const scene = page.locator(".psx");
      await expect(scene).toBeInViewport();

      // The ghosts do move first, then rest: the first step (2.6 s), three floats (10.2 s), two blinks (10.4 s).
      const running = () =>
        scene.evaluate((el) => [...el.querySelectorAll("*")].flatMap((e) => e.getAnimations()).filter((a) => a.playState === "running").length);
      expect(await running()).toBeGreaterThan(0);
      await expect.poll(running, { timeout: 20_000 }).toBe(0);

      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Performance.enable");
      const layouts = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "LayoutCount")!.value;
      const before = await layouts();
      await page.waitForTimeout(3_000);
      expect((await layouts()) - before, "layouts in 3 s at rest").toBeLessThanOrEqual(3);
    });
  });
}
