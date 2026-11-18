import type { Locator } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * Forced colors (Windows Contrast themes) drop backgrounds and shadows, and the first chat's pairing steps (Publish,
 * Wait, Answer, Connect, Live) were dots and a line drawn by them alone: five bare words were left. There each dot keeps
 * an edge, the done and current ones a fill, the current one a ring, and the line between them shows; normal colours
 * and the dots' size are as they were (pairing-scene.css).
 */

type RGBA = [number, number, number, number];
type Step = { state: string; dot: { bg: string; border: number; borderColor: string; ring: number; box: { width: number; height: number } }; line: string | null; around: string };

/** A step's dot and the line that leads to it, as seen: each colour laid over what it sits on. */
const step = (li: Locator): Promise<Step> => li.evaluate((node) => {
  const rgba = (c: string): RGBA => { const n = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1]; };
  const over = (top: RGBA, under: RGBA): RGBA => {
    const a = top[3] + under[3] * (1 - top[3]);
    if (!a) return [0, 0, 0, 0];
    const mix = (i: number) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
    return [mix(0), mix(1), mix(2), a];
  };
  const seen = (from: Element | null): RGBA => {
    let c: RGBA = [0, 0, 0, 0];
    for (let n = from; n && c[3] < 1; n = n.parentElement) c = over(c, rgba(getComputedStyle(n).backgroundColor));
    return c[3] < 1 ? over(c, [255, 255, 255, 1]) : c;
  };
  const text = (c: RGBA) => `rgb(${c.slice(0, 3).map(Math.round).join(", ")})`;
  const dot = node.querySelector(".ps-step-dot")!;
  const style = getComputedStyle(dot);
  const around = seen(node);
  const before = getComputedStyle(node, "::before");
  const shadow = style.boxShadow === "none" ? 0 : 1;
  const outline = style.outlineStyle === "none" ? 0 : parseFloat(style.outlineWidth);
  const box = dot.getBoundingClientRect();
  return {
    state: node.getAttribute("data-state")!,
    dot: { bg: text(seen(dot)), border: parseFloat(style.borderTopWidth), borderColor: text(over(rgba(style.borderTopColor), around)), ring: shadow + outline, box: { width: box.width, height: box.height } },
    line: before.content === "none" ? null : text(over(rgba(before.backgroundColor), around)),
    around: text(around),
  };
});

/** Every step: the dot shows against the card, the line shows between dots, and done, current and to come look apart. */
function drawn(steps: Step[], when: string) {
  for (const [i, s] of steps.entries()) {
    const name = `${when}, step ${i + 1} (${s.state})`;
    expect.soft(s.dot.bg !== s.around || (s.dot.border >= 1 && s.dot.borderColor !== s.around), `${name}: a dot that shows`).toBe(true);
    if (i > 0) expect.soft(s.line, `${name}: a line that shows`).not.toBe(s.around);
  }
  const look = (state: string) => steps.find((s) => s.state === state)!;
  const [done, current, todo] = [look("done"), look("current"), look("todo")];
  expect.soft(done.dot.bg, `${when}: a step done is filled, one to come is not`).not.toBe(todo.dot.bg);
  expect.soft(current.dot.ring, `${when}: the current step is ringed`).toBeGreaterThan(0);
  expect.soft(done.dot.ring, `${when}: a step done is not`).toBe(0);
}

test("forced colors keep the pairing steps' dots and line drawn, the done and current ones marked", { tag: ["@feature:app.accessibility", "@feature:chat.paired.pairing-progress"] }, async ({ peer }, testInfo) => {
  const { page } = await peer("fc-steps");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTitle("New Chat").click();
  await expect(page.getByTestId("pairing-scene")).toHaveAttribute("data-stage", "waiting");
  // No animation between two reads.
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
  const steps = page.getByTestId("pairing-steps").locator("li");
  await expect(steps).toHaveCount(5);
  const read = async () => Promise.all((await steps.all()).map(step));

  // Normal colours: the dots are 8 px, with no edge (a background and a shadow drew them).
  await page.emulateMedia({ forcedColors: "none", colorScheme: "dark" });
  const before = await read();
  expect(before.map((s) => s.state)).toEqual(["done", "current", "todo", "todo", "todo"]);
  for (const s of before) expect(s.dot).toMatchObject({ border: 0, box: { width: 8, height: 8 } });

  for (const [scheme, width] of [["dark", 1280], ["light", 375]] as const) {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ forcedColors: "active", colorScheme: scheme });
    await page.getByTestId("pairing-steps").scrollIntoViewIfNeeded();
    const after = await read();
    drawn(after, `forced colors, ${scheme} at ${width} px`);
    // The same size: nothing moves.
    for (const s of after) expect.soft(s.dot.box, `${scheme}: the dot's size`).toEqual({ width: 8, height: 8 });
    await page.getByTestId("pairing-scene").screenshot({ path: testInfo.outputPath(`forced-pairing-steps-${scheme}-${width}.png`) });
  }
});
