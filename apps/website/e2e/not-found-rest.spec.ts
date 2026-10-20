import { expect, test } from "@playwright/test";

/**
 * The "page not found" scene keeps playing, but on the compositor: once it has drawn, the page lays nothing out and
 * runs no script. A timer moved the ghost through React state 20 times a second, 25 floating ghosts were stepped by
 * script, and the beam, the blink and the ring turned SVG shapes (a CSS transform inside an SVG is not composited: it
 * restyles and lays out the page at every frame): 60 layouts a second and 235-588 ms of main thread a second on a 4x
 * slower phone, for as long as the page stayed open. Measured with no pointer.
 */
test.use({ viewport: { width: 375, height: 760 }, reducedMotion: "no-preference" });

test("the 404 page lays nothing out and runs no script at rest", async ({ page }) => {
  await page.goto("/no-such-page", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("404");
  // Let the floating ghosts mount and the fonts settle.
  await page.waitForTimeout(2_000);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const sample = async () => {
    const metrics = (await cdp.send("Performance.getMetrics")).metrics;
    const value = (name: string) => metrics.find((m) => m.name === name)!.value;
    return { layouts: value("LayoutCount"), script: value("ScriptDuration") };
  };
  const before = await sample();
  await page.waitForTimeout(3_000);
  const after = await sample();
  expect.soft(after.layouts - before.layouts, "layouts in 3 s at rest").toBeLessThanOrEqual(3);
  expect((after.script - before.script) * 1000, "ms of script in 3 s at rest").toBeLessThan(10);
});
