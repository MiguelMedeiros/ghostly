import { expect, test, type Page } from "@playwright/test";

/**
 * The story follows the scroll at any speed (lib/playhead.ts). On a landscape
 * window and on an upright one (the app's browser panel):
 * - a fast flick through the invitation still shows each step it crossed, in
 *   order, each for a moment, and catches up within a couple of seconds;
 * - a stop in the middle of a beat lands on the beat's finished picture, the
 *   same one a reader sees stopping after it;
 * - scrolling back up into a beat and stopping takes it back to its start;
 * - a jump (a link, the rail) is taken at once, without replaying the story.
 * The scroll is written with behavior "instant": the site's smooth scrolling would
 * otherwise animate it.
 */

const SIZES = [
  { w: 1440, h: 900 },
  { w: 1009, h: 1239 },
];

/** Where the invitation's step i at fraction f sits on the page (the scroll top that shows it). */
const invitationAt = (page: Page, i: number, f: number) =>
  page.evaluate(
    ([i, f]) => {
      const el = document.getElementById("invite")!;
      const n = el.querySelectorAll(".scene-step").length;
      const p = 0.06 + ((i + f) / n) * 0.88;
      return Math.round(el.getBoundingClientRect().top + scrollY + (el.offsetHeight - innerHeight) * p);
    },
    [i, f] as const,
  );

/**
 * The picture as drawn now: the actors' and the invitation's inline motion styles, and the step on screen. The
 * key light and the camera that carries it follow the focal point, which may still drift in a step's settle:
 * they are left out.
 */
const picture = (page: Page) =>
  page.evaluate(() => {
    const els = [...document.querySelectorAll("#act-1 .actor, #invite .scene-visual [style], #invite .scene-step")].filter(
      (e) => !e.matches(".key-light") && !e.querySelector(":scope > .key-light"),
    );
    // cssText, not the attribute: motion writes the same style with different spacing before and after it first updates.
    return els.map((e) => `${(e as HTMLElement).style.cssText}|${(e as HTMLElement).dataset?.active ?? ""}`).join("\n");
  });

/** Where two pictures differ by more than 3px (or 0.03 of an opacity or a scale). */
function differences(a: string, b: string): string[] {
  const num = /-?\d+\.?\d*(e-?\d+)?/g;
  const la = a.split("\n");
  const lb = b.split("\n");
  if (la.length !== lb.length) return [`${la.length} elements vs ${lb.length}`];
  const out: string[] = [];
  la.forEach((x, i) => {
    const y = lb[i];
    const nx = (x.match(num) ?? []).map(Number);
    const ny = (y.match(num) ?? []).map(Number);
    const far = nx.length !== ny.length || nx.some((v, j) => Math.abs(v - ny[j]) > (Math.abs(v) <= 1.5 && Math.abs(ny[j]) <= 1.5 ? 0.03 : 3));
    if (x.replace(num, "#") !== y.replace(num, "#") || far) out.push(`${x}\n   vs ${y}`);
  });
  return out;
}

/** Wait until the picture stops changing (the ghosts' idle bob is CSS, not inline, so it does not count). */
async function settled(page: Page) {
  let last = "";
  for (let i = 0; i < 80; i++) {
    await page.waitForTimeout(150);
    const now = await picture(page);
    if (last && differences(now, last).length === 0) return now;
    last = now;
  }
  throw new Error("the story never settled");
}

async function goTo(page: Page, y: number) {
  await page.evaluate((y) => scrollTo({ top: y, behavior: "instant" }), y);
  await expect.poll(() => page.evaluate(() => Math.round(scrollY))).toBe(y);
}

