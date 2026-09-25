import { expect, test, type Page } from "@playwright/test";
import { measure, settleKey, type Shot, type Rect } from "./scene-measure";

/**
 * The home story's pictures never sit on their copy. For every chapter drawn by
 * SceneFrame, at every step, nothing of the picture (its shapes, labels and
 * the act's two ghosts) may intersect the copy block: the eyebrow, the step's
 * title and body, the progress dashes and the buttons. The ghosts must also
 * stay whole on screen, below the nav. Upright windows run the film too, with
 * the copy in a band across the bottom. On narrow windows the chapters become
 * an article (picture, then copy), which is checked the same way.
 */

const CHAPTERS = ["invite", "dht", "agree", "alive", "open"] as const;
const WIDTHS = [320, 390, 768, 1024, 1280, 1440, 1920];
// Portrait 3:4, and landscape 16:10, 16:9 and 4:3 (the shape that crops the stage the most).
const SHAPES: { name: string; h: (w: number) => number }[] = [
  { name: "portrait", h: (w) => Math.round((w * 4) / 3) },
  { name: "landscape", h: (w) => Math.round((w * 10) / 16) },
  { name: "landscape-16x9", h: (w) => Math.round((w * 9) / 16) },
  { name: "landscape-4x3", h: (w) => Math.round((w * 3) / 4) },
];
/** Where to stop inside each step: mid-beat and on the finished picture. */
const STOPS = [0.5, 0.92];
/** Minimum clear space between the picture and the copy, in CSS px. */
const GAP = 8;

const overlap = (a: Rect, b: Rect, gap: number) => a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
const fmt = (r: Rect) => `[${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}×${Math.round(r.h)}]`;

/**
 * Scroll the pinned chapter to a point of its progress and wait for the picture to settle. The page
 * scrolls smoothly (`scroll-behavior: smooth`), so a plain scrollTo animates, and a picture measured
 * mid-scroll can belong to a chapter that is not pinned yet: jump instantly, and only count the
 * picture as settled once the page is where it was sent.
 */
async function scrollChapter(page: Page, id: string, p: number) {
  const go = () =>
    page.evaluate(
      ([id, p]) => {
        const el = document.getElementById(id as string)!;
        const target = Math.round(el.getBoundingClientRect().top + scrollY + (el.offsetHeight - innerHeight) * (p as number));
        if (Math.abs(target - scrollY) > 1) scrollTo({ top: target, behavior: "instant" });
        return Math.abs(target - scrollY) <= 1;
      },
      [id, p] as const,
    );
  let last = "";
  for (let i = 0; i < 60; i++) {
    const there = await go();
    await page.waitForTimeout(100);
    const now = await page.evaluate(settleKey, id);
    if (there && now === last) return;
    last = now;
  }
  throw new Error(`${id} at ${p}: the page did not settle where it was sent`);
}

function problems(f: Shot, where: string): string[] {
  const out: string[] = [];
  if (f.mode === "cards") {
    const figures = f.art.filter((a) => a.what.startsWith("figure"));
    const copy = f.art.filter((a) => a.what === "copy");
    for (const fig of figures) for (const c of copy) if (overlap(fig.rect, c.rect, 0)) out.push(`${where}: ${fig.what} ${fmt(fig.rect)} overlaps copy ${fmt(c.rect)}`);
    return out;
  }
  if (!f.copy) return [`${where}: no copy measured`];
  const over = f.art.filter((a) => overlap(a.rect, f.copy!, GAP));
  if (over.length) out.push(`${where}: ${over.length} shape(s) on the copy ${fmt(f.copy)}, e.g. ${over.slice(0, 3).map((a) => `${a.what} ${fmt(a.rect)}`).join(", ")}`);
  for (const g of f.ghosts) {
    const r = g.rect;
    if (r.x < -1 || r.x + r.w > f.vw + 1 || r.y < f.nav - 1 || r.y + r.h > f.vh + 1) out.push(`${where}: ${g.what} ${fmt(r)} is cut by the screen edge or the nav`);
  }
  return out;
}

// A film viewport scrolls through every step of five chapters.
test.describe.configure({ timeout: 240_000 });

const VIEWPORTS = [
  ...SHAPES.flatMap((shape) => WIDTHS.map((w) => ({ w, h: shape.h(w), name: shape.name }))),
  { w: 1000, h: 800, name: "the window the overlap was reported from" },
  { w: 1009, h: 1239, name: "the app's browser panel, upright" },
  { w: 900, h: 1200, name: "upright" },
];

for (const { w, h, name } of VIEWPORTS) {
  test(`home story: no picture on the copy at ${w}×${h} (${name})`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/", { waitUntil: "networkidle" });
    const found: string[] = [];
    for (const id of CHAPTERS) {
      const staticMode = await page.locator(`#${id}.scene--static`).count();
      if (staticMode) {
        await page.locator(`#${id}`).scrollIntoViewIfNeeded();
        found.push(...problems(await page.evaluate(measure, id), `${id}`));
        continue;
      }
      const n = await page.locator(`#${id} .scene-step`).count();
      for (let i = 0; i < n; i++) {
        for (const f of STOPS) {
          const p = 0.06 + ((i + f) / n) * 0.88;
          await scrollChapter(page, id, p);
          found.push(...problems(await page.evaluate(measure, id), `${id} step ${i + 1} at ${f}`));
        }
      }
    }
    expect(found, found.join("\n")).toEqual([]);
  });
}
