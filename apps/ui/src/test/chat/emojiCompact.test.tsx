import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { loadEmoji } from "../../lib/emoji";
import { renderApp } from "../render";

// covers: app.emoji-picker, app.composer.expressions, app.mobile-layout

/**
 * A short screen with the keyboard up for the panel's search: the grabber, the categories, the search row and the
 * Emoji/GIF switch took the whole sheet above the keyboard and left its results 8 px on a phone on its side (667 × 375,
 * 175 px visible; the same in two panes at 874 × 402, 162 px visible), and one row of emoji on the smallest phone held
 * upright (320 × 568, 315 px visible). There the panel goes compact: the search with the switch beside it over the
 * results, as tall as what the keyboard leaves. What a browser measures (two whole rows of 44 px emoji):
 * e2e/web/emoji-position.spec.ts.
 */
const CSS = readFileSync(join(fileURLToPath(import.meta.url), "../../../components/composer/composer.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** The declarations of the rule whose selector list is exactly `selector` (outside any at-rule's own rules too). */
const rule = (selector: string) => CSS.match(new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m"))?.[1] ?? "";

const viewport = (width: number, height: number) => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height });
/** iOS's model: the page keeps its height and only the visual viewport loses the keyboard's. */
function keyboardUp(width: number, height: number, keyboard: number) {
  viewport(width, height);
  const visual = Object.assign(new EventTarget(), { width, height: height - keyboard, offsetLeft: 0, offsetTop: 0 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: visual });
  document.documentElement.dataset.keyboard = keyboard ? "true" : "false";
  return {
    /** The keyboard goes down: what useViewportHeight says then, and the resize it follows. */
    down: () => act(() => {
      visual.height = height;
      document.documentElement.dataset.keyboard = "false";
      visual.dispatchEvent(new Event("resize"));
      return new Promise<void>((done) => requestAnimationFrame(() => done()));
    }),
  };
}

beforeAll(() => loadEmoji());
afterEach(() => {
  Reflect.deleteProperty(window, "visualViewport");
  delete document.documentElement.dataset.keyboard;
  vi.restoreAllMocks();
});

async function openAndSearch() {
  const { user } = renderApp(<LockScreenProvider><MessageInput onSend={vi.fn().mockResolvedValue(null)} onSendFile={vi.fn().mockResolvedValue(null)} /></LockScreenProvider>);
  await user.click(screen.getByTestId("composer-expressions"));
  const panel = screen.getByTestId("expression-panel");
  await user.click(within(panel).getByTestId("expression-search"));
  await user.keyboard("face");
  return { user, panel };
}
const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

describe("the emoji/GIF panel with the keyboard up on a short screen", () => {
  it("a phone on its side (667 × 375, 200 px keyboard): compact, as tall as the keyboard leaves less the backdrop's strip", async () => {
    keyboardUp(667, 375, 200);
    const { panel } = await openAndSearch();
    expect(panel).toHaveAttribute("data-compact");
    expect(panel.style.getPropertyValue("--expression-height")).toBe(`${175 - 8}px`);
    expect(panel.style.maxHeight).toBe(`${175 - 8}px`);
    // The switch is still there (beside the search), and so are the results.
    expect(within(panel).getByTestId("expression-tab-gif")).toBeInTheDocument();
    expect(within(panel).getByTestId("emoji-section-search")).toBeInTheDocument();
  });

  it("two panes on a phone on its side (874 × 402, 240 px keyboard): the popover covers the composer, from the top of the screen to the keyboard", async () => {
    keyboardUp(874, 402, 240);
    const { panel } = await openAndSearch();
    expect(panel).toHaveClass("expression-popover");
    expect(panel).toHaveAttribute("data-compact");
    expect(panel.style.top).toBe("8px");
    expect(panel.style.height).toBe(`${162 - 16}px`);
  });

  it("stays compact while the focus is nowhere (a tap on its switch), and is the usual panel again once the keyboard is down", async () => {
    const keyboard = keyboardUp(667, 375, 200);
    const { panel } = await openAndSearch();
    act(() => (document.activeElement as HTMLElement).blur());
    await frame();
    expect(panel).toHaveAttribute("data-compact");
    await keyboard.down();
    expect(panel).not.toHaveAttribute("data-compact");
    expect(panel.style.getPropertyValue("--expression-height")).toBe("290px");
  });

  it("the focus in the message field brings the usual panel back: the composer is not covered while typing into it", async () => {
    keyboardUp(874, 402, 240);
    const { user, panel } = await openAndSearch();
    expect(panel).toHaveAttribute("data-compact");
    await user.click(screen.getByPlaceholderText("Message…"));
    await frame();
    expect(panel).not.toHaveAttribute("data-compact");
  });

  it("the smallest phone held upright (320 × 568, 253 px keyboard): compact too, the usual panel would show one row of emoji", async () => {
    keyboardUp(320, 568, 253);
    const { panel } = await openAndSearch();
    expect(panel).toHaveAttribute("data-compact");
    expect(panel.style.getPropertyValue("--expression-height")).toBe(`${315 - 8}px`);
    expect(panel.style.maxHeight).toBe(`${315 - 8}px`);
  });

  it("a phone held upright with room for two rows (375 × 667, 260 px keyboard) keeps the usual panel", async () => {
    keyboardUp(375, 667, 260);
    const { panel } = await openAndSearch();
    expect(panel).not.toHaveAttribute("data-compact");
    expect(panel.style.getPropertyValue("--expression-height")).toBe(`${Math.round(407 * 0.82)}px`);
  });

  it("on its side with the keyboard down, it is not compact either", async () => {
    keyboardUp(568, 320, 0);
    const { panel } = await openAndSearch();
    expect(panel).not.toHaveAttribute("data-compact");
    expect(panel.style.getPropertyValue("--expression-height")).toBe(`${Math.round(320 * 0.82)}px`);
  });

  it("compact drops the grabber, the categories and the results' heading, and puts the switch beside the search", () => {
    expect(rule(".expression-panel[data-compact]")).toMatch(/display: grid/);
    const hidden = CSS.match(/([^{}]*)\{\s*display: none;\s*\}/g)?.find((r) => r.includes("[data-compact]::before")) ?? "";
    for (const part of [".expression-panel[data-compact]::before", ".expression-panel[data-compact] .expression-categories", ".expression-panel[data-compact] .expression-section-title"]) {
      expect(hidden).toContain(part);
    }
    expect(rule(".expression-panel[data-compact] .expression-search-row")).toMatch(/grid-column: 1; grid-row: 1/);
    expect(rule(".expression-panel[data-compact] .expression-switch")).toMatch(/grid-column: 2; grid-row: 1/);
    // Right to left too: no physical side in the compact rules.
    const compact = [...CSS.matchAll(/[^{}]*\[data-compact\][^{}]*\{([^}]*)\}/g)].map((m) => m[1]).join("\n");
    expect(compact).not.toMatch(/\b(left|right)\b|margin-(left|right)|padding-(left|right)/);
  });
});
