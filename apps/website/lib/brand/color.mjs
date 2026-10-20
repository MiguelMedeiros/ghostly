// Colour arithmetic for the brand page, the press kit and the brand test: one implementation, plain JavaScript, so
// the page (TypeScript, allowJs) and the Node scripts (scripts/brand-kit.mjs, scripts/brand.test.mjs) share it.

/** @param {string} hex `#rrggbb` @returns {[number, number, number]} 0 to 255 */
export function rgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** @param {string} hex @returns {[number, number, number]} hue 0 to 360, saturation and lightness 0 to 100, rounded */
export function hsl(hex) {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** @param {string} hex @returns {[number, number, number]} OKLCH: lightness 0 to 1, chroma, hue in degrees */
export function oklch(hex) {
  const [r, g, b] = rgb(hex).map((v) => linear(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return [L, C, C < 0.0001 ? 0 : H];
}

/** The colour in each notation the page and the press kit show. @param {string} hex */
export function notations(hex) {
  const [r, g, b] = rgb(hex);
  const [h, s, l] = hsl(hex);
  const [L, C, H] = oklch(hex);
  return {
    hex: hex.toUpperCase(),
    rgb: `rgb(${r} ${g} ${b})`,
    hsl: `hsl(${h} ${s}% ${l}%)`,
    oklch: `oklch(${(L * 100).toFixed(1)}% ${C.toFixed(3)} ${H.toFixed(1)})`,
  };
}

/** WCAG 2.x relative luminance. @param {string} hex */
export function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => linear(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1 to 21. @param {string} a @param {string} b */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * What a pair passes. Normal text needs 4.5 (AA) or 7 (AAA); large text (24px, or 19px bold) and graphics such as the
 * logo and icons need 3 (AA) or 4.5 (AAA for large text).
 * @param {number} ratio
 */
export function levels(ratio) {
  return { aa: ratio >= 4.5, aaa: ratio >= 7, aaLarge: ratio >= 3, aaaLarge: ratio >= 4.5 };
}

/** The ratio a use needs: text 4.5, large text and graphics 3. "avoid" is a pair shown because it fails. */
export const NEEDS = { text: 4.5, large: 3, graphic: 3 };
