import { expect, test, type Page } from "@playwright/test";

/**
 * The home story's cards keep their pictures whole. Touch devices wider than
 * 860px (a tablet in landscape), windows taller than wide (1024×1366) and
 * reduced motion read the story as cards: each step is a still in a 1.6
 * figure, pushed in on its chapter's picture. Every ghost body and every label
 * a still draws must sit inside its figure, once the step's beat has played.
 * (Phones and portrait tablets draw the portrait stage, which
 * `scene-overlap.spec.ts` checks with the copy.)
 */

const CHAPTERS = ["invite", "dht", "agree", "alive", "open"] as const;

type Rect = { x: number; y: number; w: number; h: number };
type Figure = { box: Rect; parts: { what: string; rect: Rect }[] };

/** Runs in the page: each figure of a chapter and what it draws that can be seen. */
function figures(id: string): Figure[] {
  const box = (r: DOMRect): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const opacity = (el: Element, stop: Element) => {
    let o = 1;
    for (let e: Element | null = el; e && e !== stop; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden") return 0;
      o *= Number(cs.opacity);
    }
    return o;
  };
  return [...document.querySelectorAll(`#${id} .scene-static-figure`)].map((f) => {
    const parts: Figure["parts"] = [];
    f.querySelectorAll("svg.ghost").forEach((g) => {
      const body = g.querySelector(".ghost-lean");
      if (body && opacity(g, f) >= 0.1) parts.push({ what: `ghost ${(g as SVGElement).style.getPropertyValue("--ghost")}`, rect: box(body.getBoundingClientRect()) });
    });
    f.querySelectorAll("text").forEach((t) => {
      if (t.closest("svg.ghost, defs, mask") || !t.textContent?.trim() || opacity(t, f) < 0.1) return;
      const r = t.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) parts.push({ what: `label "${t.textContent.trim().slice(0, 30)}"`, rect: box(r) });
    });
    return { box: box(f.getBoundingClientRect()), parts };
  });
}

const fmt = (r: Rect) => `[${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}×${Math.round(r.h)}]`;
const inside = (r: Rect, b: Rect) => r.x >= b.x - 1 && r.y >= b.y - 1 && r.x + r.w <= b.x + b.w + 1 && r.y + r.h <= b.y + b.h + 1;

/** Bring each still into view so its beat plays, then wait until nothing in the chapter moves. */
async function playChapter(page: Page, id: string) {
  const n = await page.locator(`#${id} .scene-static-figure`).count();
  for (let i = 0; i < n; i++) await page.locator(`#${id} .scene-static-figure`).nth(i).scrollIntoViewIfNeeded();
  let last = "";
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(150);
    // To 2px: the ghosts' idle bob never settles.
    const now = JSON.stringify(await page.evaluate(figures, id), (_, v) => (typeof v === "number" ? Math.round(v / 2) : v));
    if (now === last) return;
    last = now;
  }
}

const VIEWPORTS: { w: number; h: number; name: string; touch?: boolean; calm?: boolean }[] = [
  // Windows taller than wide, above 860px.
  { w: 1024, h: 1366, name: "upright tablet" },
  { w: 900, h: 1200, name: "upright" },
  { w: 1280, h: 1600, name: "upright" },
  // Touch devices in landscape.
  { w: 1024, h: 768, name: "tablet landscape", touch: true },
  { w: 1180, h: 820, name: "tablet landscape", touch: true },
  { w: 1366, h: 1024, name: "tablet landscape", touch: true },
  // Reduced motion draws the same stills on a desktop window.
  { w: 1440, h: 900, name: "reduced motion", calm: true },
];

for (const { w, h, name, touch, calm } of VIEWPORTS) {
  test.describe(() => {
    test.use({ viewport: { width: w, height: h }, hasTouch: !!touch, isMobile: false, reducedMotion: calm ? "reduce" : "no-preference" });
    test(`home story cards: every ghost and label inside its still at ${w}×${h} (${name})`, async ({ page }) => {
      await page.goto("/", { waitUntil: "networkidle" });
      await expect(page.locator(`#${CHAPTERS[0]}.scene--static`)).toHaveCount(1);
      const found: string[] = [];
      for (const id of CHAPTERS) {
        await playChapter(page, id);
        (await page.evaluate(figures, id)).forEach((f, i) => {
          for (const part of f.parts) if (!inside(part.rect, f.box)) found.push(`${id} step ${i + 1}: ${part.what} ${fmt(part.rect)} is cut by its figure ${fmt(f.box)}`);
        });
      }
      expect(found, found.join("\n")).toEqual([]);
    });
  });
}
