import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { renderApp } from "../render";
import { installFakeAudio, installFakeMedia, removeFakeMedia } from "../voice/fakeMedia";

// covers: app.accessibility, app.theme

/**
 * Forced colors (Windows Contrast themes) drop box shadows and replace backgrounds with the page's: the composer's
 * field, edged by an inset shadow on its fill, read as loose text, and the round Send / mic button lost its shape.
 * In forced colors only, the field (and the voice bar in its place) gets an outline, the round buttons a ButtonText
 * border. What the browser draws is e2e/web/forced-colors-controls.spec.ts.
 */
const CSS = readFileSync(join(fileURLToPath(import.meta.url), "../../../components/composer/composer.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const FORCED = "@media (forced-colors: active)";

/** The rules inside `@media (forced-colors: active)` blocks (selector -> declarations), and the stylesheet without them. */
function forced(): { rules: Map<string, Record<string, string>>; rest: string } {
  const rules = new Map<string, Record<string, string>>();
  let rest = "", at = 0;
  for (let start = CSS.indexOf(FORCED); start >= 0; start = CSS.indexOf(FORCED, at)) {
    const open = CSS.indexOf("{", start);
    let depth = 1, i = open + 1;
    for (; depth > 0; i++) depth += CSS[i] === "{" ? 1 : CSS[i] === "}" ? -1 : 0;
    rest += CSS.slice(at, start);
    for (const [, selectors, body] of CSS.slice(open + 1, i - 1).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decls: Record<string, string> = {};
      for (const [, name, value] of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) decls[name] = value.trim();
      for (const selector of selectors.split(",")) rules.set(selector.trim(), decls);
    }
    at = i;
  }
  return { rules, rest: rest + CSS.slice(at) };
}

describe("the composer's field in forced colors (composer.css)", () => {
  it("the field and the voice bar in its place keep a CanvasText edge, drawn inside them, so nothing moves", () => {
    const { rules } = forced();
    for (const selector of [".composer-field", ".composer-row > .voice-bar"]) {
      expect(rules.get(selector), `${selector} inside ${FORCED}`).toMatchObject({ outline: "1px solid CanvasText", "outline-offset": "-1px" });
    }
  });

  it("the focused field's ring still wins over that edge", () => {
    // `.composer-field:has(.composer-textarea:focus-visible)` is more specific than `.composer-field`, wherever it stands.
    expect(forced().rest).toMatch(/\.composer-field:has\(\.composer-textarea:focus-visible\)\s*\{[^}]*outline:\s*2px solid/);
  });
});

const FORCED_EDGE = ["forced-colors:border", "forced-colors:border-[color:ButtonText]"];

describe("the round Send and mic buttons in forced colors", () => {
  beforeEach(() => { installFakeMedia(); installFakeAudio(); });
  afterEach(() => removeFakeMedia());

  it("the mic, then Send once there is a message, carry a ButtonText border", () => {
    renderApp(<MessageInput onSend={async () => null} onSendFile={async () => null} />);
    const mic = screen.getByTestId("voice-record");
    for (const c of FORCED_EDGE) expect(mic, "the mic").toHaveClass(c);
    fireEvent.change(screen.getByPlaceholderText("Message…"), { target: { value: "hi" } });
    const send = screen.getByRole("button", { name: "Send message" });
    for (const c of FORCED_EDGE) expect(send, "Send").toHaveClass(c);
  });

  it("Send, in a chat that sends no files", () => {
    renderApp(<MessageInput onSend={async () => null} />);
    const send = screen.getByRole("button", { name: "Send message" });
    for (const c of FORCED_EDGE) expect(send).toHaveClass(c);
  });
});
