import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// covers: app.accessibility

/**
 * An off switch (every Settings toggle, Network, the wallets) is its track and a white knob. Whether a privacy or lock
 * option is on is read from it, so in each colour theme the knob reads at 3:1 or more on the off track (WCAG 1.4.11),
 * and in light ones the track itself does on every surface it sits on: there a pale track on a white card is a blank pill.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");
const CSS = readFileSync(join(SRC, "index.css"), "utf8");
const UI = readFileSync(join(SRC, "components/wallet/ui.tsx"), "utf8");

/** Each theme block's custom properties, by its selector list (as mutedInk.test.ts reads them). */
function blocks(): { selector: string; vars: Record<string, string> }[] {
  const out: { selector: string; vars: Record<string, string> }[] = [];
  for (const match of CSS.matchAll(/((?::root[^{,]*,?\s*)+)\{([^}]*)\}/g)) {
    const vars: Record<string, string> = {};
    for (const [, name, value] of match[2].matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[name] = value.trim();
    out.push({ selector: match[1].trim(), vars });
  }
  return out;
}

/** The 8 themes (4 colour themes, dark and light): each one's own block over its scheme's base block. */
function themes(): { name: string; scheme: "dark" | "light"; vars: Record<string, string> }[] {
  const all = blocks();
  const base = (scheme: "dark" | "light") => all.find(b => scheme === "dark" ? b.selector.startsWith(":root,") : b.selector.startsWith(':root[data-theme="light"],'))!.vars;
  return ["classic", "monochrome", "cyan", "purple"].flatMap(color => (["dark", "light"] as const).map(scheme => {
    const own = all.find(b => b.selector.includes(`[data-theme="${scheme}"][data-color-theme="${color}"]`))!.vars;
    return { name: `${color} ${scheme}`, scheme, vars: { ...base(scheme), ...own } };
  }));
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** The off track's colour class in `switchTrack`, and the theme variable behind it. */
const offClass = UI.match(/const switchTrack = [^\n]*\?\s*"bg-accent"\s*:\s*"bg-([\w-]+)"/)![1];
const offVar = CSS.match(new RegExp(`--color-${offClass}: var\\(--(theme-[\\w-]+)(?:, var\\(--(theme-[\\w-]+)\\))?\\);`))!;
const offTrack = (vars: Record<string, string>) => vars[offVar[1]] ?? vars[offVar[2]];

/** Every surface a switch is drawn on: a card, the panels, a chosen row, the page, the chat (an Accept card). */
const SURFACES = ["app-bg", "sidebar-bg", "chat-bg", "panel-header", "surface", "surface-alt", "surface-hover", "input-bg", "search-bg", "received-bg"];

describe("an off switch", () => {
  const list = themes();

  it("has a white knob at 3:1 or more on its track, in every colour theme", () => {
    expect(list).toHaveLength(8);
    expect(UI).toContain("rounded-full bg-white");
    const failures = list.map(({ name, vars }) => {
      const ratio = contrast("#ffffff", offTrack(vars));
      return ratio < 3 ? `${name}: white knob on ${offTrack(vars)} is ${ratio.toFixed(2)}:1` : null;
    }).filter(Boolean);
    expect(failures).toEqual([]);
  });

  it("has a track at 3:1 or more on every surface, in every light theme", () => {
    const failures = list.filter(({ scheme }) => scheme === "light").flatMap(({ name, vars }) => SURFACES.map((surface) => {
      const ratio = contrast(offTrack(vars), vars[`theme-${surface}`]);
      return ratio < 3 ? `${name}: track ${offTrack(vars)} on ${surface} ${vars[`theme-${surface}`]} is ${ratio.toFixed(2)}:1` : null;
    })).filter(Boolean);
    expect(failures).toEqual([]);
  });
});
