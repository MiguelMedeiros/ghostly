import { expect, test, type Page } from "@playwright/test";

/**
 * Speech bubbles stay whole on screen: Boo's line in the hero (drawn in the
 * act backdrop on desktop, a still bubble on phones and touch screens) and the
 * finale's dialogue, at every width and in both languages. The bubble box
 * includes its tail. Boo himself, glow included, stays whole on screen and
 * clear of the copy at every aspect ratio. Each test sets its own viewport, so
 * it runs under the desktop project.
 */
type Box = { l: number; t: number; r: number; b: number };

const LOCALES = [
  { path: "/", line: "Is anyone out there?" },
  { path: "/pt-br", line: "Tem alguém aí?" },
];

// Widths from the review brief, each at a common height, squarish, tall, short and very wide
// desktop windows (the stage is cropped differently in each), plus two phones held sideways.
const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 800, height: 800 },
  { width: 900, height: 900 }, // the window Boo was cut in
  { width: 1000, height: 1000 },
  { width: 900, height: 1200 },
  { width: 1080, height: 1920 },
  { width: 1000, height: 800 }, // the window the bubble bug was reported from
  { width: 1024, height: 768 },
  { width: 1280, height: 600 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1080 },
  { width: 667, height: 375, touch: true },
  { width: 844, height: 390, touch: true },
];

const inside = (b: Box, w: number, h: number) => b.l >= 0 && b.t >= 0 && b.r <= w && b.b <= h;
const apart = (a: Box, b: Box) => a.r <= b.l || a.l >= b.r || a.b <= b.t || a.t >= b.b;

/** The hero bubble that is on screen, once its line is typed out. */
async function heroBubble(page: Page, line: string) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const shown = (el: Element | null) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;
          const act = document.querySelector(".act-bubble");
          const el = shown(act) ? act : document.querySelector(".hero-still .bubble");
          // A two-line bubble has no space between its lines in textContent, so spaces are left out of the comparison.
          return shown(el) ? (el!.textContent ?? "").replace(/\|$/, "").replace(/\s/g, "") : "";
        }),
      { timeout: 10_000 },
    )
    .toBe(line.replace(/\s/g, ""));
  return page.evaluate(() => {
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { l: r.left, t: r.top, r: r.right, b: r.bottom };
    };
    const act = document.querySelector<SVGGElement>(".act-bubble");
    const film = !!act && getComputedStyle(act.ownerSVGElement!.closest(".act-backdrop")!).display !== "none" && act.getBoundingClientRect().width > 0;
    const bubble = film ? act! : document.querySelector(".hero-still .bubble")!;
    // Boo's body (not his svg box, which leaves room for the glow): the still ghost, or the last actor in the hero's backdrop (Casper is drawn first).
    const ghost = film ? [...document.getElementById("hero")!.closest(".act")!.querySelectorAll(".act-backdrop .actor")].at(-1)! : document.querySelector(".hero-still")!;
    const boo = ghost.querySelector(".ghost-lean")!;
    // His glow: the halo the actor draws, or the still ghost's whole svg (its glow is a drop shadow around it).
    const glow = ghost.querySelector("svg.ghost > ellipse") ?? ghost.querySelector("svg.ghost")!;
    let px: number;
    // Where the tail points: the tip of the film bubble's tail, or the middle of the still bubble (its tail hangs from the centre).
    let tip: number;
    if (film) {
      const text = act!.querySelector("text")!;
      px = Number(text.getAttribute("font-size")) * (text.getScreenCTM()?.a ?? 1);
      const tail = act!.querySelector("path")!;
      const [, , tx, ty] = (tail.getAttribute("d")!.match(/-?[\d.]+/g) ?? []).map(Number);
      tip = new DOMPoint(tx, ty).matrixTransform(tail.getScreenCTM()!).x;
    } else {
      px = parseFloat(getComputedStyle(bubble).fontSize);
      const r = bubble.getBoundingClientRect();
      tip = (r.left + r.right) / 2;
    }
    const nav = document.querySelector("header.nav")!.getBoundingClientRect().bottom;
    const copy = [".hero-title", ".hero-lead", ".hero-actions"].map((s) => box(document.querySelector(s)!));
    return { film, bubble: box(bubble), boo: box(boo), glow: box(glow), tip, nav, copy, px };
  });
}

