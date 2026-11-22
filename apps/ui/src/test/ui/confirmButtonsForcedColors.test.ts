import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// covers: app.accessibility, app.theme

/**
 * Forced colors (Windows Contrast themes) drop a button's fill, so a dialog's answer drawn by its fill alone (a group's
 * or a chat's Forget/Delete on danger's tint, Send anyway, Delete folder, a folder's Save, Delete profile on the red
 * fill) read as bare text, the same as Cancel beside it. Each keeps an edge there, as Leave group's and Remove member's
 * do: a ButtonText border in forced colors only, GrayText while the answer is disabled (the browser greys its words).
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");
const EDGE = ["forced-colors:border", "forced-colors:border-[color:ButtonText]"];
const DISABLED_EDGE = "forced-colors:disabled:border-[color:GrayText]";

/** Each answer: its file, what picks its class list there, and whether it can be disabled. */
const ANSWERS: { name: string; file: string; fill: RegExp; disables: boolean }[] = [
  { name: "Forget / Delete chat", file: "components/DeleteChatDialog.tsx", fill: /(?:^|\s)bg-danger\/15(?=\s|$)/, disables: true },
  { name: "Send anyway", file: "components/SecretGuardDialog.tsx", fill: /(?:^|\s)bg-danger\/15(?=\s|$)/, disables: false },
  { name: "Delete folder", file: "components/chat/ChatFolderDialogs.tsx", fill: /(?:^|\s)bg-danger\/15(?=\s|$)/, disables: false },
  { name: "a folder's Save / Create", file: "components/chat/ChatFolderDialogs.tsx", fill: /(?:^|\s)bg-accent(?=\s|$)/, disables: true },
  { name: "Delete profile", file: "components/DeleteProfileDialog.tsx", fill: /(?:^|\s)bg-danger-fill(?=\s|$)/, disables: true },
];

/** Every class list a file spells out: string literals, and template literals without their `${…}` parts. */
function classLists(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(join(SRC, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) out.push([node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" "));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe("a dialog's filled answer in forced colors", () => {
  it.each(ANSWERS)("$name ($file) has a ButtonText border in forced colors only", ({ file, fill, disables }) => {
    const found = classLists(file).filter((classes) => fill.test(classes) && /(?:^|\s)(?:text-danger-ink|text-panel-header|text-white)(?=\s|$)/.test(classes));
    expect(found, file).toHaveLength(1);
    const names = found[0].split(/\s+/);
    for (const name of EDGE) expect(names, found[0]).toContain(name);
    if (disables) expect(names, found[0]).toContain(DISABLED_EDGE);
    // Normal colours keep no border: only the forced-colors variants draw one.
    expect(names.filter((n) => /^(?:[a-z-]+:)*border(-|$)/.test(n) && !n.startsWith("forced-colors:")), found[0]).toEqual([]);
  });
});
