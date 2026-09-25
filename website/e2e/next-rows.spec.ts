import { expect, test } from "@playwright/test";

/**
 * "What happens next" (05): one row per thing the app does. From 1024px a row's words and screens stand side by
 * side, centred on each other, sides alternating down the page; below that they stack, words first. Either way the
 * rows follow each other with no empty stretch between them (the old sticky column left one under its pictures),
 * and nothing is wider than the window.
 */

type Row = { id: string; copy: DOMRectJSON; media: DOMRectJSON };
type DOMRectJSON = { left: number; right: number; top: number; bottom: number };

const SIZES = [
  { width: 1440, height: 900, sideBySide: true },
  { width: 1100, height: 800, sideBySide: true },
  { width: 900, height: 1100, sideBySide: false },
  { width: 390, height: 844, sideBySide: false, phone: true },
];

for (const { width, height, sideBySide, phone } of SIZES) {
  test.describe(() => {
    test.use({ viewport: { width, height }, isMobile: !!phone, hasTouch: !!phone });
    test(`What happens next: rows at ${width}×${height}`, async ({ page }) => {
      await page.goto("/", { waitUntil: "networkidle" });
      // Walk down the section so every row has faded in (Reveal) and its pictures have loaded.
      const { top, h } = await page.evaluate(() => {
        const r = document.getElementById("next")!.getBoundingClientRect();
        return { top: r.top + scrollY, h: r.height };
      });
      for (let y = top; y < top + h; y += 400) {
        // A frame at every stop: intersection observers only see positions that were drawn.
        await page.evaluate((y) => {
          scrollTo({ top: y, behavior: "instant" });
          return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        }, y);
      }
      await expect(page.locator('#next .nx-item[data-reveal="hidden"]')).toHaveCount(0);
      await page.waitForTimeout(700); // the last row's fade-in transition

      const rows: Row[] = await page.evaluate(() =>
        [...document.querySelectorAll("#next .nx-item")].map((li) => {
          const r = (sel: string) => {
            const b = li.querySelector(sel)!.getBoundingClientRect();
            return { left: b.left, right: b.right, top: b.top + scrollY, bottom: b.bottom + scrollY };
          };
          return { id: li.id, copy: r(".nx-copy"), media: r(".nx-row-media") };
        }),
      );
      expect(rows.length).toBeGreaterThan(5);
      const found: string[] = [];
      const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      if (pageWidth > width) found.push(`the page is ${pageWidth}px wide in a ${width}px window`);

      rows.forEach((row, i) => {
        for (const part of [row.copy, row.media]) if (part.left < -1 || part.right > width + 1) found.push(`${row.id} runs off the window (${Math.round(part.left)}..${Math.round(part.right)})`);
        const mid = (b: DOMRectJSON) => (b.top + b.bottom) / 2;
        if (sideBySide) {
          const mediaRight = i % 2 === 0;
          const [l, r] = mediaRight ? [row.copy, row.media] : [row.media, row.copy];
          if (l.right > r.left) found.push(`${row.id}: words and screens overlap or are on the wrong sides`);
          if (Math.abs(mid(row.copy) - mid(row.media)) > 24) found.push(`${row.id}: words centred ${Math.round(mid(row.copy) - mid(row.media))}px off the screens`);
        } else if (row.copy.bottom > row.media.top + 1) found.push(`${row.id}: the words should come before the screens`);
        const next = rows[i + 1];
        if (next) {
          const gap = Math.min(next.copy.top, next.media.top) - Math.max(row.copy.bottom, row.media.bottom);
          if (gap > 200) found.push(`${gap}px of empty page between ${row.id} and ${next.id}`);
        }
      });
      expect(found, found.join("\n")).toEqual([]);
    });
  });
}
