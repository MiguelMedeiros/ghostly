import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// covers: wallet.instances.create, app.mobile-layout

/**
 * Wallets → New on a phone on its side (812 × 375): a kind's card is 263 px, and in French Fedimint's "Rejoindre avec
 * une invitation…" is wider than the room beside the mark. The pill could neither shrink nor wrap, so it ran past the
 * card and the card's overflow cut its end. Layout itself is measured in a browser (wallet-deck.spec.ts); here, the
 * rules that let it fit.
 */
const CSS = readFileSync(join(fileURLToPath(import.meta.url), "../../../components/wallet/new-wallet.css"), "utf8");
const rule = (selector: string) => {
  const at = CSS.split(/\r?\n/).find(l => l.trimStart().startsWith(`${selector}{`));
  return at?.slice(at.indexOf("{") + 1, at.lastIndexOf("}")) ?? "";
};

describe("Wallets → New: a kind's action", () => {
  it("is never wider than its card's text and wraps a long label", () => {
    const action = rule(".new-wallet-action");
    expect(action).toContain("max-width:100%");
    expect(action).toContain("white-space:normal");
    expect(action).not.toContain("white-space:nowrap");
  });

  it("keeps rounded ends that two lines stay clear of", () => {
    expect(rule(".new-wallet-action")).not.toContain("border-radius:999px");
  });
});
