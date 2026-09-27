import { expect, test, type Page } from "@playwright/test";
import { measure, settleKey, type Rect } from "./scene-measure";

/**
 * On a wide window the site keeps one content column (site.css `--wrap`): the
 * backgrounds run full-bleed, but everything read or looked at sits in a
 * centred column no wider than the token, gutters included. The story's
 * pictures and its two ghosts are framed inside that column too, so none of
 * them drifts to the window's edge.
 */

const W = 2560;
const H = 1440;
const CHAPTERS = ["invite", "dht", "agree", "alive", "open"] as const;
const PAGES = ["/", "/developers", "/developers/catalog", "/roadmap", "/cli"];
/** No story shape comes nearer the window's edge than this share of its width. */
const EDGE = 0.05;

const fmt = (r: Rect) => `[${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}×${Math.round(r.h)}]`;

/** Runs in the page: the column's width, and every visible text or control outside it. */
function outsideColumn(): { wrap: number; out: string[] } {
  const wrap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--wrap"));
  const vw = document.documentElement.clientWidth;
  const left = (vw - wrap) / 2 - 1;
  const right = (vw + wrap) / 2 + 1;
  const out: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.textContent?.trim() || !el || el.closest("svg, .sr-only, .skip-link, .pet, nextjs-portal, [aria-hidden='true']")) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.width < 2 || r.height < 2) continue;
      if (r.left < left || r.right > right) out.push(`"${n.textContent.trim().slice(0, 30)}" at x ${Math.round(r.left)} to ${Math.round(r.right)}`);
    }
  }
  return { wrap, out: out.slice(0, 8) };
}

async function scrollChapter(page: Page, id: string, p: number) {
  let last = "";
  for (let i = 0; i < 60; i++) {
    await page.evaluate(
      ([id, p]) => {
        const el = document.getElementById(id as string)!;
        scrollTo({ top: Math.round(el.getBoundingClientRect().top + scrollY + (el.offsetHeight - innerHeight) * (p as number)), behavior: "instant" });
      },
      [id, p] as const,
    );
    await page.waitForTimeout(100);
    const now = await page.evaluate(settleKey, id);
    if (now === last) return;
    last = now;
  }
}

test(`${W}×${H}: the nav, the sections and the story's stage sit in one centred column`, async ({ page }) => {
  await page.setViewportSize({ width: W, height: H });
  await page.goto("/", { waitUntil: "networkidle" });
  const boxes = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const wrap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--wrap"));
    const sel = ".nav-inner, main .wrap, footer .wrap, .act-backdrop > .stage, .scene-visual svg.stage";
    return {
      vw,
      wrap,
      boxes: [...document.querySelectorAll(sel)]
        .map((el) => ({ what: el.getAttribute("class") ?? el.tagName, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0)
        .map(({ what, r }) => ({ what, left: r.left, right: r.right, width: r.width, gaps: [r.left, vw - r.right] })),
    };
  });
  expect(boxes.wrap).toBeGreaterThan(0);
  expect(boxes.wrap).toBeLessThan(boxes.vw * 0.6);
  expect(boxes.boxes.length).toBeGreaterThan(5);
  const column = [(boxes.vw - boxes.wrap) / 2 - 1, (boxes.vw + boxes.wrap) / 2 + 1];
  for (const b of boxes.boxes) {
    expect(b.width, `${b.what} is wider than the column`).toBeLessThanOrEqual(boxes.wrap + 0.5);
    expect(b.left >= column[0] && b.right <= column[1], `${b.what} leaves the column (${Math.round(b.left)} to ${Math.round(b.right)})`).toBe(true);
    // The full-width rows are the column itself, centred (the hero's copy, say, is narrower and starts at its left).
    if (b.width > boxes.wrap - 1) expect(Math.abs(b.gaps[0] - b.gaps[1]), `${b.what} is off centre (${b.gaps.map(Math.round).join(" / ")})`).toBeLessThanOrEqual(2);
  }
  // The backgrounds stay full-bleed.
  const bleed = await page.evaluate(() => [".act-room", ".act-field .stage"].map((s) => document.querySelector(s)?.getBoundingClientRect().width ?? 0));
  for (const w of bleed) expect(w).toBeGreaterThanOrEqual(W - 20);
});

for (const path of PAGES) {
  test(`${W}×${H}: ${path} keeps its text and controls inside the column`, async ({ page }) => {
    await page.setViewportSize({ width: W, height: H });
    await page.goto(path, { waitUntil: "networkidle" });
    // The story's copy panels are pinned: bring each into view once, so each is measured where it is read.
    const found: string[] = [];
    const ids = path === "/" ? ["hero", ...CHAPTERS] : [];
    if (!ids.length) found.push(...(await page.evaluate(outsideColumn)).out);
    for (const id of ids) {
      await scrollChapter(page, id, 0.5);
      found.push(...(await page.evaluate(outsideColumn)).out.map((s) => `${id}: ${s}`));
    }
    await page.evaluate(() => scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
    await page.waitForTimeout(300);
    found.push(...(await page.evaluate(outsideColumn)).out.map((s) => `end: ${s}`));
    expect([...new Set(found)], [...new Set(found)].join("\n")).toEqual([]);
  });
}

test(`${W}×${H}: no story shape or ghost comes within ${EDGE * 100}% of the window's edge`, async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: W, height: H });
  await page.goto("/", { waitUntil: "networkidle" });
  const min = W * EDGE;
  const max = W * (1 - EDGE);
  const found: string[] = [];
  for (const id of CHAPTERS) {
    const n = await page.locator(`#${id} .scene-step`).count();
    for (let i = 0; i < n; i++) {
      await scrollChapter(page, id, 0.06 + ((i + 0.6) / n) * 0.88);
      const shot = await page.evaluate(measure, id);
      expect(shot.mode).toBe("film");
      for (const a of shot.art) if (a.rect.x < min || a.rect.x + a.rect.w > max) found.push(`${id} step ${i + 1}: ${a.what} ${fmt(a.rect)}`);
    }
  }
  expect(found, found.slice(0, 12).join("\n")).toEqual([]);
});

// The statement between the acts stands alone on the screen: every line of it sits on the window's centre axis.
for (const path of ["/", "/pt-br"]) {
  test(`1920×1080: ${path} centres the statement between the acts`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(path, { waitUntil: "networkidle" });
    const m = await page.evaluate(() => {
      const words = [...document.querySelectorAll(".statement-word")].map((w) => w.getBoundingClientRect());
      const lines = new Map<number, { left: number; right: number }>();
      for (const r of words) {
        const key = Math.round(r.top / 10);
        const line = lines.get(key) ?? { left: Infinity, right: -Infinity };
        lines.set(key, { left: Math.min(line.left, r.left), right: Math.max(line.right, r.right) });
      }
      const all = { left: Math.min(...words.map((r) => r.left)), right: Math.max(...words.map((r) => r.right)) };
      return { vw: document.documentElement.clientWidth, all, lines: [...lines.values()] };
    });
    const mid = m.vw / 2;
    expect(m.lines.length, "the statement breaks into lines").toBeGreaterThan(1);
    expect(Math.abs((m.all.left + m.all.right) / 2 - mid), `text box ${Math.round(m.all.left)} to ${Math.round(m.all.right)}`).toBeLessThanOrEqual(4);
    for (const l of m.lines) expect(Math.abs((l.left + l.right) / 2 - mid), `line ${Math.round(l.left)} to ${Math.round(l.right)}`).toBeLessThanOrEqual(4);
  });
}
