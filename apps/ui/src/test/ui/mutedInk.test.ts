import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// covers: app.accessibility

/**
 * Muted words (an unnamed contact, a chat's last line, a time, a field's hint and placeholder) sit on every surface of
 * the app: the list, the panels, the header, a field, a chosen row. In each colour theme, dark and light, they read at
 * WCAG AA (4.5:1) on all of them, as the default Cyan has since its axe check.
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

/**
 * Not yet: Classic. Its muted grey is 2.6-3.1:1 in light and 2.6-4:1 in dark, and there its secondary words and its
 * green also fall under 4.5:1 on a chosen row (and the green under it on every light surface): that palette is redone
 * as a whole, not by its muted grey alone.
 */
const NOT_YET = ["classic dark", "classic light"];

describe("muted words", () => {
  const list = themes();

  it("read at WCAG AA (4.5:1) on every surface, in every colour theme", () => {
    expect(list).toHaveLength(8);
    expect(CSS).toContain("--color-text-muted: var(--theme-text-muted);");
    const failures = list.filter(({ name }) => !NOT_YET.includes(name)).flatMap(({ name, vars }) => SURFACES.map((surface) => {
      const ratio = contrast(vars["theme-text-muted"], vars[`theme-${surface}`]);
      return ratio < 4.5 ? `${name}: ${vars["theme-text-muted"]} on ${surface} ${vars[`theme-${surface}`]} is ${ratio.toFixed(2)}:1` : null;
    })).filter(Boolean);
    expect(failures).toEqual([]);
  });

  it("stay quieter than secondary words: further from the text colour, in every colour theme", () => {
    for (const { name, vars } of list) {
      expect(contrast(vars["theme-text-muted"], vars["theme-text-primary"]), name)
        .toBeGreaterThan(contrast(vars["theme-text-secondary"], vars["theme-text-primary"]));
    }
  });

  it("Classic is still listed as not yet only while it falls short", () => {
    for (const name of NOT_YET) {
      const { vars } = list.find(t => t.name === name)!;
      expect(SURFACES.some((surface) => contrast(vars["theme-text-muted"], vars[`theme-${surface}`]) < 4.5), name).toBe(true);
    }
  });
});
