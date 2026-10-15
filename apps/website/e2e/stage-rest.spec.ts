import { expect, test } from "@playwright/test";

/**
 * The first screen of the pages with ghosts on stage settles once its entrance is over: a ghost's hem stirs a few
 * times when it appears and then rests. A hem morphed for good (SMIL on `d`) laid out and restyled the whole page at
 * every frame for as long as the reader stayed at the top (93-110 ms of main thread a second at 375 px, 362 ms on a 4x
 * slower phone). Measured with no pointer, so the pointer ghost stays out of it, and with the CSS loops stopped (the
 * blink, the bob, a talking mouth, the act's drift), so only the hem is measured.
 */
for (const width of [375, 1280]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: width < 800 ? 760 : 900 } });

    for (const path of ["/", "/roadmap", "/developers/agents"]) {
      test(`the top of ${path} lays nothing out once its ghosts have settled`, async ({ page }) => {
        await page.goto(path, { waitUntil: "networkidle" });
        await expect(page.locator("svg.ghost").first()).toBeVisible();
        await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; }" });
        // The entrance and the hem's three stirs (3.2 s each), plus the fonts and the observers.
        await page.waitForTimeout(12_000);

        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Performance.enable");
        const layouts = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "LayoutCount")!.value;
        const before = await layouts();
        await page.waitForTimeout(3_000);
        expect((await layouts()) - before, "layouts in 3 s at rest").toBeLessThanOrEqual(3);
      });
    }
  });
}
