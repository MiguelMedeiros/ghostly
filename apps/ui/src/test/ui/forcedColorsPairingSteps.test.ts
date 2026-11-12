import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// covers: app.accessibility, chat.paired.pairing-progress

/**
 * Forced colors (Windows Contrast themes) drop backgrounds and shadows, and the pairing scene's steps (Publish, Wait,
 * Answer, Connect, Live) were dots and a line drawn by them alone: five bare words were left, the current one in bold
 * and the done ones not marked at all. In forced colors only (pairing-scene.css), the dots and the line are drawn in
 * system colours and kept as drawn. What the browser draws is e2e/web/forced-colors-pairing-steps.spec.ts.
 */
const CSS = readFileSync(join(fileURLToPath(import.meta.url), "../../../components/pairing/pairing-scene.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const FORCED = "@media (forced-colors: active)";

/** Every `@media (forced-colors: active)` block's rules (each selector of a list -> its declarations), and the rest. */
function forced(): { rules: Map<string, Record<string, string>>; rest: string } {
  const rules = new Map<string, Record<string, string>>();
  let rest = "", at = 0;
  for (let start = CSS.indexOf(FORCED); start >= 0; start = CSS.indexOf(FORCED, at)) {
    const open = CSS.indexOf("{", start);
    let depth = 1, i = open + 1;
    for (; depth > 0; i++) depth += CSS[i] === "{" ? 1 : CSS[i] === "}" ? -1 : 0;
    for (const [, selectors, body] of CSS.slice(open + 1, i - 1).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const selector of selectors.split(",").map((s) => s.trim())) {
        const decls = rules.get(selector) ?? {};
        for (const [, name, value] of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) decls[name] = value.trim();
        rules.set(selector, decls);
      }
    }
    rest += CSS.slice(at, start);
    at = i;
  }
  return { rules, rest: rest + CSS.slice(at) };
}

describe("the pairing scene's steps in forced colors (pairing-scene.css)", () => {
  const { rules, rest } = forced();
  const dot = (state?: string) => rules.get(state ? `.ps-steps li[data-state="${state}"] .ps-step-dot` : ".ps-step-dot");
  const line = (state?: string) => rules.get(state ? `.ps-steps li[data-state="${state}"]::before` : ".ps-steps li + li::before");

  it("keep the dots and the line as drawn", () => {
    expect(dot(), `.ps-step-dot inside ${FORCED}`).toMatchObject({ "forced-color-adjust": "none" });
    expect(line(), `the line inside ${FORCED}`).toMatchObject({ "forced-color-adjust": "none" });
  });

  it("draw a step to come as a CanvasText ring, one done as a Highlight dot and the current one ringed in Highlight", () => {
    expect(dot()).toMatchObject({ border: "1.5px solid CanvasText", background: "Canvas", "box-shadow": "none" });
    expect(dot("done")).toMatchObject({ background: "Highlight" });
    expect(dot("done")?.outline).toBeUndefined();
    expect(dot("current")).toMatchObject({ background: "Highlight", outline: "1.5px solid Highlight", "box-shadow": "none" });
  });

  it("draw the line in CanvasText, and in Highlight up to the current step", () => {
    expect(line()).toMatchObject({ background: "CanvasText" });
    expect(line("done")).toMatchObject({ background: "Highlight" });
    expect(line("current")).toMatchObject({ background: "Highlight" });
  });

  it("leave normal colours as they were", () => {
    expect(rest).not.toMatch(/\b(Canvas|CanvasText|Highlight)\b/);
    expect(rest).not.toMatch(/forced-color-adjust/);
  });
});
