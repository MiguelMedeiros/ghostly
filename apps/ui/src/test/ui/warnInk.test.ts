import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// covers: app.accessibility

/**
 * Tailwind's yellow-500 and amber-500 read at about 2:1 on a light page. Words that warn (test coins, an unconfirmed
 * balance, a fee, a public DID's "forever") take `text-warn-ink`: amber on a dark page, a darker amber on a light
 * one. Dots, bars and tints (`bg-amber-500`) are not words and keep the palette.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");
const CSS = readFileSync(join(SRC, "index.css"), "utf8");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** A palette yellow, amber or orange as a text colour, behind any variant (`hover:`, `max-md:`). */
const PALE_WORDS = /(?<![\w-])text-(?:yellow|amber|orange)-\d+(?:\/\d+)?/g;

describe("words that warn", () => {
  it("take the warn ink, never a palette yellow or amber, anywhere in apps/ui/src/", () => {
    const offenders = sources(SRC).flatMap((file) =>
      readFileSync(file, "utf8").split("\n").flatMap((text, index) =>
        [...text.matchAll(PALE_WORDS)].map(([found]) => `${relative(SRC, file)}:${index + 1} ${found}`)));
    expect(offenders).toEqual([]);
  });

  it("read at WCAG AA (4.5:1) on a light page's white", () => {
    expect(CSS).toContain("--color-warn-ink: var(--theme-warn-ink, #f5a524);");
    const light = CSS.match(/html\[data-theme="light"\]\s*\{[^}]*--theme-warn-ink:\s*(#[0-9a-f]{6});/)?.[1];
    expect(light).toBeDefined();
    expect(contrast(light!, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("the scan sees the public DID's warning and the wallets' test-coin lines on the ink", () => {
    for (const file of ["components/identities/PublicDid.tsx", "components/BitcoinWalletPanel.tsx", "components/wallet/CashuWallet.tsx", "components/ArkWalletPanel.tsx"])
      expect(readFileSync(join(SRC, file), "utf8").includes("text-warn-ink"), file).toBe(true);
  });
});
