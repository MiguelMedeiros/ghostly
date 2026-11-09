import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { loadEmoji } from "../../lib/emoji";
import { renderApp } from "../render";

// covers: app.emoji-picker, app.mobile-layout

/**
 * On a phone the emoji panel gives a thumb 44 × 44 px where a tap lands, as the rest of the app does: its category icons
 * were 45 × 40 px (38 × 40 at 320 px), the skin tone 36 × 36, Emoji and GIF 57 × 32 and, at 320 px, each emoji 43 × 40.
 * The skin tone and the switch carry `.tap-target` (index.css), which grows where a tap lands without moving them; the
 * category icons are 44 px each way, their row scrolling sideways when they don't fit. The measure itself is a
 * browser's (e2e/web/phone-touch-targets.spec.ts).
 */
const CSS = readFileSync(join(fileURLToPath(import.meta.url), "../../../components/composer/composer.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** The phone's rules (`@media (max-width: 767px)`) for `selector`. */
const phoneRule = (selector: string) => {
  const phone = [...CSS.matchAll(/@media \(max-width: 767px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
  return phone.match(new RegExp(`^\\s*${selector.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
};

beforeAll(() => loadEmoji());
afterEach(() => vi.restoreAllMocks());

const open = () => {
  renderApp(<LockScreenProvider><MessageInput onSend={vi.fn().mockResolvedValue(null)} onSendFile={vi.fn().mockResolvedValue(null)} /></LockScreenProvider>);
  fireEvent.click(screen.getByTestId("composer-expressions"));
  return screen.getByTestId("expression-panel");
};

describe("the emoji panel on a phone", () => {
  it("the skin tone and the Emoji / GIF switch are thumb-sized", () => {
    const panel = open();
    expect(within(panel).getByTestId("emoji-skin")).toHaveClass("tap-target");
    expect(within(panel).getByTestId("expression-tab-emoji")).toHaveClass("tap-target");
    expect(within(panel).getByTestId("expression-tab-gif")).toHaveClass("tap-target");
  });

  it("the category icons are 44 px each way, their row scrolling sideways rather than shrinking them", () => {
    expect(phoneRule(".expression-categories")).toMatch(/overflow-x: auto/);
    expect(phoneRule(".expression-category")).toMatch(/min-width: 44px/);
    expect(phoneRule(".expression-category")).toMatch(/min-height: 44px/);
  });

  it("the emoji are 44 px tall and wide on the narrowest phone too", () => {
    const narrow = CSS.match(/@container expression \(max-width: 360px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(narrow).not.toBe("");
    expect(narrow).not.toMatch(/minmax\((?!44px)/);
    expect(narrow).not.toMatch(/height: (?!44px)\d+px/);
  });

  it("keeps the underlined category in view as the grid scrolls", () => {
    const panel = open();
    const row = within(panel).getByRole("toolbar", { name: "Emoji categories" });
    const flags = within(row).getByTestId("emoji-category-flags");
    const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 44, x: left, y: 0, width: right - left, height: 44, toJSON: () => ({}) });
    // The row shows 0-300 px; the last icon is past its end.
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rect(0, 300));
    vi.spyOn(flags, "getBoundingClientRect").mockReturnValue(rect(330, 374));
    // Every section's top is at the grid's top here: the scroll reaches the last one.
    fireEvent.scroll(within(panel).getByTestId("emoji-grid"));
    expect(flags).toHaveAttribute("aria-pressed", "true");
    expect(row.scrollLeft).toBe(74);
  });
});
