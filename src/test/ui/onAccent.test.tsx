import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { AdvancedSettings, Settings } from "../../pages/Settings";
import { renderApp } from "../render";

// covers: app.theme.on-accent

/**
 * The accent is dark in some themes (#0a0a0a in monochrome light) and white in others (monochrome dark), so no fixed
 * ink reads on it everywhere: text on `bg-accent` takes `text-on-accent`, which each theme sets in src/index.css.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");

/** A solid accent background (`bg-accent`, `!bg-accent`, `bg-accent-hover`), not a tint like `bg-accent/20`. */
const ON_ACCENT = /(?:^|\s)!?bg-accent(?:-hover)?(?=\s|$)/;
/** A fixed ink: white, black, or a hex/rgb/hsl colour in brackets. */
const FIXED_INK = /(?:^|\s)!?text-(?:white|black|\[(?:#|rgba?\(|hsla?\())[^\s]*/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Every class list a file spells out: each string literal, and each template literal with its `${…}` parts left out
 * (a ternary inside is read as its own strings, so one branch's accent is not paired with the other branch's ink).
 */
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

describe("text on the accent", () => {
  it("never pairs bg-accent with a fixed ink anywhere in src/", () => {
    const offenders = sources(SRC).flatMap((file) =>
      classLists(file)
        .filter(({ classes }) => ON_ACCENT.test(classes) && FIXED_INK.test(classes))
        .map(({ line, classes }) => `${relative(SRC, file)}:${line} ${classes.match(FIXED_INK)![0].trim()}`));
    expect(offenders).toEqual([]);
  });

  it("the scan sees the class lists it should", () => {
    const sample = classLists(join(SRC, "components/MessageInput.tsx")).filter(({ classes }) => ON_ACCENT.test(classes));
    expect(sample.length).toBeGreaterThan(0);
    expect(sample.every(({ classes }) => /(?:^|\s)text-on-accent(?:\s|$)/.test(classes))).toBe(true);
  });

  it("Settings' chosen options and buttons take the theme's ink on the accent", () => {
    const { container } = renderApp(
      <LockScreenProvider>
        <UpdateProvider>
          <Settings />
          <AdvancedSettings />
        </UpdateProvider>
      </LockScreenProvider>,
      { route: "/settings" },
    );
    // A switch's track is accent too, with nothing written on it: only what carries text needs the ink.
    const accented = [...container.querySelectorAll<HTMLElement>("[class]")]
      .filter((el) => ON_ACCENT.test(el.getAttribute("class")!) && el.textContent!.trim() !== "");
    expect(accented.map((el) => el.textContent!.trim())).toEqual(expect.arrayContaining(["Dark", "Compact", "Save"]));
    for (const el of accented) {
      expect(el).toHaveClass("text-on-accent");
      expect(FIXED_INK.test(el.getAttribute("class")!)).toBe(false);
    }
  });
});
