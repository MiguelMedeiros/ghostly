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
 * So does every other button drawn by the accent fill alone: Forward's Send and the selection's Forward, Network's and a
 * chat hold's Save, The codes match, Unlock, and the rest below.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");
const EDGE = ["forced-colors:border", "forced-colors:border-[color:ButtonText]"];
const DISABLED_EDGE = "forced-colors:disabled:border-[color:GrayText]";

const ACCENT = /(?:^|\s)bg-accent(?=\s|$)/;
/** Each answer: its file, what picks its class list there (how many share it), and whether it can be disabled. */
const ANSWERS: { name: string; file: string; fill: RegExp; disables: boolean; count?: number; pick?: RegExp }[] = [
  { name: "Forget / Delete chat", file: "components/DeleteChatDialog.tsx", fill: /(?:^|\s)bg-danger\/15(?=\s|$)/, disables: true },
  { name: "Send anyway", file: "components/SecretGuardDialog.tsx", fill: /(?:^|\s)bg-danger\/15(?=\s|$)/, disables: false },
  { name: "Delete folder", file: "components/chat/ChatFolderDialogs.tsx", fill: /(?:^|\s)bg-danger\/15(?=\s|$)/, disables: false },
  { name: "a folder's Save / Create", file: "components/chat/ChatFolderDialogs.tsx", fill: /(?:^|\s)bg-accent(?=\s|$)/, disables: true },
  { name: "Delete profile", file: "components/DeleteProfileDialog.tsx", fill: /(?:^|\s)bg-danger-fill(?=\s|$)/, disables: true },
  { name: "Forward's Send", file: "components/chat/ForwardDialog.tsx", fill: ACCENT, disables: true },
  { name: "the selection's Forward", file: "hooks/useForwarding.tsx", fill: ACCENT, disables: true },
  { name: "Network's Save", file: "components/NetworkSettings.tsx", fill: ACCENT, disables: false },
  { name: "a chat hold's Save", file: "components/ChatHoldDialog.tsx", fill: ACCENT, disables: true },
  { name: "The codes match", file: "components/ChatConnection.tsx", fill: ACCENT, disables: true },
  { name: "Unlock", file: "components/LockScreen.tsx", fill: ACCENT, disables: true },
  { name: "a translation model's Download", file: "components/TranslateDownloadDialog.tsx", fill: ACCENT, disables: false },
  { name: "Start again", file: "components/ErrorBoundary.tsx", fill: ACCENT, disables: false },
  { name: "a manual update's Download", file: "pages/Settings.tsx", fill: ACCENT, disables: false, pick: /font-semibold/ },
  { name: "a call's Switch back", file: "components/CallOverlay.tsx", fill: ACCENT, disables: false, pick: /cursor-pointer/ },
  { name: "a status's Save", file: "components/StatusPicker.tsx", fill: ACCENT, disables: true },
  { name: "Send photo", file: "components/composer/CameraCapture.tsx", fill: ACCENT, disables: false },
  { name: "an attachment's Send", file: "components/composer/AttachmentSheet.tsx", fill: ACCENT, disables: false },
  { name: "Translate again / Send translation", file: "components/composer/TranslatePreview.tsx", fill: ACCENT, disables: true, count: 2 },
  { name: "Pay externally's Copy", file: "components/PayExternally.tsx", fill: ACCENT, disables: false },
  { name: "a page's Try again", file: "components/MenuPage.tsx", fill: ACCENT, disables: false },
  { name: "an unavailable profile's answers", file: "components/ProfileUnavailable.tsx", fill: ACCENT, disables: false },
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
  it.each(ANSWERS)("$name ($file) has a ButtonText border in forced colors only", ({ file, fill, disables, count = 1, pick }) => {
    const found = classLists(file).filter((classes) => fill.test(classes) && /(?:^|\s)(?:text-danger-ink|text-panel-header|text-white|text-on-accent)(?=\s|$)/.test(classes)
      && !/(?:^|\s)forced-colors:bg-/.test(classes) && (!pick || pick.test(classes)));
    expect(found, file).toHaveLength(count);
    for (const classes of found) {
      const names = classes.split(/\s+/);
      for (const name of EDGE) expect(names, classes).toContain(name);
      if (disables) expect(names, classes).toContain(DISABLED_EDGE);
      // Normal colours keep no border: only the forced-colors variants draw one.
      expect(names.filter((n) => /^(?:[a-z-]+:)*border(-|$)/.test(n) && !n.startsWith("forced-colors:")), classes).toEqual([]);
    }
  });
});
