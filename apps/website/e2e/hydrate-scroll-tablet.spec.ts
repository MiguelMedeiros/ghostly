import { expect, test } from "@playwright/test";
import { holdScripts } from "./hold-scripts";

/**
 * A tablet in landscape (wide, touch) reads the story as cards: before the page runs, each chapter's steps are a
 * folded list of a few lines each; once it hydrates, each step sits over its own picture. A reader who scrolled to a
 * step before that keeps it on screen, its title where it was, not the spot as far down the much taller list.
 */
test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: false });

for (const id of ["invite", "dht", "agree", "alive", "open"]) {
  test(`a tablet reader on a step of #${id} before hydration finds its title where it was after`, async ({ context, page: first }) => {
    test.setTimeout(120_000);
    // The film's steps, as the server draws them (the scripts never run on this page).
    await holdScripts(first);
    await first.goto("/", { waitUntil: "domcontentloaded" });
    const n = await first.locator(`#${id} .scene-step`).count();
    await first.close();
    expect(n).toBeGreaterThan(1);

    // A fresh page per step: the scripts are held once per load.
    for (let i = 0; i < n; i++) {
      const page = await context.newPage();
      const release = await holdScripts(page);
      await page.goto("/", { waitUntil: "commit" });
      await page.waitForFunction(() => performance.getEntriesByName("first-contentful-paint").length > 0 && !!document.getElementById("open"));
      expect(await page.evaluate(() => document.documentElement.dataset.touch !== undefined)).toBe(true);

      // The middle of the screen over step i's lines, in the folded list the server drew.
      const before = await page.evaluate(
        ({ id, i }) => {
          const step = document.querySelectorAll(`#${id} .scene-step`)[i];
          const r = step.getBoundingClientRect();
          scrollTo({ top: scrollY + r.top + r.height / 2 - innerHeight / 2, behavior: "instant" });
          const title = step.querySelector(".h-scene")!;
          return { text: title.textContent, top: Math.round(title.getBoundingClientRect().top) };
        },
        { id, i },
      );
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

      release();
      await expect(page.locator(`#${id}.scene--static`)).toHaveCount(1);
      await page.waitForLoadState("load");
      await page.waitForTimeout(1000);

      const after = await page.evaluate(
        ({ id, i }) => {
          const title = document.querySelectorAll(`#${id} .scene-static-copy > .h-scene`)[i];
          const r = title.getBoundingClientRect();
          return { text: title.textContent, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight };
        },
        { id, i },
      );
      expect(after.text).toBe(before.text);
      expect(after.top, `step ${i} "${before.text}": title top ${before.top} → ${after.top}`).toBeGreaterThanOrEqual(0);
      expect(after.bottom).toBeLessThanOrEqual(after.vh);
      expect(Math.abs(after.top - before.top), `step ${i} "${before.text}"`).toBeLessThanOrEqual(24);
      await page.close();
    }
  });
}
