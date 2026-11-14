import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// covers: app.accessibility

/**
 * A group's payment sheet opens on the person to pay; its head then has a step back, "Choose someone else"
 * (`payment-recipient-change`), drawn as a turned card's way back (`.deck-flip-turn`, deck/flip.css). A card's back is
 * dark whatever the theme, but this one sits on the sheet, the theme's panel: in every light theme its white focus ring
 * (1.04-1.12:1) and its chevron, the button's only content, on its dark wash (1.02-1.09:1) did not show. Both read at
 * 3:1 or more there (WCAG 1.4.11, 2.4.7) in every colour theme, dark and light.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");
const INDEX = readFileSync(join(SRC, "index.css"), "utf8");
const FLIP = readFileSync(join(SRC, "components/deck/flip.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const COMPOSER = readFileSync(join(SRC, "components/PaymentComposer.tsx"), "utf8");

/** Each theme block's custom properties, by its selector list (as switchOff.test.ts reads them). */
function themes(): { name: string; scheme: "dark" | "light"; vars: Record<string, string> }[] {
  const all: { selector: string; vars: Record<string, string> }[] = [];
  for (const match of INDEX.matchAll(/(:root[^{,]*(?:,\s*:root[^{,]*)*)\{([^}]*)\}/g)) {
    const vars: Record<string, string> = {};
    for (const [, name, value] of match[2].matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[name] = value.trim();
    all.push({ selector: match[1].trim(), vars });
  }
  const base = (scheme: "dark" | "light") => all.find(b => scheme === "dark" ? b.selector.startsWith(":root,") : b.selector.startsWith(':root[data-theme="light"],'))!.vars;
  return ["classic", "monochrome", "cyan", "purple"].flatMap(color => (["dark", "light"] as const).map(scheme => {
    const own = all.find(b => b.selector.includes(`[data-theme="${scheme}"][data-color-theme="${color}"]`))!.vars;
    return { name: `${color} ${scheme}`, scheme, vars: { ...base(scheme), ...own } };
  }));
}

/**
 * The button's declarations in a sheet's head, in source order (a later rule wins: the overrides are later and more
 * specific): `.deck-flip-turn`, or with `:focus-visible`, alone or under `.composer-sheet-head` and the scheme.
 */
function declarations(scheme: "dark" | "light", focused: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, list, body] of FLIP.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const applies = list.split(",").some((selector) => {
      const rest = selector.trim().replace(/^:root\[data-theme="(dark|light)"\]\s*/, (_, s: string) => (s === scheme ? "" : "\u0000")).replace(/^\.composer-sheet-head\s+/, "");
      return rest === ".deck-flip-turn" || (focused && rest === ".deck-flip-turn:focus-visible");
    });
    if (!applies) continue;
    for (const [, name, value] of body.matchAll(/([\w-]+):([^;]+)(?:;|$)/g)) out[name] = value.trim();
  }
  return out;
}

type Rgba = [number, number, number, number];
/** A colour value of these rules: a hex, `transparent`, `rgb()`/`rgba()` (with the card's ink at its fallback), a theme variable. */
function colour(value: string, vars: Record<string, string>): Rgba {
  const v = value.replace(/var\(--([\w-]+)(?:,([^)]*))?\)/g, (_, name: string, fallback?: string) => vars[name] ?? fallback ?? "").trim();
  if (v === "transparent") return [0, 0, 0, 0];
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map(c => c + c).join("") : hex[1];
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).concat(1) as Rgba;
  }
  const fn = v.match(/^rgba?\(([^)]*)\)$/);
  if (!fn) throw new Error(`not a colour: ${value} (${v})`);
  const parts = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}
const over = (top: Rgba, under: Rgba): Rgba => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as Rgba;
const luminance = (c: Rgba) => {
  const [r, g, b] = c.slice(0, 3).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: Rgba, b: Rgba) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe("the payment sheet's step back", () => {
  const list = themes();

  it("is the deck's turn button in the sheet's head", () => {
    expect(COMPOSER).toMatch(/<ComposerSheetHead[^>]*before=\{onBack && <button type="button" className="deck-flip-turn" data-testid="payment-recipient-change"/);
  });

  it("shows its chevron and its focus ring at 3:1 or more on the sheet, in every colour theme", () => {
    expect(list).toHaveLength(8);
    const failures = list.flatMap(({ name, scheme, vars }) => {
      const sheet = colour(vars["theme-panel-header"], vars);
      const rest = declarations(scheme, false), focus = declarations(scheme, true);
      const fill = over(colour(rest.background, vars), sheet);
      const chevron = over(colour(rest.color, vars), fill);
      const ring = over(colour(focus["outline-color"] ?? focus.outline.split(/\s+/).slice(2).join(" "), vars), sheet);
      return [
        contrast(chevron, fill) < 3 ? `${name}: chevron ${contrast(chevron, fill).toFixed(2)}:1 on its fill` : null,
        contrast(ring, sheet) < 3 ? `${name}: focus ring ${contrast(ring, sheet).toFixed(2)}:1 on the sheet` : null,
      ];
    }).filter(Boolean);
    expect(failures).toEqual([]);
  });
});
