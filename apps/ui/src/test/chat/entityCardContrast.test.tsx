import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EntityCardFrame } from "../../components/chat/EntityCardFrame";

// covers: app.accessibility

/**
 * A card's small label and its "From …"/"You sent" line are 11-12 px text in a tint of the text colour, on the card's
 * own tint over the bubble. They read at 4.5:1 or more on both bubbles of every theme, dark and light (at 65% they
 * were 3.54:1 on classic dark's sent bubble). The tints are read from the frame's classes, the colours from index.css.
 */
const CSS = readFileSync(join(fileURLToPath(import.meta.url), "../../../index.css"), "utf8");

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const luminance = (c: number[]) => {
  const [r, g, b] = c.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const over = (top: number[], alpha: number, base: number[]) => top.map((v, i) => v * alpha + base[i] * (1 - alpha));

function themes(): [string, { text: string; received: string; sent: string }][] {
  const found = new Map<string, { text: string; received: string; sent: string }>();
  for (const [, mode, color, body] of CSS.matchAll(/\[data-theme="(dark|light)"\]\[data-color-theme="(\w+)"\]\s*\{([^}]*)\}/g)) {
    const token = (name: string) => body.match(new RegExp(`--theme-${name}:\\s*(#[0-9a-f]{6});`))?.[1];
    const [text, received, sent] = [token("text-primary"), token("received-bg"), token("sent-bg")];
    if (text && received && sent && !found.has(`${color} ${mode}`)) found.set(`${color} ${mode}`, { text, received, sent });
  }
  return [...found];
}

const alpha = (el: Element, kind: "text" | "bg") => {
  const match = el.getAttribute("class")!.match(new RegExp(`(?:^|\\s)${kind}-text-primary(?:/(\\d+))?(?:\\s|$)`));
  expect(match, `${kind}-text-primary on ${el.getAttribute("class")}`).not.toBeNull();
  return match![1] ? Number(match![1]) / 100 : 1;
};

describe("EntityCardFrame: the label and the subtitle", () => {
  const { container } = render(<EntityCardFrame testId="card" mark={null} label="Chat invite" title="Private chat" subtitle="You sent" />);
  const card = container.querySelector("[data-entity-card]")!;
  const [label, , subtitle] = [...card.querySelectorAll("p")];

  it("the scan finds all four colour themes, dark and light", () => {
    expect(themes().map(([name]) => name).sort()).toEqual(
      ["classic dark", "classic light", "cyan dark", "cyan light", "monochrome dark", "monochrome light", "purple dark", "purple light"]);
  });

  it.each(themes())("read at 4.5:1 or more on %s's received and sent bubbles", (_, { text, received, sent }) => {
    for (const bubble of [received, sent]) {
      const back = over(rgb(text), alpha(card, "bg"), rgb(bubble));
      for (const line of [label, subtitle])
        expect(contrast(over(rgb(text), alpha(line, "text"), back), back), `${line.textContent} on ${bubble}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
