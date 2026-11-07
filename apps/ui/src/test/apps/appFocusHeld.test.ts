import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startApp, type RunningApp } from "../../lib/apps/broker";
import { memoryHost } from "../../lib/apps/memoryHost";

/**
 * An app open beside the chat cannot take the keyboard by script: its frame calling `focus()` with no tap or key in it
 * would take what the person types (and pastes) into Ghostly's message field. The focus goes back where it was, unless
 * the person pointed at the app or pressed Tab.
 */
describe("an app's frame and the page's focus", () => {
  let running: RunningApp | null = null;
  let field: HTMLTextAreaElement;
  let active: Element | null = null;
  beforeEach(() => {
    vi.spyOn(document, "activeElement", "get").mockImplementation(() => active);
    field = document.createElement("textarea");
    document.body.appendChild(field);
    vi.spyOn(field, "focus").mockImplementation(() => { active = field; });
    const container = document.createElement("div");
    document.body.appendChild(container);
    running = startApp({
      container, host: memoryHost(), view: { theme: () => "dark", locale: () => "en" },
      launch: { ref: "pubkeyalpha/notes", digest: "d", version: "1.0.0", title: "Notes", permissions: [], entry: "<p>app</p>", chat: null },
    });
    // The person is in the message field.
    active = field;
    field.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  });
  afterEach(() => {
    running?.stop();
    running = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  /** The focus moves into the app's frame: the page's window loses it. */
  async function intoFrame() {
    active = running!.frame;
    window.dispatchEvent(new FocusEvent("blur"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return document.activeElement;
  }

  it("goes back to the message field when the app takes it by script", async () => {
    expect(await intoFrame()).toBe(field);
  });

  it("goes back while the person types in the page, even with the pointer resting on the app", async () => {
    running!.frame.dispatchEvent(new PointerEvent("pointerover"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "m" }));
    expect(await intoFrame()).toBe(field);
  });

  it("stays in the app the person clicks", async () => {
    running!.frame.dispatchEvent(new PointerEvent("pointerover"));
    expect(await intoFrame()).toBe(running!.frame);
  });

  it("stays in the app the person taps (the tap's compatibility mouseover)", async () => {
    running!.frame.dispatchEvent(new MouseEvent("mouseover"));
    expect(await intoFrame()).toBe(running!.frame);
  });

  it("goes back once the pointer has left the app", async () => {
    running!.frame.dispatchEvent(new PointerEvent("pointerover"));
    running!.frame.dispatchEvent(new PointerEvent("pointerout"));
    expect(await intoFrame()).toBe(field);
  });

  it("stays in the app the person tabs to", async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(await intoFrame()).toBe(running!.frame);
  });

  it("is left alone once the app has stopped", async () => {
    const { frame } = running!;
    running!.stop();
    active = frame;
    window.dispatchEvent(new FocusEvent("blur"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(field.focus).not.toHaveBeenCalled();
  });
});
