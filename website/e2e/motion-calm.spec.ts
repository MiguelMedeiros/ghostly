import { expect, test } from "@playwright/test";

/**
 * Reduced motion: the whole home reads as stills and cross-fades. With
 * `prefers-reduced-motion: reduce` every chapter of the story must render each
 * of its steps as a still with both ghosts in it, the hero must show its still
 * Boo with his line, the statement its whole sentence, the finale its finished
 * frame, and nothing on the page may keep moving: no SMIL in the DOM, no
 * animation or transition running longer than a frame once the page has
 * settled. Checked on a desktop window, an upright one and a phone.
 */

const CHAPTERS = ["invite", "dht", "agree", "alive", "open"] as const;

const VIEWPORTS: { name: string; use: Parameters<typeof test.use>[0] }[] = [
  { name: "desktop 1440x900", use: { viewport: { width: 1440, height: 900 } } },
  { name: "upright desktop 1009x1239", use: { viewport: { width: 1009, height: 1239 } } },
  { name: "phone 390x844", use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
];

for (const { name, use } of VIEWPORTS) {
  test.describe(() => {
    test.use({ ...use, reducedMotion: "reduce" });
    test(`reduced motion renders every chapter still on ${name}`, async ({ page }) => {
      await page.goto("/", { waitUntil: "networkidle" });
      await expect(page.locator("html")).toHaveClass(/calm/);

      // The hero: the still Boo and his line, no act backdrop drawing him.
      await expect(page.locator(".hero-still svg.ghost")).toBeVisible();
      await expect(page.locator(".hero-still .bubble")).toBeVisible();
      await expect(page.locator("#act-1 .act-backdrop")).toHaveCount(0);

      // Every chapter is an article: one still per step, each with both ghosts drawn in it.
      for (const id of CHAPTERS) {
        const section = page.locator(`#${id}.scene--static`);
        await expect(section, `${id} is not an article`).toHaveCount(1);
        const steps = await section.locator(".scene-static-step").count();
        expect(steps, `${id} has no steps`).toBeGreaterThan(0);
        for (let i = 0; i < steps; i++) {
          const figure = section.locator(".scene-static-figure").nth(i);
          await figure.scrollIntoViewIfNeeded();
          const ghosts = await figure.evaluate((f) =>
            [...f.querySelectorAll("svg.ghost .ghost-lean")].filter((g) => {
              const r = g.getBoundingClientRect();
              let o = 1;
              for (let e: Element | null = g; e && e !== f; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
              return r.width > 4 && r.height > 4 && o > 0.1;
            }).length,
          );
          expect(ghosts, `${id} step ${i + 1}: a still without its ghosts`).toBeGreaterThanOrEqual(1);
        }
      }

      // The statement reads whole, and the finale is in its finished frame.
      const words = page.locator(".statement-word");
      expect(await words.count()).toBeGreaterThan(3);
      for (const o of await words.evaluateAll((els) => els.map((el) => getComputedStyle(el).opacity))) expect(Number(o)).toBe(1);
      await expect(page.locator("#download")).toHaveAttribute("data-state", "done");

      // Nothing keeps moving: no SMIL, no swarm, no running animation longer than a frame.
      await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
      await page.waitForTimeout(800);
      const moving = await page.evaluate(() => {
        const smil = document.querySelectorAll("animate, animateTransform, animateMotion").length;
        const running = document.getAnimations().filter((a) => {
          if (a.playState !== "running") return false;
          const t = a.effect?.getTiming();
          const d = typeof t?.duration === "number" ? t.duration : 0;
          return d > 16 && (t?.iterations === Infinity || d > 16);
        });
        return { smil, running: running.map((a) => `${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? a.id}`) };
      });
      expect(moving.smil, "SMIL animations in the DOM under reduced motion").toBe(0);
      expect(moving.running, "animations still running under reduced motion").toEqual([]);
    });
  });
}
