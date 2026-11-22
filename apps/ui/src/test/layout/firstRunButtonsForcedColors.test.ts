import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// covers: app.accessibility, app.theme

/**
 * Forced colors (Windows Contrast themes) fill every button with the page's colour, so a main button drawn by its accent
 * fill alone read as bare bold text: the chat list's New and its arrow, an invite's Copy invite (and Add device's Copy),
 * a link's QR Copy, the install hint's Install and its steps' Got it, and a page's New in its header (Wallets,
 * Identities, Apps). Each keeps an edge there, as Home's New chat and a group's buttons do: a ButtonText border in
 * forced colors only. What the browser draws is e2e/web/forced-colors-controls.spec.ts.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");
const FILES = [
  "components/Sidebar.tsx", "components/QRCode.tsx", "components/chat/LinkQrDialog.tsx", "components/InstallApp.tsx",
  "components/layout/PageAction.tsx",
];
const EDGE = ["forced-colors:border", "forced-colors:border-[color:ButtonText]"];

/** Each class string (a quoted or template literal) that fills a button with the accent behind its own ink. */
function accentButtons(file: string): string[] {
  const source = readFileSync(join(SRC, file), "utf8");
  return [...source.matchAll(/["`]([^"`]*(?<![\w:-])bg-accent\b[^"`]*)["`]/g)].map(([, classes]) => classes)
    .filter((classes) => /(?<![\w:-])text-(panel-header|on-accent)\b/.test(classes));
}

describe("first-run main buttons in forced colors", () => {
  it.each(FILES)("%s: every accent-filled button has a ButtonText border in forced colors only", (file) => {
    const buttons = accentButtons(file);
    expect(buttons.length, file).toBeGreaterThan(0);
    for (const classes of buttons) {
      const names = classes.split(/\s+/);
      for (const name of EDGE) expect(names, `${file}: ${classes}`).toContain(name);
    }
  });
});
