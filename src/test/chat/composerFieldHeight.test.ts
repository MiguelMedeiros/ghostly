import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fitFieldHeight } from "../../components/composer/fieldHeight";

// covers: app.composer.typing-cost

/**
 * The composer's field fits its text without collapsing on each keystroke (Miguel, 2026-09-28: typing lagged in a long
 * chat on the Mac). A collapse (`height: auto`) makes the page lay the whole chat out again, so it happens only when the
 * text got shorter while the field is taller than one line. Here a field whose content is 22 px a line plus 18 px of
 * padding, 40 px at least, as the composer's.
 */
function field() {
  const writes: string[] = [];
  let height = "";
  const style = { get height() { return height; }, set height(v: string) { writes.push(v); height = v; } };
  const input = { value: "", style } as unknown as HTMLTextAreaElement;
  const content = () => 18 + 22 * input.value.split("\n").length;
  // What a browser says: the box is what `height` gives it (40 px at least), its scroll height the content's, never less.
  Object.defineProperty(input, "clientHeight", { get: () => Math.max(40, height === "auto" ? content() : parseFloat(height) || 0) });
  Object.defineProperty(input, "scrollHeight", { get: () => Math.max(content(), input.clientHeight) });
  const type = (text: string) => { input.value = text; fitFieldHeight(input); };
  return { input, writes, type };
}

beforeEach(() => { vi.spyOn(window, "getComputedStyle").mockReturnValue({ minHeight: "40px" } as CSSStyleDeclaration); });
afterEach(() => { vi.restoreAllMocks(); });

describe("the composer's field", () => {
  it("typing on one line gives it its height once, and never collapses it", () => {
    const { writes, type } = field();
    const text = "the composer should stay quick";
    for (let i = 1; i <= text.length; i++) type(text.slice(0, i));
    expect(writes).toEqual(["40px"]);
    // Deleting on one line: it is as small as it gets, nothing to collapse.
    type("the composer");
    expect(writes).toEqual(["40px"]);
  });

  it("grows with new lines up to 120 px, and collapses to measure only when lines go", () => {
    const { input, writes, type } = field();
    type("one");
    type("one\ntwo");
    type("one\ntwo\nthree");
    expect(input.style.height).toBe("84px");
    expect(writes).not.toContain("auto");
    type("one\ntwo\nthree\nfour\nfive\nsix");
    expect(input.style.height).toBe("120px");
    writes.length = 0;
    type("one");
    expect(writes).toEqual(["auto", "40px"]);
  });
});
