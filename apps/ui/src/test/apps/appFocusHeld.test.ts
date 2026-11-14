import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startApp, type AppStopReason, type RunningApp } from "../../lib/apps/broker";
import { memoryHost } from "../../lib/apps/memoryHost";

/**
 * An app open beside the chat cannot take the keyboard by script: its frame calling `focus()` with no tap or key in it
 * would take what the person types (and pastes) into Ghostly's message field. The focus goes back where it was, unless
 * the person pointed at the app or pressed Tab. An app that keeps trying is stopped at the third time in a row.
 */
describe("an app's frame and the page's focus", () => {
  let running: RunningApp | null = null;
  let field: HTMLTextAreaElement;
  let active: Element | null = null;
  let stops: AppStopReason[] = [];
  beforeEach(() => {
    stops = [];
    vi.spyOn(document, "activeElement", "get").mockImplementation(() => active);
    field = document.createElement("textarea");
    document.body.appendChild(field);
    vi.spyOn(field, "focus").mockImplementation(() => { active = field; });
    const container = document.createElement("div");
    document.body.appendChild(container);
    running = startApp({
      container, host: memoryHost(), view: { theme: () => "dark", locale: () => "en" },
      launch: { ref: "pubkeyalpha/notes", digest: "d", version: "1.0.0", title: "Notes", permissions: [], entry: "<p>app</p>", chat: null },
      onStop: (reason) => stops.push(reason),
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

  it("an app that focuses itself once when it opens keeps running, and the person still clicks into it", async () => {
    expect(await intoFrame()).toBe(field);
    expect(stops).toEqual([]);
    expect(running!.phase).not.toBe("stopped");
    expect(running!.frame.isConnected).toBe(true);
    running!.frame.dispatchEvent(new PointerEvent("pointerover"));
    expect(await intoFrame()).toBe(running!.frame);
    expect(stops).toEqual([]);
  });

  it("an app that keeps taking it is stopped at the third time, the focus back in the field before the frame goes", async () => {
    const { frame } = running!;
    expect(await intoFrame()).toBe(field);
    expect(await intoFrame()).toBe(field);
    expect(stops).toEqual([]);
    expect(frame.isConnected).toBe(true);
    // The third: stopped inside the blur itself, with no turn of the loop left for a key to reach the app.
    const page = vi.spyOn(window, "focus").mockImplementation(() => {});
    active = frame;
    window.dispatchEvent(new FocusEvent("blur"));
    expect(stops).toEqual(["focus"]);
    expect(document.activeElement).toBe(field);
    expect(frame.isConnected).toBe(false);
    expect(running!.phase).toBe("stopped");
    // And the page asks for the focus the browser took for the frame, so the field shows its caret.
    expect(page).toHaveBeenCalledTimes(1);
  });

  it("a click, a tap or a Tab into the app is never counted", async () => {
    for (let i = 0; i < 4; i++) {
      running!.frame.dispatchEvent(new PointerEvent("pointerover"));
      expect(await intoFrame()).toBe(running!.frame);
      running!.frame.dispatchEvent(new PointerEvent("pointerout"));
      running!.frame.dispatchEvent(new MouseEvent("mouseover"));
      expect(await intoFrame()).toBe(running!.frame);
      running!.frame.dispatchEvent(new MouseEvent("mouseout"));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
      expect(await intoFrame()).toBe(running!.frame);
    }
    expect(stops).toEqual([]);
    expect(running!.phase).not.toBe("stopped");
  });

  it("the count starts again once the person goes into the app", async () => {
    await intoFrame();
    await intoFrame();
    running!.frame.dispatchEvent(new PointerEvent("pointerover"));
    expect(await intoFrame()).toBe(running!.frame);
    running!.frame.dispatchEvent(new PointerEvent("pointerout"));
    expect(await intoFrame()).toBe(field);
    expect(await intoFrame()).toBe(field);
    expect(stops).toEqual([]);
    await intoFrame();
    expect(stops).toEqual(["focus"]);
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
