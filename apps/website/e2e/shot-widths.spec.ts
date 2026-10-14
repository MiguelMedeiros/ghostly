import { expect, test, type Page } from "@playwright/test";
import widths from "../lib/shot-widths.json";

/**
 * The app screenshots (public/screenshots/current) are captures 2560 wide, 780 on a phone, and a page draws them much
 * smaller: a window 901 wide and a phone 133 wide on the home page at 1280. Each has narrower copies and a `srcset`
 * with `sizes`, so a browser loads the narrowest file that is still sharp at the width it draws, for its screen's
 * pixel density: no blurred picture, and no file a size up for nothing.
 */

type Shot = { name: string; drawn: number; bytes: number };

/** Every screenshot the page shows, loaded: the file the browser chose, its weight and the width it is drawn at. */
async function shots(page: Page, path: string): Promise<Shot[]> {
  await page.goto(path, { waitUntil: "networkidle" });
  return page.evaluate(async () => {
    const out: Shot[] = [];
    for (const img of document.querySelectorAll<HTMLImageElement>('img[src^="/screenshots/current/"]')) {
      if (!img.getClientRects().length) continue; // the window a phone layout leaves out, or the phone a row has none of
      // They load lazily: bring each one into view and wait for it.
      img.scrollIntoView({ block: "center", behavior: "instant" });
      while (!img.complete || !img.naturalWidth) await new Promise((done) => setTimeout(done, 50));
      const box = img.getBoundingClientRect();
      // A picture that covers its box is drawn wider than the box when the box is the narrower shape.
      const cover = getComputedStyle(img).objectFit === "cover";
      const drawn = cover ? Math.max(box.width, (box.height * img.naturalWidth) / img.naturalHeight) : box.width;
      const entry = performance.getEntriesByName(img.currentSrc)[0] as PerformanceResourceTiming | undefined;
      out.push({ name: new URL(img.currentSrc).pathname.split("/").pop()!, drawn, bytes: entry?.encodedBodySize ?? 0 });
    }
    return out;
  });
}

/** A file's width: a copy's name ends in it (chat-1280.webp), and a capture is the widest of its kind. */
function widthOf(name: string): number {
  const list = name.includes("-mobile") ? widths.phone : widths.desktop;
  return Number(/-(\d+)\.webp$/.exec(name)?.[1] ?? Math.max(...list));
}

/** The narrowest file that is sharp enough is the one loaded, give or take 5% of the drawn width. */
function expectFit(shot: Shot, scale: number) {
  const list = shot.name.includes("-mobile") ? widths.phone : widths.desktop;
  const width = widthOf(shot.name);
  const needed = shot.drawn * scale;
  const label = `${shot.name}: ${width} wide, drawn at ${Math.round(shot.drawn)} on a ${scale}× screen`;
  expect(list, label).toContain(width);
  if (width < Math.max(...list)) expect(width, `${label} (blurred)`).toBeGreaterThanOrEqual(needed * 0.95);
  const narrower = list[list.indexOf(width) - 1];
  if (narrower) expect(narrower, `${label} (${narrower} was enough)`).toBeLessThan(needed * 1.05);
}

const PAGES = [
  { path: "/", count: 17 },
  { path: "/developers/agents", count: 2 },
];

for (const scale of [1, 2]) {
  for (const { path, count } of PAGES) {
    test.describe(() => {
      test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: scale });
      test(`${path} on a ${scale}× screen: each screenshot is the narrowest file that is sharp`, async ({ page }) => {
        const found = await shots(page, path);
        expect(found).toHaveLength(count);
        for (const shot of found) expectFit(shot, scale);
      });
    });
  }
}

test.describe(() => {
  test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  test("the home page's screenshots weigh under 600 KB at 1280", async ({ page }) => {
    const found = await shots(page, "/");
    expect(found.every((shot) => shot.bytes > 0)).toBe(true);
    expect(found.reduce((sum, shot) => sum + shot.bytes, 0)).toBeLessThan(600_000);
  });
});

test.describe(() => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  test("a phone gets the phone screenshots whole, as captured", async ({ page }) => {
    const found = await shots(page, "/");
    const phones = found.filter((shot) => shot.name.includes("-mobile"));
    expect(phones).toHaveLength(8);
    for (const shot of phones) expect(widthOf(shot.name), shot.name).toBe(780);
    for (const shot of found) expectFit(shot, 3);
  });
});
