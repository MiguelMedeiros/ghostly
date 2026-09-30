import { expect, test, type Page } from "@playwright/test";

/**
 * The hero's two ways in stay put on a phone. A phone reads the story as cards (stage.tsx useCards), so nothing is
 * drawn over the hero's copy and there is no reason to fade it: a small scroll must leave both buttons fully opaque,
 * where they were, and tappable. Reduced motion gets no scroll fade anywhere.
 */

const VIEWPORTS: { name: string; use: Parameters<typeof test.use>[0] }[] = [
  { name: "phone 375x812", use: { viewport: { width: 375, height: 812 } } },
  { name: "phone 390x844", use: { viewport: { width: 390, height: 844 } } },
  { name: "narrow window 390x844 without touch", use: { viewport: { width: 390, height: 844 }, hasTouch: false, isMobile: false } },
  { name: "phone 390x844 with reduced motion", use: { viewport: { width: 390, height: 844 }, reducedMotion: "reduce" } },
];

/** Scroll without smoothing, then give the playhead (lib/playhead.ts) time to catch up with it. */
async function scrollBy(page: Page, top: number) {
  await page.evaluate((top) => scrollTo({ top, behavior: "instant" }), top);
  await page.waitForTimeout(1500);
}

/** The opacity a reader sees: the element's own times every ancestor's. */
function seenOpacity(el: Element) {
  let o = 1;
  for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
  return o;
}

for (const { name, use } of VIEWPORTS) {
  test.describe(() => {
    test.use(use);
    test(`${name}: a small scroll leaves the hero's buttons whole and tappable`, async ({ page }) => {
      // Every element the hero's buttons were ever drawn in. The server draws the live act; this window gets the still
      // one, and the act must keep its chapters mounted through that switch: a new element would drop the buttons out
      // of sight and rise them again, maybe after they were measured here (CI, 2026-09-30: "button 0 moved at 50px").
      await page.addInitScript(() => {
        const seen = new Set<Element>();
        (window as unknown as { heroActions: Set<Element> }).heroActions = seen;
        new MutationObserver(() => document.querySelectorAll(".hero-actions").forEach((el) => seen.add(el))).observe(document, { childList: true, subtree: true });
      });
      await page.goto("/", { waitUntil: "networkidle" });
      const actions = page.locator(".hero-actions");
      await actions.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      const buttons = actions.locator(".btn");
      await expect(buttons).toHaveCount(2);
      const before = await Promise.all((await buttons.all()).map(async (b) => (await b.boundingBox())!.y));

      for (const top of [50, 100, 150]) {
        await scrollBy(page, top);
        const all = await buttons.all();
        for (const [i, b] of all.entries()) {
          await expect(b).toBeVisible();
          expect(await b.evaluate(seenOpacity), `button ${i} at ${top}px`).toBe(1);
          // Where the scroll put it, no more: nothing slides it up.
          expect(Math.abs((await b.boundingBox())!.y - (before[i] - top)), `button ${i} moved at ${top}px`).toBeLessThanOrEqual(1);
          // The tap lands on the button itself, not on something over it.
          const hit = await b.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !!at && el.contains(at);
          });
          expect(hit, `button ${i} is covered at ${top}px`).toBe(true);
          await b.click({ trial: true });
        }
      }
      expect(await page.evaluate(() => (window as unknown as { heroActions: Set<Element> }).heroActions.size), "the hero's buttons were mounted again").toBe(1);
    });
  });
}