for (const { path, line } of LOCALES) {
  test.describe(`hero bubble ${path}`, () => {
    for (const vp of VIEWPORTS) {
      test(`${vp.width}×${vp.height}${vp.touch ? " touch" : ""}`, async ({ browser }) => {
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: !!vp.touch, isMobile: !!vp.touch });
        const page = await ctx.newPage();
        await page.goto(path);
        // Let the hero copy finish rising in before measuring it.
        await page.waitForTimeout(1500);
        const m = await heroBubble(page, line);
        expect(inside(m.bubble, vp.width, vp.height), `bubble ${JSON.stringify(m.bubble)} leaves the ${vp.width}×${vp.height} viewport`).toBe(true);
        expect(m.px, "bubble text size").toBeGreaterThanOrEqual(12);
        for (const c of m.copy) expect(apart(m.bubble, c), `bubble ${JSON.stringify(m.bubble)} overlaps copy ${JSON.stringify(c)}`).toBe(true);
        // Above Boo's face: the bubble (tail included) ends in the top fifth of the ghost at most.
        const face = m.boo.t + (m.boo.b - m.boo.t) * 0.2;
        expect(m.bubble.b, "bubble reaches Boo's face").toBeLessThanOrEqual(face);
        // ...and its tail points at him.
        expect(m.tip, `bubble tail at x ${m.tip} misses Boo ${JSON.stringify(m.boo)}`).toBeGreaterThanOrEqual(m.boo.l);
        expect(m.tip, `bubble tail at x ${m.tip} misses Boo ${JSON.stringify(m.boo)}`).toBeLessThanOrEqual(m.boo.r);
        // Boo himself is whole on screen, glow included, below the nav and clear of the copy.
        expect(inside(m.boo, vp.width, vp.height), `Boo ${JSON.stringify(m.boo)} leaves the ${vp.width}×${vp.height} viewport`).toBe(true);
        expect(inside(m.glow, vp.width, vp.height), `Boo's glow ${JSON.stringify(m.glow)} leaves the ${vp.width}×${vp.height} viewport`).toBe(true);
        expect(m.boo.t, "Boo's head under the nav").toBeGreaterThanOrEqual(m.nav);
        for (const c of m.copy) expect(apart(m.boo, c), `Boo ${JSON.stringify(m.boo)} overlaps copy ${JSON.stringify(c)}`).toBe(true);
        await ctx.close();
      });
    }
  });
}

// The finale plays eight lines, one at a time; every one must be whole on screen.
for (const { path } of LOCALES) {
  for (const vp of [
    { width: 320, height: 568 },
    { width: 1440, height: 900 },
  ]) {
    test(`finale bubbles ${path} ${vp.width}×${vp.height}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: vp, hasTouch: vp.width < 860, isMobile: vp.width < 860 });
      const page = await ctx.newPage();
      await page.goto(path, { waitUntil: "networkidle" });
      const center = () => page.evaluate(() => document.querySelector(".fin-stage")!.scrollIntoView({ block: "center" }));
      await center();
      const seen = new Map<string, Box>();
      const deadline = Date.now() + 40_000;
      while (seen.size < 8 && Date.now() < deadline) {
        const on = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>(".fin-bubble[data-on='true']")]
            .filter((e) => e.textContent)
            .map((e) => {
              const r = e.getBoundingClientRect();
              return { text: e.textContent!, box: { l: r.left, t: r.top, r: r.right, b: r.bottom } };
            }),
        );
        for (const { text, box } of on) {
          const prev = seen.get(text);
          // Keep the widest box a line had (it scales in).
          if (!prev || box.r - box.l > prev.r - prev.l) seen.set(text, box);
        }
        // Images above can still shift the page; keep the stage centred until the dialogue starts.
        if (!seen.size) await center();
        await page.waitForTimeout(200);
      }
      expect(seen.size, "lines seen").toBe(8);
      for (const [text, box] of seen) expect(box.l >= 0 && box.r <= vp.width, `"${text}" ${JSON.stringify(box)} leaves the ${vp.width}px viewport`).toBe(true);
      await ctx.close();
    });
  }
}
