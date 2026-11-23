import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// covers: app.accessibility, app.theme

/**
 * Forced colors (Windows Contrast themes) drop a button's fill, so a button drawn by its fill alone (a dialog's Send or
 * Save on the accent, Forget/Delete on danger's tint, Delete profile on the red fill, a card's or a bubble's button)
 * reads as bare text there, the same as Cancel beside it. Each keeps an edge in forced colors: a ButtonText border
 * (or a border it draws in every mode, which forced colors paint in their own colour), and GrayText while it is
 * disabled, as the browser greys its words then.
 *
 * Not a table of files: every class list under `apps/ui/src` on the accent or danger fill with its on-fill text is
 * checked, so a new filled button in any file needs the edge too. What forced colors draw another way is let through
 * by what it is (an `aria-hidden` badge, a chosen look, a round icon), never by the file it sits in. A `${constant}` in a
 * class list is read as the classes it holds (`${FORCED_EDGE}` passes on its own border, the wallet's chosen action tab
 * on the `border` it has in every state), so a shared constant that loses its edge turns this red too.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");
const EDGE = ["forced-colors:border", "forced-colors:border-[color:ButtonText]"];
const DISABLED_EDGE = "forced-colors:disabled:border-[color:GrayText]";

const ACCENT = /(?:^|\s)!?bg-accent(?=\s|$)/;
const ON_ACCENT = /(?:^|\s)!?(?:text-on-accent|text-panel-header)(?=\s|$)/;
const DANGER = /(?:^|\s)!?bg-danger(?:-fill|\/\d+)(?=\s|$)/;
const ON_DANGER = /(?:^|\s)!?(?:text-white|text-danger-ink|text-on-danger)(?=\s|$)/;
/** A border drawn in every mode (forced colors keep it, in their own colour). `border-none` and `border-0` draw none. */
const PLAIN_BORDER = /(?:^|\s)!?border(?:-[1-9]\d*)?(?=\s|$)/;
/** Elements a person uses: these need the edge. Any other element on a fill (a notice, a badge) is words, not a button. */
const CONTROL_TAGS = new Set(["button", "a", "input", "select", "summary", "label"]);
const CONTROL_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option"]);

/** What forced colors draw their own way, by a mark in the code itself (so code that moves stays covered). */
const ALLOWED: { reason: string; mark: string }[] = [
  { mark: "aria-hidden", reason: "an unread/count badge, a step dot or a check mark: hidden from assistive tech, its button (if any) has its own edge" },
  { mark: "not a control", reason: "a notice or a corner mark on a fill (a <p>, a <div>, a <span>), not a button itself: its words read right as words" },
  { mark: "round icon", reason: "a call's round Accept, Decline or hang-up: no words, only an icon forced colors draw in ButtonText" },
  { mark: "chosenInForcedColors", reason: "a chosen tab or pill: drawn in Highlight/HighlightText there instead (wallet/ui.tsx)" },
];

/** Every .ts/.tsx file under apps/ui/src, tests left out. */
function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["test", "__tests__", "node_modules"].includes(entry.name) ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.(?:test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [relative(SRC, path)] : [];
  });
}

const parsed = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  let source = parsed.get(file);
  if (!source) {
    source = ts.createSourceFile(file, readFileSync(join(SRC, file), "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    parsed.set(file, source);
  }
  return source;
}

/** Every class list a file spells out: string literals, and template literals without their `${…}` parts. */
function classLists(file: string): { text: string; node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression }[] {
  const out: ReturnType<typeof classLists> = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push({ text: node.text, node });
    else if (ts.isTemplateExpression(node)) out.push({ text: [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" "), node });
    ts.forEachChild(node, visit);
  };
  visit(parse(file));
  return out;
}

const FILES = sourceFiles();

/** Exported string constants of the whole tree, by name (FORCED_EDGE, chosenInForcedColors, ACCEPT, …). */
const exported = new Map<string, { file: string; decl: ts.VariableDeclaration }[]>();
for (const file of FILES) {
  for (const statement of parse(file).statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const decl of statement.declarationList.declarations) if (ts.isIdentifier(decl.name)) exported.set(decl.name.text, [...(exported.get(decl.name.text) ?? []), { file, decl }]);
  }
}