for (const { w, h } of SIZES) {
  test.describe(`at ${w}×${h}`, () => {
    test.use({ viewport: { width: w, height: h } });

    test.beforeEach(async ({ page }) => {
      await page.goto("/", { waitUntil: "networkidle" });
      await expect(page.locator("#invite:not(.scene--static)")).toHaveCount(1);
    });

    test("a fast flick still shows every step it crosses, in order, and catches up", async ({ page }) => {
      await goTo(page, await invitationAt(page, 0, 0));
      await settled(page);
      const to = await invitationAt(page, 2, 0.5);
      // A trackpad fling: most of the way in 0.3 s, done in about a second. Sample the step on screen every frame.
      const seen = await page.evaluate(
        (to) =>
          new Promise<{ t: number; step: number }[]>((res) => {
            const from = scrollY;
            const steps = [...document.querySelectorAll("#invite .scene-step")] as HTMLElement[];
            const out: { t: number; step: number }[] = [];
            const t0 = performance.now();
            const tick = (now: number) => {
              const t = (now - t0) / 1000;
              if (t < 1.2) scrollTo({ top: from + (to - from) * Math.min(1, (1 - Math.exp(-t / 0.3)) / 0.98), behavior: "instant" });
              out.push({ t, step: steps.findIndex((s) => s.dataset.active === "true") });
              if (t < 4) requestAnimationFrame(tick);
              else res(out);
            };
            requestAnimationFrame(tick);
          }),
        to,
      );
      // The steps shown, in order, and for how long each.
      const runs: { step: number; from: number; to: number }[] = [];
      for (const s of seen) {
        const last = runs[runs.length - 1];
        if (last && last.step === s.step) last.to = s.t;
        else runs.push({ step: s.step, from: s.t, to: s.t });
      }
      expect(runs.map((r) => r.step), "the steps shown during the flick").toEqual([0, 1, 2]);
      const middle = runs[1];
      expect(middle.to - middle.from, "the step the flick crossed was on screen for a moment").toBeGreaterThan(0.3);
      // Caught up: the last step arrived within a couple of seconds of the flick.
      expect(runs[2].from, "the catch-up took too long").toBeLessThan(3);
    });

    test("a stop in the middle of a beat lands on its finished picture", async ({ page }) => {
      await goTo(page, await invitationAt(page, 1, 0.92));
      const finished = await settled(page);
      await goTo(page, await invitationAt(page, 0, 0.92));
      await settled(page);
      // Scroll down into the middle of step 2's beat and stop there.
      await goTo(page, await invitationAt(page, 1, 0.45));
      expect(differences(await settled(page), finished), "a stop mid-beat left a half-drawn picture").toEqual([]);
    });

    test("scrolling back up into a beat and stopping takes it back to its start", async ({ page }) => {
      // The start of step 2, before its beat: its copy is up, its picture not yet moving.
      await goTo(page, await invitationAt(page, 1, 0.02));
      const start = await settled(page);
      await goTo(page, await invitationAt(page, 1, 0.92));
      await settled(page);
      await goTo(page, await invitationAt(page, 1, 0.45));
      expect(differences(await settled(page), start), "going up, a stop mid-beat did not rewind it").toEqual([]);
    });

    test("a jump is taken at once, without replaying the story", async ({ page }) => {
      await settled(page);
      const target = await page.evaluate(() => {
        const el = document.getElementById("dht")!;
        return Math.round(el.getBoundingClientRect().top + scrollY + (el.offsetHeight - innerHeight) * 0.5);
      });
      const steps = await page.evaluate(
        (target) =>
          new Promise<number[]>((res) => {
            const invite = [...document.querySelectorAll("#invite .scene-step")] as HTMLElement[];
            const shown = new Set<number>();
            scrollTo({ top: target, behavior: "instant" });
            const t0 = performance.now();
            const tick = (now: number) => {
              shown.add(invite.findIndex((s) => s.dataset.active === "true"));
              if (now - t0 < 1200) requestAnimationFrame(tick);
              else res([...shown]);
            };
            requestAnimationFrame(tick);
          }),
        target,
      );
      // The invitation goes from its first step to its last in one frame: the story did not run through it.
      expect(steps, "the invitation replayed during a jump").not.toContain(1);
      await expect(page.locator('#dht .scene-step[data-active="true"]')).toHaveCount(1);
    });
  });
}
