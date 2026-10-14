// The logo's variants, drawn from brand.json's one icon path and the outlined wordmark. The /brand page renders these
// shapes as React SVG, and the press kit (scripts/brand-kit.mjs) writes the same shapes as .svg files and PNGs, so
// the page and the files cannot differ.
//
// Every shape is one path in the colourway's colour, the eyes cut out (even-odd), so a file works on any background
// without a second colour. The tile (the favicon's rounded square) is the only variant with more than one colour.
import brand from "./brand.json" with { type: "json" };

const { logo } = brand;
const E = 2 * logo.eyes[0].r;
const r2 = (n) => Math.round(n * 100) / 100;

/** A circle as a closed subpath, for the even-odd cut-outs. */
const circle = ({ cx, cy, r }) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;

/** The ghost with its eyes cut out, in the icon path's own units (the 40-wide box Brand.tsx translates by 12,8). */
export const GHOST_D = `${logo.iconPath}${logo.eyes.map(circle).join("")}`;

/**
 * @typedef {{ d: string, fill: string, transform?: string, evenOdd?: boolean, opacity?: number }} Shape
 * @typedef {{ id: string, viewBox: [number, number, number, number], shapes: Shape[] }} Drawing
 */

/** The ghost alone, cropped to its body. @param {string} fill @returns {Drawing} */
export function icon(fill) {
  const b = logo.bodyBox;
  return { id: "icon", viewBox: [b.x, b.y, b.width, b.height], shapes: [{ d: GHOST_D, fill, evenOdd: true }] };
}

/** GHOSTLY alone, cropped to the letters. @param {string} fill @returns {Drawing} */
export function wordmark(fill) {
  const w = logo.wordmark;
  return { id: "wordmark", viewBox: [0, 0, w.width, w.height], shapes: [{ d: w.d, fill }] };
}

/** Where the wordmark sits next to the ghost, in the ghost's units: the app's proportion (see brand.json lockup). */
export function lockupGeometry() {
  const b = logo.bodyBox;
  const w = logo.wordmark;
  const scale = (logo.lockup.capHeightE * E) / w.capHeight;
  const x = b.x + b.width + logo.lockup.gapE * E;
  // The letters' middle on the body's middle.
  const y = b.y + b.height / 2 - (w.height * scale) / 2;
  return { scale, x, y, width: x + w.width * scale - b.x, height: b.height };
}

/** The ghost and GHOSTLY side by side: the primary logo. @param {string} fill @returns {Drawing} */
export function lockup(fill) {
  const b = logo.bodyBox;
  const g = lockupGeometry();
  return {
    id: "lockup",
    viewBox: [b.x, b.y, r2(g.width), b.height],
    shapes: [
      { d: GHOST_D, fill, evenOdd: true },
      { d: logo.wordmark.d, fill, transform: `translate(${r2(g.x)} ${r2(g.y)}) scale(${g.scale.toFixed(5)})` },
    ],
  };
}

/** The icon on its rounded tile, as public/favicon.svg draws it. @returns {Drawing} */
export function tile() {
  const t = logo.tile;
  const [tx, ty] = logo.appBox.translate;
  const at = `translate(${tx} ${ty})`;
  return {
    id: "tile",
    viewBox: [0, 0, 64, 64],
    shapes: [
      { d: `M${t.radius} 0H${64 - t.radius}A${t.radius} ${t.radius} 0 0 1 64 ${t.radius}V${64 - t.radius}A${t.radius} ${t.radius} 0 0 1 ${64 - t.radius} 64H${t.radius}A${t.radius} ${t.radius} 0 0 1 0 ${64 - t.radius}V${t.radius}A${t.radius} ${t.radius} 0 0 1 ${t.radius} 0Z`, fill: t.background },
      { d: GHOST_D, fill: brand.colors.core.find((c) => c.id === "cyan").hex, evenOdd: true, opacity: t.ghostOpacity, transform: at },
      { d: logo.eyes.map(circle).join(""), fill: t.background, transform: at },
      { d: t.highlights.map(circle).join(""), fill: t.highlight, transform: at },
    ],
  };
}

export const VARIANTS = /** @type {const} */ (["lockup", "icon", "wordmark"]);
const DRAW = { lockup, icon, wordmark };

/** One variant in one colourway. @param {"lockup"|"icon"|"wordmark"} variant @param {string} fill */
export function draw(variant, fill) {
  return DRAW[variant](fill);
}

/** A drawing as a standalone .svg file. @param {Drawing} drawing @param {string} title */
export function toSvg(drawing, title) {
  const [x, y, w, h] = drawing.viewBox;
  const shapes = drawing.shapes
    .map((s) => {
      const attrs = [`d="${s.d}"`, `fill="${s.fill}"`];
      if (s.evenOdd) attrs.push('fill-rule="evenodd"');
      if (s.opacity !== undefined) attrs.push(`opacity="${s.opacity}"`);
      if (s.transform) attrs.push(`transform="${s.transform}"`);
      return `  <path ${attrs.join(" ")}/>`;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${r2(w)}" height="${r2(h)}" role="img" aria-label="${title}">\n  <title>${title}</title>\n${shapes}\n</svg>\n`;
}

/** The unit everything is measured in: one eye's diameter, in the icon's units. */
export const EYE = E;
