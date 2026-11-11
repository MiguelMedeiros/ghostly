import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { escapeRegExp } from "../regExp";

// covers: app.accessibility

/**
 * A text field (the shared one of Profile and the wallets, Settings, Network, the Settings and chat searches, the
 * message composer, Profile's name) has an edge
 * at 3:1 or more on what is around it, in every colour theme (WCAG 1.4.11): its fill is the panel's or close to it, so
 * a pale border, or none, left a filled or empty field with no visible boundary.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");
const read = (file: string) => readFileSync(join(SRC, file), "utf8");
const CSS = read("index.css");

/** Each theme block's custom properties, by its selector list (as switchOff.test.ts reads them). */
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

/** A Tailwind colour name (`border-<name>`, `ring-<name>`, `var(--color-<name>)`) to its colour in one theme; null when it draws nothing. */
function resolve(color: string, vars: Record<string, string>): string | null {
  if (color === "transparent") return null;
  const alias = CSS.match(new RegExp(`--color-${color}: var\\(--(theme-[\\w-]+)(?:, var\\(--(theme-[\\w-]+)\\))?\\);`));
  if (!alias) return null;
  return vars[alias[1]] ?? (alias[2] ? vars[alias[2]] : undefined) ?? null;
}

/** The colour class of a field's resting edge in a class list: a plain `border-<c>` or an inset `ring-<c>`, not a state's. */
function restingEdge(classes: string): string | null {
  for (const cls of classes.split(/\s+/)) {
    if (cls.includes(":")) continue;
    const edge = cls.match(/^(?:border|ring)-([a-z][\w-]*)$/);
    if (edge && !["inset", "none"].includes(edge[1])) return edge[1];
  }
  return null;
}

/** A class string in `file`, found by a piece of it unique to that field. */
function classesWith(file: string, marker: string): string {
  const found = [...read(file).matchAll(/"([^"\n]*)"/g)].map(m => m[1]).find(s => s.includes(marker));
  expect(found, `${file}: ${marker}`).toBeTruthy();
  return found!;
}

/** The composer's well edge per scheme (composer.css): `--composer-well-edge`, dark from :root, light from its own block. */
function composerEdge(scheme: "dark" | "light"): string | null {
  const css = read("components/composer/composer.css");
  const block = (selector: string) => css.match(new RegExp(`${escapeRegExp(selector)} \\{([^}]*)\\}`))?.[1] ?? "";
  const edge = (body: string) => body.match(/--composer-well-edge:\s*([^;]+);/)?.[1].trim();
  const value = (scheme === "light" ? edge(block(':root[data-theme="light"]')) : undefined) ?? edge(block(":root"));
  return value?.match(/^var\(--color-([\w-]+)\)$/)?.[1] ?? value ?? null;
}

const FIELDS: { name: string; edge: (scheme: "dark" | "light") => string | null }[] = [
  { name: "the shared field (Profile's name in chats, wallets, identities)", edge: () => restingEdge(classesWith("components/wallet/ui.tsx", "w-full min-w-0 bg-surface-alt text-text-primary px-3 py-2")) },
  { name: "Settings' fields (nickname, password)", edge: () => restingEdge(classesWith("pages/Settings.tsx", "w-full min-w-0 px-3 py-2 min-h-10 bg-input-bg")) },
  { name: "Network's fields (relays, Iroh, HyperDHT, push, TURN)", edge: () => restingEdge(classesWith("components/NetworkSettings.tsx", "w-full min-w-0 px-3 py-2 min-h-10 bg-input-bg")) },
  { name: "Settings search", edge: () => restingEdge(classesWith("components/settings/SettingsMenu.tsx", "ps-9 pe-3 py-2 min-h-10 bg-input-bg")) },
  { name: "Search chats", edge: () => restingEdge(classesWith("components/Sidebar.tsx", "bg-search-bg rounded-lg px-3 py-1.5")) },
  { name: "Profile's name", edge: () => restingEdge(classesWith("pages/Profile.tsx", "bg-transparent text-xl font-semibold")) },
  { name: "the message composer", edge: composerEdge },
];

/** Every surface a field is drawn on or filled with: the panels, the cards, the page, the chat, a field's own fill. */
const SURFACES = ["app-bg", "sidebar-bg", "chat-bg", "panel-header", "surface", "surface-alt", "input-bg", "search-bg"];

describe("a text field's edge", () => {
  const list = themes();

  it("reads at 3:1 or more on every surface around it, in every colour theme", () => {
    expect(list).toHaveLength(8);
    const failures = FIELDS.flatMap(field => list.flatMap(({ name, scheme, vars }) => {
      const token = field.edge(scheme);
      const color = token ? resolve(token, vars) : null;
      if (!color) return [`${field.name}, ${name}: no edge (${token ?? "none"})`];
      return SURFACES.map(surface => {
        const ratio = contrast(color, vars[`theme-${surface}`]);
        return ratio < 3 ? `${field.name}, ${name}: ${token} ${color} on ${surface} is ${ratio.toFixed(2)}:1` : null;
      });
    })).filter(Boolean);
    expect(failures).toEqual([]);
  });
});
