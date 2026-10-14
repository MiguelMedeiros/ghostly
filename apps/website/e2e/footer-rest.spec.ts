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
