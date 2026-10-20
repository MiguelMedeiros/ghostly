import { expect, test } from "@playwright/test";

/**
 * A link that names a section, opened fresh (ghostly.tools/#download from a README or a chat, a WISP's #section),
 * opens the page at that section. The site scrolls smoothly, and that smoothing took the browser's own jump to the
 * section on load and LandOnHash's re-landing too: the page flew 0 → 27,131 px through the whole home in 1.8 s,
 * 0 → 70,595 px through a WISP. Smooth scrolling starts with the reader's first touch, click, key or wheel.
 */

type Frame = { y: number; top: number | null };

declare global {
  interface Window {
    __frames: Frame[];
  }
}

const LINKS = ["/#download", "/#wallets", "/wisps/1200-marketplace#revision-log"] as const;

for (const link of LINKS) {
  test(`${link} opened fresh opens at the section, without a flight through the page`, async ({ page }) => {
    // Every frame from the first one: where the page is, and where the section is on the screen.
    await page.addInitScript(() => {
      window.__frames = [];
      const id = decodeURIComponent(location.hash.slice(1));
      const start = performance.now();
      const frame = () => {
        const el = document.getElementById(id);
        window.__frames.push({ y: Math.round(scrollY), top: el ? Math.round(el.getBoundingClientRect().top) : null });
        if (performance.now() - start < 4000) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(link, { waitUntil: "load" });
    const id = decodeURIComponent(new URL(link, "http://x").hash.slice(1));
    await expect(page.locator(`[id="${id}"]`)).toHaveCount(1);
    await page.waitForFunction(() => window.__frames.length > 0 && performance.now() > 4500, null, { timeout: 15_000 });
    const frames = await page.evaluate(() => window.__frames);
    const height = page.viewportSize()!.height;
    // In flight: off the top of the page, and the section is not at the screen's top. A change of height above the
    // section can show it off by a frame before LandOnHash lands again; a flight is dozens of frames.
    const flying = frames.filter((f) => f.y > 0 && f.top !== null && Math.abs(f.top) > height / 2);
    expect(flying.length, `frames in flight: ${flying.slice(0, 12).map((f) => `${f.y}:${f.top}`).join(" ")}`).toBeLessThanOrEqual(3);
    // And it got there: the section is under the bar.
    const last = frames.at(-1)!;
    expect(last.top, "section top at the end").not.toBeNull();
    expect(Math.abs(last.top!)).toBeLessThan(height / 2);
  });
}

test("the page scrolls smoothly once the reader has touched it", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/#download", { waitUntil: "load" });
  const behavior = () => page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior);
  expect(await behavior()).toBe("auto");
  await page.evaluate(() => window.dispatchEvent(new Event("pointerdown")));
  expect(await behavior()).toBe("smooth");
});
