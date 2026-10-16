import { expect, test, type Page } from "@playwright/test";

/**
 * While the protocol explainer plays a step, a frame restyles only the shapes the step changes. The clock wrote `--t`
 * on the whole section at every frame, and `--t` inherits, so every frame restyled every element of the explainer
 * (about 900: the 355 shapes of the scene, the copy cards, the controls): 21 frames a second on a 4x slower CPU, the
 * main thread busy for the whole step. Counted from Chrome's trace: the elements each style update touched.
 */
const END = [2.6, 5];

const tValue = (page: Page) => page.locator(".psx").evaluate((el) => Number(getComputedStyle(el).getPropertyValue("--t")));

for (const width of [390, 1280]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: width < 800 ? 844 : 900 } });

    test("a frame of a playing step restyles only the shapes it changes", async ({ page }) => {
      await page.goto("/developers", { waitUntil: "networkidle" });
      const root = page.locator(".psx");
      await root.scrollIntoViewIfNeeded();
      // The first step plays by itself and settles; the next one is what is measured.
      await expect.poll(() => tValue(page), { timeout: 10_000 }).toBe(END[0]);

      const cdp = await page.context().newCDPSession(page);
      const events: { name: string; args?: { elementCount?: number } }[] = [];
      cdp.on("Tracing.dataCollected", (e) => events.push(...(e.value as typeof events)));
      const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
      await cdp.send("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline"] } });
      await root.locator('[data-action="next"]').click();
      // Step 2 plays from 2.6 to 5 at one timeline second a second.
      await page.waitForTimeout(2_000);
      await cdp.send("Tracing.end");
      await done;
      await expect.poll(() => tValue(page), { timeout: 8_000 }).toBe(END[1]);

      const counts = events
        .filter((e) => e.name === "UpdateLayoutTree" && (e.args?.elementCount ?? 0) > 0)
        .map((e) => e.args!.elementCount!)
        .sort((a, b) => a - b);
      expect(counts.length, "style updates while the step plays").toBeGreaterThan(20);
      const median = counts[Math.floor(counts.length / 2)];
      expect(median, `elements restyled per frame (median of ${counts.length}, max ${counts.at(-1)})`).toBeLessThanOrEqual(150);
    });
  });
}