/** The `const` a name in `${…}` refers to: the nearest one in scope in this file, else the tree's one export of it. */
function declarationOf(name: string, at: ts.Node): ts.VariableDeclaration | undefined {
  for (let scope: ts.Node | undefined = at.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const decl = statement.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
      if (decl) return decl;
    }
  }
  const found = exported.get(name);
  return found?.length === 1 ? found[0].decl : undefined;
}

/** The classes a `${…}` part adds, when it is a constant this tree spells out (`${FORCED_EDGE}`, `${button}`). */
function resolve(expression: ts.Expression, seen: Set<ts.Node>): string {
  if (!ts.isIdentifier(expression)) return "";
  const init = declarationOf(expression.text, expression)?.initializer;
  if (!init || seen.has(init)) return "";
  seen.add(init);
  if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) return init.text;
  if (ts.isTemplateExpression(init)) return fullText(init, seen);
  return "";
}

function fullText(node: ts.TemplateExpression, seen: Set<ts.Node>): string {
  return [node.head.text, ...node.templateSpans.flatMap((span) => [resolve(span.expression, seen), span.literal.text])].join(" ");
}

/** A class list with its `${constant}` parts filled in, and the template literals it sits in (`${on ? "bg-accent …" : …}`). */
function effective(node: ts.Node, text: string): { text: string; names: Set<string> } {
  const names = new Set<string>();
  const parts = [ts.isTemplateExpression(node) ? fullText(node, new Set()) : text];
  const collect = (template: ts.TemplateExpression) => template.templateSpans.forEach((span) => ts.isIdentifier(span.expression) && names.add(span.expression.text));
  if (ts.isTemplateExpression(node)) collect(node);
  for (let up = node.parent; up && !ts.isJsxAttribute(up) && !ts.isVariableDeclaration(up); up = up.parent) {
    if (ts.isTemplateExpression(up)) { parts.push(fullText(up, new Set())); collect(up); }
  }
  return { text: parts.join(" "), names };
}

type Element = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
const attribute = (element: Element, name: string) =>
  element.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);

/** JSX elements whose attributes mention a name (`className={DECLINE}`, `className={pill(on)}`), in one file. */
function usesIn(file: string, name: string, seen: Set<string>): Element[] {
  const out: Element[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === name && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)) out.push(...owners(node, file, seen));
    ts.forEachChild(node, visit);
  };
  visit(parse(file));
  return out;
}

