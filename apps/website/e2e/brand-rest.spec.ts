import { expect, test } from "@playwright/test";

/**
 * /brand's specimens at rest: the row of ghost moods and the social-post mock. They lay nothing out while the reader
 * looks at them: each awake ghost morphed its hem (SMIL on `d`), and the row of 7 laid out and restyled the whole
 * page 120 times a second (189 ms of main thread a second at 375 px, 430 ms on a 4x slower phone). Measured with no
 * pointer, so the pointer ghost stays out of it.
 */
test.use({ viewport: { width: 375, height: 800 } });

for (const selector of [".br-moods", ".br-app-social-ghosts"]) {
  test(`/brand's ${selector} lays nothing out at rest`, async ({ page }) => {
    await page.goto("/brand", { waitUntil: "networkidle" });
    const specimen = page.locator(selector);
    await specimen.scrollIntoViewIfNeeded();
    await expect(specimen).toBeInViewport();
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
