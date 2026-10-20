import { expect, test } from "@playwright/test";

/**
 * The end of every page has the footer on screen, and its sleeping ghost with it. At rest it lays nothing out: a
 * hem morphed at every frame (SMIL on `d`) laid out and repainted the whole page 60 times a second for as long as
 * the reader stayed there, and the longer the page above, the dearer each frame. Measured with no pointer, so the
 * pointer ghost stays out of it.
 */
for (const path of ["/wisps/1200-marketplace", "/privacy"]) {
  test(`the end of ${path} lays nothing out at rest`, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const sleeper = page.locator("footer .footer-sleeper");
    await expect(sleeper).toBeInViewport();
    await expect(sleeper).not.toHaveAttribute("data-offscreen");
    // Let the scroll, the observers and the fonts settle.
    await page.waitForTimeout(2_000);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const layouts = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "LayoutCount")!.value;
    const before = await layouts();
    await page.waitForTimeout(3_000);
    expect((await layouts()) - before, "layouts in 3 s at rest").toBeLessThanOrEqual(3);
  });
}

/**
 * Nor does it restyle anything once its z's have rested: looped forever, they recalculated styles 15 times a second
 * on the main thread (24 ms a second on a phone, over 100 on a slow one). They rise a few times and rest on a still
 * frame, like an awake ghost's hem. On a phone, as measured: there the pointer ghost (and its own z's) stays home.
 * The footer's particles are stilled for the count: they run on the compositor where there is a GPU (~0 ms a second
 * once the z's rest), but restart on the main thread in a headless browser without one.
 */
test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 760 }, isMobile: true, hasTouch: true });

  test("the sleeper's z's rest, and the end of a page restyles nothing", async ({ page }) => {
    await page.goto("/wisps/1200-marketplace", { waitUntil: "networkidle" });
    await page.addStyleTag({ content: ".particles span { animation: none !important; }" });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const sleeper = page.locator("footer .footer-sleeper");
    await expect(sleeper).toBeInViewport();
    await expect(sleeper).not.toHaveAttribute("data-offscreen");
    const zs = sleeper.locator(".zzz span");
    await expect(zs).toHaveCount(3);

    // They do move first, then rest.
    expect(await zs.first().evaluate((el) => el.getAnimations().map((a) => a.playState))).toContain("running");
    const running = () =>
      sleeper.evaluate((el) => [...el.querySelectorAll("*")].flatMap((e) => e.getAnimations()).filter((a) => a.playState === "running").length);
    await expect.poll(running, { timeout: 15_000 }).toBe(0);
    // At rest they read as z's, not faded out.
    expect(await zs.evaluateAll((els) => els.map((el) => getComputedStyle(el).opacity))).toEqual(["1", "1", "1"]);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const styles = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "RecalcStyleCount")!.value;
    const before = await styles();
    await page.waitForTimeout(3_000);
    expect((await styles()) - before, "style recalcs in 3 s at rest").toBeLessThanOrEqual(1);
  });
});
