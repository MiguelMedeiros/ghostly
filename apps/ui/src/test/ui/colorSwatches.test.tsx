import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ColorSwatches } from "../../components/ColorSwatches";
import { renderApp } from "../render";

// covers: app.theme, app.accessibility

const THEMES = ["classic", "monochrome", "cyan", "purple"];

function open(language?: "ar") {
  const view = renderApp(<ColorSwatches label="Color theme" testIdPrefix="settings-theme" />, language ? { language } : undefined);
  const group = screen.getByRole("radiogroup", { name: "Color theme" });
  const swatch = (id: string) => within(group).getByTestId(`settings-theme-${id}`);
  const focused = () => document.activeElement?.getAttribute("data-testid")?.replace("settings-theme-", "");
  const checked = () => THEMES.filter(id => swatch(id).getAttribute("aria-checked") === "true");
  return { ...view, group, swatch, focused, checked };
}

/**
 * Settings → Appearance's colour swatches were a radiogroup the arrow keys did nothing in, each swatch its own Tab stop.
 * Now one Tab stop (the chosen theme), and the arrows, Home and End move and choose, as a native radio group does.
 */
describe("the colour theme swatches, by keyboard", () => {
  it("are one Tab stop, the chosen theme", async () => {
    const { user, swatch, focused } = open();
    // Cyan is the default theme.
    expect(THEMES.map(id => swatch(id).tabIndex)).toEqual([-1, -1, 0, -1]);
    const before = document.createElement("button");
    document.body.prepend(before);
    before.focus();
    await user.tab();
    expect(focused()).toBe("cyan");
    await user.tab();
    expect(THEMES).not.toContain(focused()); // out of the group
    before.remove();
  });

  it("move and choose with the arrows, around the ends, and Home and End", async () => {
    const { user, swatch, focused, checked } = open();
    swatch("cyan").focus();
    await user.keyboard("{ArrowRight}");
    expect([focused(), checked()]).toEqual(["purple", ["purple"]]);
    expect(THEMES.map(id => swatch(id).tabIndex)).toEqual([-1, -1, -1, 0]);
    await user.keyboard("{ArrowDown}");
    expect([focused(), checked()]).toEqual(["classic", ["classic"]]); // around the end
    await user.keyboard("{ArrowUp}");
    expect([focused(), checked()]).toEqual(["purple", ["purple"]]);
    await user.keyboard("{ArrowLeft}");
    expect([focused(), checked()]).toEqual(["cyan", ["cyan"]]);
    await user.keyboard("{Home}");
    expect([focused(), checked()]).toEqual(["classic", ["classic"]]);
    await user.keyboard("{End}");
    expect([focused(), checked()]).toEqual(["purple", ["purple"]]);
  });

  it("in Arabic, Left goes on and Right goes back, as the page reads", async () => {
    const { user, group, swatch, focused, checked } = open("ar");
    group.style.direction = "rtl";
    swatch("monochrome").click();
    swatch("monochrome").focus();
    await user.keyboard("{ArrowLeft}");
    expect([focused(), checked()]).toEqual(["cyan", ["cyan"]]);
    await user.keyboard("{ArrowRight}");
    expect([focused(), checked()]).toEqual(["monochrome", ["monochrome"]]);
  });

  it("show the keyboard focus with the accent ring", () => {
    const { swatch } = open();
    for (const id of THEMES) expect(swatch(id).className.split(/\s+/)).toEqual(expect.arrayContaining(["focus-visible:ring-2", "focus-visible:ring-accent"]));
  });
});

/** Each theme block's custom properties by its selector list, and the 8 themes over their scheme's base (as mutedInk.test.ts). */
const CSS = readFileSync(join(fileURLToPath(import.meta.url), "../../..", "index.css"), "utf8");
function themes(): { name: string; vars: Record<string, string> }[] {
  // Split by braces, no regex over the selector lists: the theme blocks hold no nested braces.
  const all = CSS.split("}").map(chunk => chunk.split("{")).filter(parts => parts.length === 2).map(([selector, body]) => ({
    selector: selector.replace(/\/\*[\s\S]*?\*\//g, "").split(";").pop()!.trim(),
    vars: Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()])),
  })).filter(block => block.selector.startsWith(":root"));
  const base = (scheme: "dark" | "light") => all.find(b => scheme === "dark" ? b.selector.startsWith(":root,") : b.selector.startsWith(':root[data-theme="light"],'))!.vars;
  return THEMES.flatMap(color => (["dark", "light"] as const).map(scheme => {
    const own = all.find(b => b.selector.includes(`[data-theme="${scheme}"][data-color-theme="${color}"]`))!.vars;
    return { name: `${color} ${scheme}`, vars: { ...base(scheme), ...own } };
  }));
}
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/**
 * The Monochrome swatch's grey was 1.47:1 on a light card (Cyan's about 1.8:1), with a transparent edge: nearly
 * invisible. Every swatch now has an edge in the muted ink, which reaches 3:1 (WCAG 1.4.11) on the card (`bg-surface`,
 * as Settings and Profile draw their sections) in every theme; the theme colours themselves are unchanged.
 */
describe("the colour theme swatches, seen", () => {
  it("each have an edge of 3:1 or more on the card, in every theme, dark and light", () => {
    const { swatch } = open();
    for (const id of THEMES) {
      const classes = swatch(id).className.split(/\s+/);
      expect(classes, id).not.toContain("border-transparent");
      expect(classes.some(c => c === "border" || c === "border-2"), id).toBe(true);
      expect(classes.filter(c => /^border-text-(muted|primary)$/.test(c)), id).toHaveLength(1);
    }
    const list = themes();
    expect(list).toHaveLength(8);
    const below = list.flatMap(({ name, vars }) => (["text-muted", "text-primary"] as const)
      .map(ink => ({ name, ink, ratio: Math.round(contrast(vars[`theme-${ink}`], vars["theme-surface"]) * 100) / 100 }))
      .filter(({ ratio }) => ratio < 3));
    expect(below).toEqual([]);
  });
});