/** The elements a class list ends up on: the one whose attribute holds it, or the users of the `const` holding it. */
function owners(node: ts.Node, file: string, seen = new Set<string>()): Element[] {
  for (let up = node.parent; up; up = up.parent) {
    if (ts.isJsxAttribute(up)) return [up.parent.parent];
    if ((ts.isVariableDeclaration(up) || ts.isFunctionDeclaration(up)) && up.name && ts.isIdentifier(up.name)) {
      const name = up.name.text;
      const key = `${file}:${name}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const isExported = hasExport(ts.isVariableDeclaration(up) ? up.parent.parent : up);
      return (isExported ? FILES : [file]).flatMap((other) => usesIn(other, name, seen));
    }
  }
  return [];
}

function hasExport(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

const tagOf = (element: Element) => element.tagName.getText();
const literal = (attr: ts.JsxAttribute | undefined) => (attr?.initializer && ts.isStringLiteral(attr.initializer) ? attr.initializer.text : undefined);

function isControl(element: Element): boolean {
  const tag = tagOf(element);
  if (!/^[a-z]/.test(tag) || CONTROL_TAGS.has(tag)) return true;
  if (attribute(element, "onClick") || attribute(element, "onKeyDown") || attribute(element, "tabIndex")) return true;
  const role = literal(attribute(element, "role"));
  return role !== undefined && CONTROL_ROLES.has(role);
}

const ICON = /^(?:svg|Spinner|\w*Icon)$/;
/** No words of its own: only icons (an <svg>, an `…Icon`, a spinner while it works) and spaces inside it. */
function iconOnly(element: Element): boolean {
  if (ts.isJsxSelfClosingElement(element)) return false;
  const icon = (node: ts.Node): boolean => {
    if (ts.isJsxText(node)) return node.text.trim() === "";
    if (ts.isJsxElement(node)) return ICON.test(tagOf(node.openingElement));
    if (ts.isJsxSelfClosingElement(node)) return ICON.test(tagOf(node));
    if (ts.isParenthesizedExpression(node)) return icon(node.expression);
    if (ts.isConditionalExpression(node)) return icon(node.whenTrue) && icon(node.whenFalse);
    if (ts.isJsxExpression(node)) return !node.expression || icon(node.expression);
    return false;
  };
  return element.parent.children.every(icon);
}

const canBeDisabled = (element: Element) => {
  const attr = attribute(element, "disabled");
  return !!attr && !(attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression?.kind === ts.SyntaxKind.FalseKeyword);
};

const ariaHidden = (element: Element) => {
  const attr = attribute(element, "aria-hidden");
  if (!attr) return false;
  const value = attr.initializer;
  return !value || literal(attr) === "true" || (ts.isJsxExpression(value) && value.expression?.kind === ts.SyntaxKind.TrueKeyword);
};

/** Why forced colors may draw this one without the edge, if any (an ALLOWED mark). */
function allowedBy(text: string, names: Set<string>, on: Element[]): string | undefined {
  if (names.has("chosenInForcedColors")) return "chosenInForcedColors";
  if (on.length === 0) return undefined;
  if (on.every(ariaHidden)) return "aria-hidden";
  if (on.every((element) => !isControl(element))) return "not a control";
  if (/(?:^|\s)rounded-full(?=\s|$)/.test(text) && on.every(iconOnly)) return "round icon";
  return undefined;
}

type Checked = { where: string; classes: string; allowed?: string; misses: string[] };
const checked: Checked[] = FILES.flatMap((file) =>
  classLists(file).flatMap(({ text, node }) => {
    const own = effective(node, text);
    if (!((ACCENT.test(text) && ON_ACCENT.test(own.text)) || (DANGER.test(text) && ON_DANGER.test(own.text)))) return [];
    const where = `${file}:${parse(file).getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    const on = owners(node, file);
    const allowed = allowedBy(own.text, own.names, on);
    const names = own.text.split(/\s+/);
    const misses: string[] = [];
    if (!allowed) {
      if (!EDGE.every((name) => names.includes(name)) && !PLAIN_BORDER.test(own.text)) misses.push("no ButtonText edge in forced colors");
      // Can be disabled: its element takes `disabled`; or its own classes (not a shared base's) style a disabled look and
      // its element is not known, or takes props it is passed (`{...props}`).
      const looksDisabled = text.split(/\s+/).some((name) => name.split(":").slice(0, -1).includes("disabled"));
      const disables = on.some(canBeDisabled) || (looksDisabled && (on.length === 0 || on.some((element) => element.attributes.properties.some(ts.isJsxSpreadAttribute))));
      if (disables && !names.includes(DISABLED_EDGE)) misses.push(`can be disabled but has no ${DISABLED_EDGE}`);
    }
    return [{ where, classes: own.text.replace(/\s+/g, " ").trim(), allowed, misses }];
  }),
);

describe("a filled button in forced colors", () => {
  it("every class list on the accent or danger fill with its on-fill text keeps a ButtonText edge (GrayText when disabled)", () => {
    const misses = checked.filter((c) => c.misses.length).map((c) => `${c.where}: ${c.misses.join("; ")}\n    ${c.classes}`);
    expect(misses).toEqual([]);
  });

  it("the walk sees the app's filled answers (it did not go blind)", () => {
    const files = new Set(checked.filter((c) => !c.allowed).map((c) => c.where.replace(/:\d+$/, "")));
    for (const file of ["components/DeleteChatDialog.tsx", "components/DeleteProfileDialog.tsx", "components/SecretGuardDialog.tsx", "components/chat/ChatFolderDialogs.tsx"]) {
      expect([...files], file).toContain(file);
    }
    expect(checked.filter((c) => !c.allowed).length).toBeGreaterThan(30);
  });

  it.each(ALLOWED)("the allow-list's \"$mark\" still lets something through ($reason)", ({ mark }) => {
    expect(checked.some((c) => c.allowed === mark)).toBe(true);
  });
});
