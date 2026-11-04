import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// covers: app.accessibility

/**
 * Muted words (an unnamed contact, a chat's last line, a time, a field's hint and placeholder) sit on every surface of
 * the app: the list, the panels, the header, a field, a chosen row. In each colour theme, dark and light, they read at
 * WCAG AA (4.5:1) on all of them, as the default Cyan has since its axe check. So do secondary words and words in the
 * accent (a link, a section's title, Join, a chosen tab), the accent's on its own pill tints too.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");
const CSS = readFileSync(join(SRC, "index.css"), "utf8");

/** Each theme block's custom properties, by its selector list (as dangerFill.test.ts reads them). */
function blocks(): { selector: string; vars: Record<string, string> }[] {
  const out: { selector: string; vars: Record<string, string> }[] = [];
  for (const match of CSS.matchAll(/(:root[^{,]*(?:,\s*:root[^{,]*)*)\{([^}]*)\}/g)) {
    const vars: Record<string, string> = {};
    for (const [, name, value] of match[2].matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[name] = value.trim();
    out.push({ selector: match[1].trim(), vars });
  }
  return out;
}

/** The 8 themes (4 colour themes, dark and light): each one's own block over its scheme's base block. */
function themes(): { name: string; vars: Record<string, string> }[] {
  const all = blocks();
  const base = (scheme: "dark" | "light") => all.find(b => scheme === "dark" ? b.selector.startsWith(":root,") : b.selector.startsWith(':root[data-theme="light"],'))!.vars;
  return ["classic", "monochrome", "cyan", "purple"].flatMap(color => (["dark", "light"] as const).map(scheme => {
    const own = all.find(b => b.selector.includes(`[data-theme="${scheme}"][data-color-theme="${color}"]`))!.vars;
    return { name: `${color} ${scheme}`, vars: { ...base(scheme), ...own } };
  }));
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** Every surface muted words are drawn on: the page, the list, the chat, the header, the panels, a chosen row, a field. */
const SURFACES = ["app-bg", "sidebar-bg", "chat-bg", "panel-header", "surface", "surface-alt", "surface-hover", "input-bg", "search-bg", "received-bg"];

/** `color` at `alpha` over `under`, as the page paints `bg-accent/20`. */
const over = (color: string, alpha: number, under: string) => {
  const channel = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5].map(i => Math.round(channel(color, i) * alpha + channel(under, i) * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
};

/** The page and panel surfaces a pill (a tint of its own words' colour) sits on. */
const PILL_SURFACES = ["app-bg", "sidebar-bg", "panel-header", "surface", "surface-alt"];

/** Each `ink` token of each theme under 4.5:1 on one of `surfaces` (or the ink's own tints over them). */
function under(ink: string, surfaces: string[], tints: number[] = [0]): string[] {
  return themes().flatMap(({ name, vars }) => surfaces.flatMap((surface) => tints.map((alpha) => {
    const on = alpha ? over(vars[`theme-${ink}`], alpha, vars[`theme-${surface}`]) : vars[`theme-${surface}`];
    const ratio = contrast(vars[`theme-${ink}`], on);
    return ratio < 4.5 ? `${name}: ${ink} ${vars[`theme-${ink}`]} on ${alpha ? `${alpha * 100} % of it over ` : ""}${surface} is ${ratio.toFixed(2)}:1` : null;
  }))).filter((line): line is string => line !== null);
}

describe("muted, secondary and accent words", () => {
  const list = themes();

  it("read at WCAG AA (4.5:1) on every surface, in every colour theme", () => {
    expect(list).toHaveLength(8);
    expect(CSS).toContain("--color-text-muted: var(--theme-text-muted);");
    // Classic's grey read 2.6-3.1:1 in light and 2.6-4:1 in dark.
    expect(under("text-muted", SURFACES)).toEqual([]);
  });

  it("secondary words read at WCAG AA (4.5:1) on every surface, a chosen row too, in every colour theme", () => {
    // Classic dark's read 3.9:1 on a chosen row.
    expect(under("text-secondary", SURFACES)).toEqual([]);
  });

  it("words in the accent read at WCAG AA (4.5:1) on every surface and on the accent's own tints (a pill or Join at 10-15 %), in every colour theme", () => {
    // Classic's green read 2.5:1 on light pages and 3.9:1 on a dark chosen row; Purple light's violet 4.3:1 on its pill.
    expect([...under("accent", SURFACES), ...under("accent", PILL_SURFACES, [0.1, 0.15])]).toEqual([]);
  });

  it("words on the accent (a button, a chosen option) read at WCAG AA (4.5:1), in every colour theme", () => {
    for (const { name, vars } of list) expect(contrast(vars["theme-on-accent"], vars["theme-accent"]), name).toBeGreaterThanOrEqual(4.5);
  });

  it("stay quieter than secondary words: further from the text colour, in every colour theme", () => {
    for (const { name, vars } of list) {
      expect(contrast(vars["theme-text-muted"], vars["theme-text-primary"]), name)
        .toBeGreaterThan(contrast(vars["theme-text-secondary"], vars["theme-text-primary"]));
    }
  });
});
