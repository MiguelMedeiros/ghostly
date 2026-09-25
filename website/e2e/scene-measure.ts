/**
 * Measuring the home story in the page (passed to page.evaluate, so it must
 * stay self-contained): the copy block of a chapter and every shape its
 * picture draws right now, in CSS pixels.
 */

export type Rect = { x: number; y: number; w: number; h: number };
export type Hit = { what: string; rect: Rect };
export type Shot = { mode: "film" | "cards"; copy: Rect | null; art: Hit[]; ghosts: Hit[]; vw: number; vh: number; nav: number };

/** Runs in the page: what the chapter shows right now. */
export function measure(id: string): Shot {
  const vw = innerWidth;
  const vh = innerHeight;
  const nav = document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
  const section = document.getElementById(id)!;
  const box = (r: DOMRect): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const union = (rs: Rect[]): Rect | null => {
    if (!rs.length) return null;
    const x = Math.min(...rs.map((r) => r.x));
    const y = Math.min(...rs.map((r) => r.y));
    return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
  };
  const onScreen = (r: Rect) => r.w > 0 && r.h > 0 && r.x < vw && r.x + r.w > 0 && r.y < vh && r.y + r.h > 0;
  const textRects = (el: Element): Rect[] => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return [...range.getClientRects()].map(box).filter((r) => r.w > 1 && r.h > 1);
  };
  const opacity = (el: Element, stop: Element) => {
    let o = 1;
    for (let e: Element | null = el; e && e !== stop.parentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden") return 0;
      o *= Number(cs.opacity);
    }
    return o;
  };
  // A ghost's svg keeps room around it for the halo; the body is what must stay clear.
  const body = (g: Element): Rect => box((g.querySelector(".ghost-lean") ?? g).getBoundingClientRect());
  const name = (el: Element) => `${el.tagName.toLowerCase()}${el.getAttribute("class") ? "." + el.getAttribute("class")!.trim().split(/\s+/).join(".") : ""}`;

  if (section.classList.contains("scene--static")) {
    // The article: each step's still, then its copy.
    const art: Hit[] = [];
    const copy: Rect[] = [];
    section.querySelectorAll(".scene-static-figure").forEach((f, i) => art.push({ what: `figure ${i}`, rect: box(f.getBoundingClientRect()) }));
    section.querySelectorAll(".eyebrow, .scene-static-copy > *, .scene-static-extra .btn").forEach((el) => copy.push(...(el.classList.contains("btn") ? [box(el.getBoundingClientRect())] : textRects(el))));
    // In the article the copy is several blocks: check each against every figure.
    return { mode: "cards", copy: null, art: [...art, ...copy.map((rect) => ({ what: "copy", rect }))], ghosts: [], vw, vh, nav };
  }

  const panel = section.querySelector(".scene-copy")!;
  const copyRects: Rect[] = [];
  const eyebrow = panel.querySelector(".eyebrow");
  if (eyebrow) copyRects.push(...textRects(eyebrow));
  panel.querySelectorAll('.scene-step[data-active="true"] > *').forEach((el) => copyRects.push(...textRects(el)));
  panel.querySelectorAll(".scene-progress button").forEach((b) => {
    // The visible dash, not the 44px hit area.
    const r = b.getBoundingClientRect();
    copyRects.push({ x: r.left + 10, y: r.top + r.height / 2 - 1.5, w: (r.width - 16) * 1.35, h: 3 });
  });
  panel.querySelectorAll(".btn").forEach((b) => copyRects.push(box(b.getBoundingClientRect())));
  const copy = union(copyRects);

  const art: Hit[] = [];
  const ghosts: Hit[] = [];
  const visual = section.querySelector(".scene-visual svg.stage");
  if (visual) {
    // Ghosts count as one shape each; everything else by its drawn leaves.
    visual.querySelectorAll("svg.ghost").forEach((g) => {
      if (opacity(g, visual) < 0.1) return;
      const hit = { what: "ghost", rect: body(g) };
      art.push(hit);
      ghosts.push(hit);
    });
    visual.querySelectorAll("path, rect, circle, ellipse, line, polyline, polygon, text, image").forEach((el) => {
      // Masked shapes (Casper's query rings) are drawn only inside their mask: their own box says nothing.
      if (el.closest("svg.ghost, defs, mask, [mask], .key-light")) return;
      if (opacity(el, visual) < 0.1) return;
      const rect = box(el.getBoundingClientRect());
      if (onScreen(rect)) art.push({ what: name(el) + (el.textContent ? ` "${el.textContent.slice(0, 30)}"` : ""), rect });
    });
  }
  // The act's two ghosts, while this chapter is the one on screen.
  const act = section.closest(".act");
  if (act && act.getAttribute("data-chapter") === section.dataset.chapter) {
    act.querySelectorAll(".act-backdrop .actor").forEach((a, i) => {
      const g = a.querySelector("svg.ghost");
      if (!g || opacity(a, a) < 0.1) return;
      const hit = { what: i === 0 ? "casper (act)" : "boo (act)", rect: body(g) };
      art.push(hit);
      ghosts.push(hit);
    });
  }
  return { mode: "film", copy, art, ghosts, vw, vh, nav };
}


/**
 * Runs in the page: what the scroll drives in a chapter, to tell when the
 * springs have settled. Leaves out the ghosts' own idle bob and wobble, which
 * never settle: the act's actors by their spring transforms, the scene's
 * other shapes by their boxes to 2px.
 */
export function settleKey(id: string): string {
  const section = document.getElementById(id);
  if (!section) return "";
  // The page itself first: nothing has settled while it is still scrolling.
  const parts: string[] = [String(Math.round(scrollY))];
  section.closest(".act")?.querySelectorAll<SVGGElement>(".act-backdrop .actor").forEach((a) => parts.push(a.style.transform, a.style.opacity));
  section.querySelectorAll(".scene-visual svg.stage :is(path, rect, circle, ellipse, line, text)").forEach((el) => {
    if (el.closest("svg.ghost, defs, mask")) return;
    const r = el.getBoundingClientRect();
    parts.push([r.left, r.top, r.width, r.height].map((v) => Math.round(v / 2)).join(","));
  });
  const step = section.querySelector('.scene-step[data-active="true"]');
  parts.push(String(step ? [...step.parentElement!.children].indexOf(step) : -1));
  return parts.join("|");
}
