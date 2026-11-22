import type { Page } from "@playwright/test";

/** A control on screen whose thumb-sized area is smaller than `min` px one way or the other. */
export type SmallTarget = { name: string; width: number; height: number; stops: string };

/**
 * Every button, link and `[role=button]` on screen that a thumb can hit in less than `min` × `min` px. What counts is
 * where a tap lands on it, not its box: from the control's centre, the run of points along each axis whose topmost
 * element is the control (or inside it), so padding, a `::before` grown past the box and an invisible hit area count,
 * and a neighbour drawn over it does not. Hidden, covered and off-screen controls are left out, and so is a link inside
 * a sentence (WCAG 2.5.8's inline exception). `controls`: which elements count (by default every button and link).
 */
export function smallTargets(page: Page, min = 44, controls = "button, a[href], [role=button]"): Promise<SmallTarget[]> {
  return page.evaluate(([min, controls]) => {
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const out: { name: string; width: number; height: number; stops: string }[] = [];
    const named = (el: Element | null) => !el ? "the screen's edge" : el instanceof HTMLElement && el.dataset.testid ? el.dataset.testid
      : `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}` : ""}`;
    const seen = new Set<Element>();
    for (const el of document.querySelectorAll<HTMLElement>(controls)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const cx = Math.round(Math.min(Math.max(box.left + box.width / 2, 0), vw - 1));
      const cy = Math.round(Math.min(Math.max(box.top + box.height / 2, 0), vh - 1));
      if (box.right <= 0 || box.bottom <= 0 || box.left >= vw || box.top >= vh) continue;
      const on = (x: number, y: number) => {
        const hit = document.elementFromPoint(x, y);
        return !!hit && (hit === el || el.contains(hit));
      };
      if (!on(cx, cy)) continue;
      const style = getComputedStyle(el);
      if (style.display === "inline" && el.tagName === "A") {
        const block = el.parentElement?.closest("p, li, dd, td, label, span, div");
        if (block && (block.textContent ?? "").trim().length > (el.textContent ?? "").trim().length) continue;
      }
      // How far a tap still lands on it from the centre, and what it lands on past that.
      const stops: string[] = [];
      const run = (dx: number, dy: number) => {
        let n = 0, x = cx + dx, y = cy + dy;
        for (; x >= 0 && y >= 0 && x < vw && y < vh && on(x, y); x += dx, y += dy) n++;
        stops.push(named(x >= 0 && y >= 0 && x < vw && y < vh ? document.elementFromPoint(x, y) : null));
        return n;
      };
      const width = 1 + run(-1, 0) + run(1, 0), height = 1 + run(0, -1) + run(0, 1);
      if (width >= min && height >= min) continue;
      const label = el.dataset.testid ?? el.getAttribute("aria-label") ?? el.getAttribute("title") ?? (el.textContent ?? "").trim().slice(0, 30);
      out.push({ name: `${el.tagName.toLowerCase()}${label ? ` "${label}"` : ""}`, width, height, stops: `left ${stops[0]}, right ${stops[1]}, top ${stops[2]}, bottom ${stops[3]}` });
    }
    return out;
  }, [min, controls] as const);
}
