import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// covers: app.accessibility, app.theme

/**
 * A group header's pills (Share link, Join call) are the accent's words on a tint of the accent (`bg-accent/15`) over
 * the header. Under the pointer the tint went to 25 % and the words stayed the accent: 3.9-4.4:1 in Classic, Cyan
 * light and Purple, under WCAG AA's 4.5:1 for their 14 px words. axe checks them only at rest. Hovered they take a
 * lighter tint and the theme's hover accent, which reads at 4.5:1 there in every theme.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");
const CSS = readFileSync(join(SRC, "index.css"), "utf8");

/** Each theme block's custom properties, by its selector list (from its first `:root` to its `{`). */
function blocks(): { selector: string; vars: Record<string, string> }[] {
  const out: { selector: string; vars: Record<string, string> }[] = [];
  for (const match of CSS.matchAll(/(:root[^{]*)\{([^}]*)\}/g)) {
    const vars: Record<string, string> = {};
    for (const [, name, value] of match[2].matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[name] = value.trim();
    out.push({ selector: match[1].trim(), vars });
  }
  return out;
}

function themes(): { name: string; vars: Record<string, string> }[] {
  const all = blocks();
  const base = (scheme: "dark" | "light") => all.find(b => scheme === "dark" ? b.selector.startsWith(":root,") : b.selector.startsWith(':root[data-theme="light"],'))!.vars;
  return ["classic", "monochrome", "cyan", "purple"].flatMap(color => (["dark", "light"] as const).map(scheme => {
    const own = all.find(b => b.selector.includes(`[data-theme="${scheme}"][data-color-theme="${color}"]`))!.vars;
    return { name: `${color} ${scheme}`, vars: { ...base(scheme), ...own } };
  }));
}

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const luminance = (channels: number[]) => {
  const [r, g, b] = channels.map(c => c / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** `color` at `alpha` over `under`, as the page paints `bg-accent/15`. */
const over = (color: string, alpha: number, under: string) => rgb(color).map((c, i) => c * alpha + rgb(under)[i] * (1 - alpha));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Every class list a file spells out: string literals, and template literals without their `${…}` parts. */
function classLists(file: string): { line: number; classes: string }[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: { line: number; classes: string }[] = [];
  const add = (node: ts.Node, classes: string) => out.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, classes });
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateExpression(node)) add(node, [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" "));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** A pill of the accent's words on its tint that changes the tint under the pointer. */
const HOVER_TINT = /(?:^|\s)hover:bg-accent\/(\d+)(?=\s|$)/;
const WORDS = /(?:^|\s)text-accent(?=\s|$)/;
const HOVER_WORDS = /(?:^|\s)hover:text-(accent(?:-hover)?)(?=\s|$)/;

function pills(): { at: string; tint: number; words: string }[] {
  return sources(SRC).flatMap((file) => classLists(file)
    .filter(({ classes }) => HOVER_TINT.test(classes) && WORDS.test(classes))
    .map(({ line, classes }) => ({
      at: `${relative(SRC, file)}:${line}`,
      tint: Number(classes.match(HOVER_TINT)![1]) / 100,
      words: classes.match(HOVER_WORDS)?.[1] ?? "accent",
    })));
}

describe("an accent pill under the pointer", () => {
  it("finds the group header's Share link and Join call", () => {
    const at = pills().map(({ at }) => at.replace(/:\d+$/, ""));
    expect(at).toEqual(expect.arrayContaining(["pages/GroupChat.tsx", "components/GroupCallButton.tsx"]));
  });

  it("reads at WCAG AA (4.5:1) on its hover tint over the header, in every theme", () => {
    const list = themes();
    expect(list).toHaveLength(8);
    const failures = pills().flatMap(({ at, tint, words }) => list.map(({ name, vars }) => {
      const ratio = contrast(rgb(vars[`theme-${words}`]), over(vars["theme-accent"], tint, vars["theme-panel-header"]));
      return ratio < 4.5 ? `${at} ${name}: ${words} on accent/${tint * 100} is ${ratio.toFixed(2)}:1` : null;
    })).filter(Boolean);
    expect(failures).toEqual([]);
  });
});
