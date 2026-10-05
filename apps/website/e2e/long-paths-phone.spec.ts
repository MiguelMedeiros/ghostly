import { expect, test } from "@playwright/test";

/**
 * A long source path (packages/browser/src/proofs/...) has nowhere to break, and on a 375 px phone it pushed the WISP
 * summary card and a roadmap candidate past the screen's edge. The page clips sideways scroll, so the text was cut off.
 */
for (const path of ["/wisps/306-bitcoin", "/roadmap"]) {
  test(`${path}: long paths wrap inside a 375 px phone`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(path);
    const past = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      // A wide table scrolls in a box of its own: that is by design, not text cut off.
      const scrolls = (el: Element) => { for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) if (/auto|scroll/.test(getComputedStyle(up).overflowX)) return true; return false; };
      return [...document.querySelectorAll("main *")].filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.right > width + 0.5 && !scrolls(el);
      }).map((el) => `${el.tagName.toLowerCase()}.${el.className} ${(el.textContent ?? "").trim().slice(0, 40)}`).slice(0, 5);
    });
    expect(past).toEqual([]);
  });
}
