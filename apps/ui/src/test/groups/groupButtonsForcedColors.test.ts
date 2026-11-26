import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// covers: app.accessibility, app.theme

/**
 * Forced colors (Windows Contrast themes) fill every button with the page's colour, so a group's main button drawn by
 * its accent fill alone (an invitation's Accept, New group's Create, the link's Turn on…) read as bare bold text. Each
 * keeps an edge there, as the device screens' and the wallet's buttons do: a ButtonText border in forced colors only.
 * What the browser draws is e2e/web/forced-colors-controls.spec.ts.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");
const FILES = [
  "components/GroupInvitation.tsx", "components/GroupMembersDialog.tsx", "components/GroupLinkPanel.tsx",
  "components/GroupLinkAskDialog.tsx", "components/MakeAdminDialog.tsx", "components/NewGroupDialog.tsx",
  "components/GroupOthers.tsx", "pages/GroupChat.tsx",
];
const EDGE = ["forced-colors:border", "forced-colors:border-[color:ButtonText]"];

/** Each class string (a quoted or template literal) that fills a button with the accent behind panel-coloured text. */
function accentButtons(file: string): string[] {
  const source = readFileSync(join(SRC, file), "utf8");
  return [...source.matchAll(/["`]([^"`]*\bbg-accent\b[^"`]*)["`]/g)].map(([, classes]) => classes)
    .filter((classes) => /\btext-panel-header\b/.test(classes));
}

describe("a group's main buttons in forced colors", () => {
  it.each(FILES)("%s: every accent-filled button has a ButtonText border in forced colors only", (file) => {
    const buttons = accentButtons(file);
    expect(buttons.length, file).toBeGreaterThan(0);
    for (const classes of buttons) keepsAnEdge(file, classes);
  });

  // A question's answer that ends something (Leave group, Remove, Turn off the link) is drawn by its red tint alone:
  // forced colors drop the tint and its red, so it read as Cancel beside it.
  it.each(DANGER_FILES)("%s: the danger-tinted answer has a ButtonText border in forced colors only", (file) => {
    const buttons = dangerButtons(file);
    expect(buttons.length, file).toBeGreaterThan(0);
    for (const classes of buttons) keepsAnEdge(file, classes);
  });

  // The header's pills (Join call, Share link) are drawn by their accent tint alone: forced colors drop it, and they
  // read as bare bold text beside bare icon buttons. Their edge is there all along, see-through in normal colours: one
  // added in forced colors only widened Share link by 2 px and moved the connection dot beside it.
  it.each(TINT_FILES)("%s: the accent-tinted pill has a see-through border that is ButtonText in forced colors", (file) => {
    const buttons = tintedButtons(file);
    expect(buttons.length, file).toBeGreaterThan(0);
    for (const classes of buttons) {
      const names = classes.split(/\s+/);
      for (const name of ["border", "border-transparent", "forced-colors:border-[color:ButtonText]"]) expect(names, `${file}: ${classes}`).toContain(name);
      expect(names.filter((n) => /^forced-colors:border$/.test(n)), `${file}: ${classes}`).toEqual([]);
    }
  });
});

const TINT_FILES = ["components/GroupCallButton.tsx", "pages/GroupChat.tsx"];

/** Each class string that tints a pill button with the accent behind accent text (not a tinted round picture). */
function tintedButtons(file: string): string[] {
  const source = readFileSync(join(SRC, file), "utf8");
  return [...source.matchAll(/["`]([^"`]*\bbg-accent\/15\b[^"`]*)["`]/g)].map(([, classes]) => classes)
    .filter((classes) => /\btext-accent\b/.test(classes) && /\brounded-full\b/.test(classes) && /\bfont-semibold\b/.test(classes));
}

const DANGER_FILES = ["components/LeaveGroupDialog.tsx", "components/RemoveMemberDialog.tsx", "components/GroupLinkAskDialog.tsx"];

/** Each class string that tints a button with the danger colour behind danger ink: a question's answer that ends something. */
function dangerButtons(file: string): string[] {
  const source = readFileSync(join(SRC, file), "utf8");
  return [...source.matchAll(/["`]([^"`]*\bbg-danger\/15\b[^"`]*)["`]/g)].map(([, classes]) => classes)
    .filter((classes) => /\btext-danger-ink\b/.test(classes));
}

function keepsAnEdge(file: string, classes: string): void {
  const names = classes.split(/\s+/);
  for (const name of EDGE) expect(names, `${file}: ${classes}`).toContain(name);
  // Normal colours keep no border: only the forced-colors variant draws one.
  expect(names.filter((n) => /^border(-|$)/.test(n)), `${file}: ${classes}`).toEqual([]);
}
