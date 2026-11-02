import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Highlight } from "../../components/chat/ChatSearch";

// covers: app.accessibility

/**
 * A chat search marks its words with a tint of the accent over the bubble, and the words keep the bubble's text colour.
 * They read at 4.5:1 or more on both bubbles of every theme, dark and light (at 35% they were 4.31:1 on cyan dark's
 * sent bubble and 3.94:1 on monochrome dark's). The tint is read from the mark's class, the colours from index.css.
 */
const CSS = readFileSync(join(fileURLToPath(import.meta.url), "../../../index.css"), "utf8");

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const luminance = (c: number[]) => {
  const [r, g, b] = c.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const over = (top: number[], alpha: number, base: number[]) => top.map((v, i) => v * alpha + base[i] * (1 - alpha));

type Theme = { text: string; accent: string; received: string; sent: string };
function themes(): [string, Theme][] {
  const found = new Map<string, Theme>();
  for (const [, mode, color, body] of CSS.matchAll(/\[data-theme="(dark|light)"\]\[data-color-theme="(\w+)"\]\s*\{([^}]*)\}/g)) {
    const token = (name: string) => body.match(new RegExp(`--theme-${name}:\\s*(#[0-9a-f]{6});`))?.[1];
    const [text, accent, received, sent] = [token("text-primary"), token("accent"), token("received-bg"), token("sent-bg")];
    if (text && accent && received && sent && !found.has(`${color} ${mode}`)) found.set(`${color} ${mode}`, { text, accent, received, sent });
  }
  return [...found];
}

describe("Highlight: a search's marked words", () => {
  const { container } = render(<Highlight text="see you at the station" term="station" />);
  const mark = container.querySelector("mark[data-search-match]")!;
  const classes = mark.getAttribute("class")!;
  const tint = classes.match(/(?:^|\s)bg-accent\/(\d+)(?:\s|$)/);

  it("keep the bubble's text colour over a tint of the accent", () => {
    expect(mark.textContent).toBe("station");
    expect(classes).toMatch(/(?:^|\s)text-inherit(?:\s|$)/);
    expect(tint, classes).not.toBeNull();
  });

  it("the scan finds all four colour themes, dark and light", () => {
    expect(themes().map(([name]) => name).sort()).toEqual(
      ["classic dark", "classic light", "cyan dark", "cyan light", "monochrome dark", "monochrome light", "purple dark", "purple light"]);
  });

  it.each(themes())("read at 4.5:1 or more on %s's received and sent bubbles", (_, { text, accent, received, sent }) => {
    for (const bubble of [received, sent])
      expect(contrast(rgb(text), over(rgb(accent), Number(tint![1]) / 100, rgb(bubble))), `on ${bubble}`).toBeGreaterThanOrEqual(4.5);
  });
});
