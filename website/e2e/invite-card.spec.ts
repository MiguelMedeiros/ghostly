import { expect, test } from "@playwright/test";

/**
 * The invitation card in the home story's first chapter. Its link and code are longer than their fields on purpose
 * (a real code is): each value must be clipped to a field that lies inside its pill, so no font ever draws it across
 * the card's edge. Every other line (title, "for one person", the labels) must fit the card whole.
 * Geometry is read in the card's own user units (getBBox), so the card's scale in the scene does not matter.
 */

type Box = { x: number; y: number; w: number; h: number };
type Found = { cards: number; problems: string[] };

/** Runs in the page: every invitation card drawn in the invite chapter and what does not fit. */
function audit(): Found {
  const num = (el: Element, a: string) => Number(el.getAttribute(a));
  const rectOf = (el: Element): Box => ({ x: num(el, "x"), y: num(el, "y"), w: num(el, "width"), h: num(el, "height") });
  const within = (a: Box, b: Box, slack = 0.5) => a.x >= b.x - slack && a.y >= b.y - slack && a.x + a.w <= b.x + b.w + slack && a.y + a.h <= b.y + b.h + slack;
  const fmt = (b: Box) => `[${b.x.toFixed(1)},${b.y.toFixed(1)} ${b.w.toFixed(1)}×${b.h.toFixed(1)}]`;
  const problems: string[] = [];
  let cards = 0;
  document.querySelectorAll("#invite [data-invite-card]").forEach((body, c) => {
    const card = body.parentElement!;
    const edge = rectOf(body);
    if (!(card as unknown as SVGGraphicsElement).getBBox().width) return; // not rendered (a hidden variant)
    cards++;
    card.querySelectorAll("text").forEach((t) => {
      const text = t as SVGTextElement;
      const what = `card ${c + 1}: "${text.textContent}"`;
      const clip = text.getAttribute("clip-path");
      const b = text.getBBox();
      const box = { x: b.x, y: b.y, w: b.width, h: b.height };
      if (!clip) {
        // A line drawn whole: inside the card with a little room to its edge.
        const room = { x: edge.x + 6, y: edge.y + 6, w: edge.w - 12, h: edge.h - 12 };
        if (!within(box, room)) problems.push(`${what} ${fmt(box)} leaves the card ${fmt(edge)}`);
        return;
      }
      // A value: clipped to a field inside its pill, starting inside the field.
      const row = text.closest("[data-invite-row]");
      const pill = row?.querySelector("[data-invite-pill]");
      const field = document.querySelector(`${clip.slice(4, -1)} [data-invite-field]`);
      if (!row || !pill || !field) {
        problems.push(`${what} has no pill or field to clip it`);
        return;
      }
      const p = rectOf(pill);
      const f = rectOf(field);
      if (!within(f, p)) problems.push(`${what}: its field ${fmt(f)} leaves the pill ${fmt(p)}`);
      if (!within(p, edge)) problems.push(`${what}: its pill ${fmt(p)} leaves the card ${fmt(edge)}`);
      if (box.x < f.x - 0.5) problems.push(`${what} starts at ${box.x.toFixed(1)}, left of its field ${fmt(f)}`);
    });
  });
  return { cards, problems };
}

const CASES = [
  { name: "desktop film", path: "/", viewport: { width: 1440, height: 900 } },
  { name: "desktop film, Portuguese", path: "/pt-br", viewport: { width: 1440, height: 900 } },
  { name: "reduced motion", path: "/", viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" as const },
  { name: "phone", path: "/", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { name: "phone, Portuguese", path: "/pt-br", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
];

for (const { name, path, viewport, reducedMotion, isMobile, hasTouch } of CASES) {
  test.describe(() => {
    test.use({ viewport, reducedMotion: reducedMotion ?? "no-preference", isMobile: !!isMobile, hasTouch: !!hasTouch });
    test(`the invitation card keeps its link and code in their fields (${name})`, async ({ page }) => {
      await page.goto(path, { waitUntil: "networkidle" });
      await page.locator("#invite").scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready);
      const { cards, problems } = await page.evaluate(audit);
      expect(cards, "no invitation card was drawn").toBeGreaterThan(0);
      expect(problems, problems.join("\n")).toEqual([]);
    });
  });
}
