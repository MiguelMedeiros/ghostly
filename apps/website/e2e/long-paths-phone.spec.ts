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

/**
 * The "On this page" list of a WISP whose headings name a source file (Cache (packages/browser/src/engine/...ts)): its
 * longest path set the width of every entry, so below 375 px they ran past the box's border and off the screen.
 */
for (const width of [320, 344, 360]) {
  test(`/wisps/public-profiles: the 'On this page' entries wrap inside their box at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/wisps/public-profiles");
    const past = await page.locator(".reader-toc").evaluate((box) => {
      const style = getComputedStyle(box);
      const inner = box.getBoundingClientRect().right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
      return [...box.querySelectorAll("li")].filter((li) => {
        const range = document.createRange();
        range.selectNodeContents(li);
        return range.getBoundingClientRect().right > inner + 0.5;
      }).map((li) => (li.textContent ?? "").trim());
    });
    expect(past).toEqual([]);
  });
}
