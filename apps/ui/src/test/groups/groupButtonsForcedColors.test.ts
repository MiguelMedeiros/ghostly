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
    for (const classes of buttons) {
      const names = classes.split(/\s+/);
      for (const name of EDGE) expect(names, `${file}: ${classes}`).toContain(name);
      // Normal colours keep no border: only the forced-colors variant draws one.
      expect(names.filter((n) => /^border(-|$)/.test(n)), `${file}: ${classes}`).toEqual([]);
    }
  });
});
