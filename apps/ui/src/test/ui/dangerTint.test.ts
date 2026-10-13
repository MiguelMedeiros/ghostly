import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// covers: app.accessibility

/**
 * A dialog's red confirm (Delete, Leave, Remove) is danger's words on a light tint of danger (`bg-danger/15`) over the
 * dialog's surface. Danger's own red read there at 3.9-4.3:1 on dark themes: the words take `text-danger-ink`, the red
 * for words, which reads at 4.5:1 there in every theme.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");
const CSS = readFileSync(join(SRC, "index.css"), "utf8");

/** Each theme block's custom properties, by its selector list (as dangerFill.test.ts reads them). */
function blocks(): { selector: string; vars: Record<string, string> }[] {
  const out: { selector: string; vars: Record<string, string> }[] = [];
  for (const match of CSS.matchAll(/((?::root[^{,]*,?\s*)+)\{([^}]*)\}/g)) {
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
/** `color` at `alpha` over `under`, as the page paints `bg-danger/15`. */
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

/** A resting tint of danger under the words (`bg-danger/15`), not a hover's or a solid red. */
const TINT = /(?:^|\s)bg-danger\/(?:1\d|2\d)(?=\s|$)/;
const DANGER_WORDS = /(?:^|\s)text-danger(?=\s|$)/;

describe("danger's words on danger's tint", () => {
  const list = themes();

  it("read at WCAG AA (4.5:1) in danger's ink on the dialog surface, in every theme", () => {
    expect(list).toHaveLength(8);
    expect(CSS).toContain("--color-danger-ink: var(--theme-danger-ink);");
    const failures = list
      .map(({ name, vars }) => ({ name, ink: vars["theme-danger-ink"], ratio: contrast(rgb(vars["theme-danger-ink"]), over(vars["theme-danger"], 0.15, vars["theme-sidebar-bg"])) }))
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ name, ink, ratio }) => `${name}: ${ink} on danger/15 is ${ratio.toFixed(2)}:1`);
    expect(failures).toEqual([]);
  });

  it("are never danger's own red anywhere in apps/ui/src/: they take text-danger-ink", () => {
    const offenders = sources(SRC).flatMap((file) =>
      classLists(file)
        .filter(({ classes }) => TINT.test(classes) && DANGER_WORDS.test(classes))
        .map(({ line, classes }) => `${relative(SRC, file)}:${line} ${classes.match(TINT)![0].trim()}`));
    expect(offenders).toEqual([]);
  });

  it("the scan sees the Delete chat dialog's confirm on the tint", () => {
    const tinted = classLists(join(SRC, "components/DeleteChatDialog.tsx")).filter(({ classes }) => TINT.test(classes) && /(?:^|\s)text-danger-ink(?=\s|$)/.test(classes));
    expect(tinted).toHaveLength(1);
  });
});
