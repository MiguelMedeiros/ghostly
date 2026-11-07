import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: app.mobile-layout, chat.paired.join-notice

/**
 * On a phone a system line's ⋮ (a contact joined, a call, a refused payment) takes a thumb's 44 px: its hit area reaches
 * past its box towards the row's end. The row kept only the 10 px every row keeps there, so a line long enough to wrap
 * (the contact joined, in Japanese, at 375 px) put the ⋮ against the screen's edge, which cut its hit area to 33 px
 * wide. A system row keeps the whole reach on a phone, on both sides (the ⋮ is on the left in Arabic). jsdom draws no
 * layout: what is read here is the rule and the class; e2e/web/phone-touch-targets.spec.ts measures it in a browser.
 */
const here = fileURLToPath(import.meta.url);
const CSS = readFileSync(join(here, "../../../index.css"), "utf8");
const BUBBLE = readFileSync(join(here, "../../../components/MessageBubble.tsx"), "utf8");

/** How far past its box a system line's ⋮ (`align="right"`) takes taps on a phone, from `MessageMenu`'s classes. */
const reach = Number(BUBBLE.match(/max-md:before:-end-\[(\d+)px\]/)?.[1]);

/** The px `padding-inline` a rule for `selector` sets inside the at-rule whose prelude starts with `at`, if any. */
function paddingInside(at: string, selector: string): number | undefined {
  for (const block of CSS.split(at).slice(1)) {
    const rule = block.match(/^[^{]*\{\s*([^{}]+)\{([^}]*)\}/);
    if (rule?.[1]!.trim() !== selector) continue;
    const value = rule[2]!.match(/padding-inline\s*:\s*(\d+)px/)?.[1];
    if (value) return Number(value);
  }
  return undefined;
}

const NARROW = ["@media (width < 48rem)", "@container message-list (width < 36rem)"];

describe("a system line's ⋮ on a phone", () => {
  it("has its reach read from the ⋮'s classes", () => {
    expect(reach).toBeGreaterThan(10);
  });

  for (const at of NARROW) {
    it(`keeps the room its hit area reaches past it, on both sides of a system row (${at})`, () => {
      const rows = paddingInside(at, ".message-row-x");
      expect(rows, "every row's room on a phone").toBe(10);
      const system = paddingInside(at, ".message-row-x.system-row-x");
      expect(system, "a system row's room on a phone").toBeDefined();
      expect(system!).toBeGreaterThanOrEqual(reach);
    });
  }

  it("is in a row that keeps that room, for every system line MessageBubble draws", () => {
    const rows = BUBBLE.match(/data-sender="system" className=\{`[^`]*`\}/g) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) expect(row).toMatch(/\bmessage-row-x system-row-x\b/);
  });

  const base = { id: "s1", sender: "system", timestamp: 1_700_000_000_000 } as const;
  const lines: [string, ChatMessage][] = [
    ["a contact joined", { ...base, text: "👋 joined", systemEvent: { type: "join", pubKey: "yb1q3k9mfahf0974jqwy0yyfrg7zxksgxk7ufcc0" } }],
    ["a call", { ...base, text: "Missed audio call", callEvent: { type: "call_missed", hasVideo: false } }],
  ];
  it.each(lines)("draws %s in such a row, with its ⋮", (_, message) => {
    renderApp(<MessageBubble message={message} peerPubKey="peer" />);
    const options = screen.getByTestId("message-options");
    const row = options.closest<HTMLElement>("[data-message-row]")!;
    expect(row.dataset.sender).toBe("system");
    expect(row).toHaveClass("message-row-x", "system-row-x");
  });

  it("leaves a contact's bubble in a row of the usual room", () => {
    renderApp(<MessageBubble message={{ id: "m1", text: "hello", sender: "peer", timestamp: 1_700_000_000_000 }} peerPubKey="peer" />);
    expect(screen.getByTestId("message-options").closest("[data-message-row]")).not.toHaveClass("system-row-x");
  });
});
