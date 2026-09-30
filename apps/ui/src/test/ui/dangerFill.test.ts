import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// covers: app.accessibility

/**
 * Danger's red is bright on dark themes so its words read on dark surfaces, but white words on that red read at
 * 3.9:1. Where danger is a fill under white (Delete, hang up, decline), it takes `bg-danger-fill`, a red dark enough
 * for 4.5:1 with white in every theme. Light themes keep the red they had.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");
const CSS = readFileSync(join(SRC, "index.css"), "utf8");

/** Each theme block's custom properties, by its selector list (as memberColors.test.ts reads them). */
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

/** The solid danger red (`bg-danger`, `hover:bg-danger/80`), not its fill or a light tint like `bg-danger/10`. */
const SOLID_DANGER = /(?:^|\s)(?:[a-z-]+:)*!?bg-danger(?:\/[5-9]0)?(?=\s|$)/;
const WHITE = /(?:^|\s)(?:[a-z-]+:)*!?text-white(?=\s|$)/;

describe("white words on danger's red", () => {
  const list = themes();

  it("read at WCAG AA (4.5:1) on the danger fill, in every theme", () => {
    expect(list).toHaveLength(8);
    expect(CSS).toContain("--color-danger-fill: var(--theme-danger-fill);");
    const failures = list
      .map(({ name, vars }) => ({ name, fill: vars["theme-danger-fill"], ratio: vars["theme-danger-fill"] ? contrast("#ffffff", vars["theme-danger-fill"]) : 0 }))
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ name, fill, ratio }) => `${name}: white on ${fill} is ${ratio.toFixed(2)}:1`);
    expect(failures).toEqual([]);
  });

  it("light themes keep their red, and dark themes keep their brighter red for danger's words", () => {
    for (const { name, scheme, vars } of list) {
      if (scheme === "light") expect(vars["theme-danger-fill"], name).toBe("#c5221f");
      expect(vars["theme-danger"], name).toBe(scheme === "light" ? "#c5221f" : "#ea4335");
    }
  });

  it("are never set on the bright danger red anywhere in apps/ui/src/: they take bg-danger-fill", () => {
    const offenders = sources(SRC).flatMap((file) =>
      classLists(file)
        .filter(({ classes }) => SOLID_DANGER.test(classes) && WHITE.test(classes))
        .map(({ line, classes }) => `${relative(SRC, file)}:${line} ${classes.match(SOLID_DANGER)![0].trim()}`));
    expect(offenders).toEqual([]);
  });

  it("the scan sees Delete, hang up and decline on the fill", () => {
    const filled = ["components/DeleteProfileDialog.tsx", "components/CallOverlay.tsx", "components/IncomingCallNotification.tsx"]
      .flatMap((file) => classLists(join(SRC, file)).filter(({ classes }) => /(?:^|\s)bg-danger-fill(?=\s|$)/.test(classes) && WHITE.test(classes)));
    expect(filled).toHaveLength(3);
  });
});
