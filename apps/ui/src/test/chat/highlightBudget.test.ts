import { beforeAll, describe, expect, it } from "vitest";
import type { highlight as Highlight } from "../../components/rich/highlight";

// The highlighter runs on the page's thread, so what one received message can make it do is bounded: a block whose
// shape makes highlight.js's work grow with the square of its length stays plain, and a block highlighted once is
// not highlighted again when its chat opens a second time.

let highlight: typeof Highlight;
beforeAll(async () => { ({ highlight } = await import("../../components/rich/highlight")); }, 60_000);

const took = (code: string, lang: string) => {
  const start = performance.now();
  const tree = highlight(code, lang);
  return { ms: performance.now() - start, tree };
};

/** Far above what a bounded call takes (well under 5 ms here), far below what these shapes took unbounded (0.15-1 s). */
const BOUND_MS = 50;

describe("highlighting a code block", () => {
  it("is bounded for blocks whose highlighting cost grows with the square of their length", () => {
    const shapes: [string, string, string][] = [
      ["one 16 KB line of C words", "c", "int ".repeat(4_000)],
      ["many 80-character lines of C words", "c", Array.from({ length: 200 }, () => "int ".repeat(20)).join("\n")],
      ["one 8 KB word among short lines", "typescript", `const a = 1;\n${"a".repeat(8_000)}\nconst b = 2;`],
      ["one 16 KB word", "ts", "a".repeat(16_000)],
      ["a long line of YAML", "yaml", "1 ".repeat(4_000)],
    ];
    for (const [shape, lang, code] of shapes) {
      const { ms } = took(code, lang);
      expect.soft(ms, shape).toBeLessThan(BOUND_MS);
    }
  });

  it("still colours ordinary code", () => {
    const code = Array.from({ length: 60 }, (_, i) => `int f${i}(int a, char *b) { return a + ${i}; }`).join("\n");
    expect(highlight(code, "c")).not.toBeNull();
    expect(highlight("const answer: number = 42;", "ts")).not.toBeNull();
  });

  it("does the work once per language and text", () => {
    const code = "def hello(name):\n    return f'hi {name}'";
    expect(highlight(code, "python")).toBe(highlight(code, "python"));
  });
});
