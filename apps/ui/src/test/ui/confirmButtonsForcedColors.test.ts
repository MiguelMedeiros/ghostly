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

/**
 * The app's other answers on the accent fill: a dialog's Send or Save, Unlock, The codes match, a card's or a bubble's
 * button. Each class list in the file that is on the accent fill with the accent's own text colour (`pick` narrows it
 * where the file also has badges or a chosen look, which forced colors draw their own way) keeps the same edge.
 */
const ACCENT = /(?:^|\s)!?bg-accent(?=\s|$)/;
const ON_ACCENT = /(?:^|\s)!?(?:text-on-accent|text-panel-header)(?=\s|$)/;
/** `disables` per class list, in source order, where a file has answers of both kinds. */
const FILLED: { name: string; file: string; pick?: RegExp; count?: number; disables: boolean | boolean[] }[] = [
  { name: "Forward's Send", file: "components/chat/ForwardDialog.tsx", disables: true },
  { name: "the selection's Forward", file: "hooks/useForwarding.tsx", disables: true },
  { name: "Network's Save", file: "components/NetworkSettings.tsx", disables: false },
  { name: "a chat's hold Save", file: "components/ChatHoldDialog.tsx", disables: true },
  { name: "The codes match", file: "components/ChatConnection.tsx", disables: true },
  { name: "Unlock", file: "components/LockScreen.tsx", pick: /(?:^|\s)w-full(?=\s|$)/, disables: true },
  { name: "the translator's Download", file: "components/TranslateDownloadDialog.tsx", disables: false },
  { name: "Start again", file: "components/ErrorBoundary.tsx", disables: false },
  { name: "an update's Download", file: "pages/Settings.tsx", pick: /(?:^|\s)font-semibold(?=\s|$)/, disables: false },
  { name: "a call's Switch back", file: "components/CallOverlay.tsx", pick: /(?:^|\s)tap-target(?=\s|$)/, disables: false },
  { name: "a status's Save", file: "components/StatusPicker.tsx", disables: true },
  { name: "Send photo", file: "components/composer/CameraCapture.tsx", disables: false },
  { name: "the attachments' Send", file: "components/composer/AttachmentSheet.tsx", disables: false },
  { name: "Translate again and Send translation", file: "components/composer/TranslatePreview.tsx", count: 2, disables: true },
  { name: "Pay externally's Copy", file: "components/PayExternally.tsx", disables: false },
  { name: "a page's Try again", file: "components/MenuPage.tsx", disables: false },
  { name: "an unavailable profile's answers", file: "components/ProfileUnavailable.tsx", disables: false },
  { name: "a Lightning address's answers", file: "components/wallet/LightningAddressPay.tsx", disables: true },
  { name: "Paste, Open chat and Join", file: "components/JoinDialog.tsx", count: 3, disables: [false, false, true] },
  { name: "Send's Scan", file: "components/wallet/SendScan.tsx", disables: false },
  { name: "a chat card's button", file: "components/chat/EntityCardFrame.tsx", disables: true },
  { name: "an invoice's buttons", file: "components/InvoiceBubble.tsx", disables: true },
  { name: "a payment's buttons", file: "components/PaymentBubble.tsx", disables: true },
  { name: "a money format's buttons", file: "components/MoneyFormatsBubble.tsx", disables: true },
  { name: "real money's Send", file: "components/ConfirmRealMoney.tsx", disables: false },
  { name: "a payment review's Approve", file: "components/PaymentReview.tsx", disables: true },
];

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

describe("an accent-filled button in forced colors", () => {
  it.each(FILLED)("$name ($file) has a ButtonText border in forced colors only", ({ file, pick, count = 1, disables }) => {
    const found = classLists(file).filter((classes) => ACCENT.test(classes) && ON_ACCENT.test(classes) && (!pick || pick.test(classes)));
    expect(found, file).toHaveLength(count);
    found.forEach((classes, i) => {
      const names = classes.split(/\s+/);
      for (const name of EDGE) expect(names, classes).toContain(name);
      if (Array.isArray(disables) ? disables[i] : disables) expect(names, classes).toContain(DISABLED_EDGE);
      else expect(names, classes).not.toContain(DISABLED_EDGE);
      expect(names.filter((n) => /^(?:[a-z-]+:)*border(-|$)/.test(n) && !n.startsWith("forced-colors:")), classes).toEqual([]);
    });
  });
});
