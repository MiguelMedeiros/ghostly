import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { TEXT_SCALE } from "../../lib/textSize";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: chat.rich.code, chat.rich.blob, app.mobile-layout

/**
 * On a phone a code block's Copy takes a tap in 46 px (`.tap-target::after`, index.css). Centred on the button, that
 * hit area reached 10 px above the block, over the line right above it: a tap on the lower part of a key's Copy or
 * Show all there, or on a link at Huge text, copied the code instead. It starts at the block's top edge now and grows
 * down, over the block's own bar and code. happy-dom lays nothing out, so this takes the phone rules whose `::after`
 * reaches each button (matched on the rendered message), cascades them, and works out where the hit area sits from the
 * sizes the CSS gives the block; e2e/web/phone-touch-targets.spec.ts taps it in Chromium.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");
const read = (file: string) => readFileSync(join(SRC, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const INDEX = read("index.css"), RICH = read("components/rich/rich-text.css");

/** The bodies of a stylesheet's `@media (width < 768px)` blocks, in order. */
const phoneBlocks = (css: string) => {
  const out: string[] = [];
  for (let at = css.indexOf("@media (width < 768px)"); at >= 0; at = css.indexOf("@media (width < 768px)", at + 1)) {
    const open = css.indexOf("{", at);
    let depth = 0, end = open;
    for (; end < css.length; end++) {
      if (css[end] === "{") depth++;
      else if (css[end] === "}" && --depth === 0) break;
    }
    out.push(css.slice(open + 1, end));
  }
  return out;
};

type Rule = { selector: string; declarations: Map<string, string>; specificity: number; order: number };
/** Every phone rule, index.css first (the app's own sheet loads before a component's). */
const PHONE_RULES: Rule[] = [INDEX, RICH].flatMap(phoneBlocks).flatMap((body) =>
  [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) => {
    const declarations = new Map(body.split(";").map((d) => d.split(":")).filter((d) => d.length >= 2).map(([k, ...v]) => [k.trim(), v.join(":").trim()] as [string, string]));
    return selectors.split(",").map((selector) => ({ selector: selector.trim(), declarations, specificity: 0, order: 0 }));
  })).map((rule, order) => ({ ...rule, order, specificity: specificity(rule.selector) }));

/** Classes, attributes and pseudo-classes count 10, an element or a pseudo-element 1 (no ids in these sheets). */
function specificity(selector: string): number {
  const bare = selector.replace(/:not\(([^)]*)\)/g, " $1");
  return 10 * (bare.match(/\.[\w-]+|\[[^\]]+\]|(?<!:):[\w-]+/g)?.length ?? 0) + (bare.match(/::[\w-]+|(?:^|[\s>+~])[a-z][\w-]*/gi)?.length ?? 0);
}

/** The declarations a phone gives `el`'s ::after, cascaded. */
const afterOf = (el: Element) => {
  const out = new Map<string, string>();
  const reaching = PHONE_RULES.filter((rule) => {
    if (!rule.selector.endsWith("::after")) return false;
    try { return el.matches(rule.selector.slice(0, -"::after".length)); } catch { return false; }
  }).sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  for (const rule of reaching) for (const [k, v] of rule.declarations) out.set(k, v);
  return out;
};

/** A length the CSS gives as px, a percentage of `of` px, or `max()` of those. */
const px = (value: string, of: number): number => {
  const max = /^max\((.*)\)$/.exec(value);
  if (max) return Math.max(...max[1].split(",").map((part) => px(part.trim(), of)));
  const n = Number.parseFloat(value);
  if (value.endsWith("%")) return (n / 100) * of;
  if (value.endsWith("px") || n === 0) return n;
  throw new Error(`unread length ${value}`);
};

/** Where a button's 46 px hit area sits, from the button's top edge, for a button `height` px tall. */
const hitArea = (el: Element, height: number) => {
  const after = afterOf(el);
  expect(after.get("content"), "a phone draws the ::after").toBeDefined();
  const tall = Math.max(px(after.get("height") ?? "0", height), px(after.get("min-height") ?? "0", height));
  const transform = after.get("transform") ?? "none";
  const move = /^translate\(([^,]+),\s*([^)]+)\)$/.exec(transform) ?? /^translateY\(()([^)]+)\)$/.exec(transform);
  const down = move ? px(move[2].trim(), tall) : 0;
  const top = px(after.get("top") ?? "0", height) + down;
  return { top, bottom: top + tall, tall };
};

/** A px number a rule in `css` gives `property`, `calc(<n>rem / 16 * var(--chat-text-scale))` read as n × scale. */
const sized = (css: string, selector: string, property: string, scale = 1) => {
  const body = new RegExp(`(?:^|[\\s}])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  const value = new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+)`).exec(body)?.[1].trim() ?? "";
  const scaled = /^calc\(([\d.]+)rem \/ 16 \* var\(--chat-text-scale\)\)$/.exec(value);
  if (scaled) return Number(scaled[1]) * scale;
  expect(value, `${selector} { ${property} } in px`).toMatch(/^[\d.]+px/);
  return value.split(/\s+/).map((part) => Number.parseFloat(part));
};
const first = (v: number | number[]) => (Array.isArray(v) ? v[0] : v);

/** Sent on 2026-09-25 at 12:00 UTC: history, so no entry animation. */
const SENT = Date.UTC(2026, 8, 25, 12);
const message = (text: string): ChatMessage => ({ id: "m1", text, sender: "peer", timestamp: SENT });
const KEY = "Zm9vYmFy".repeat(16);

describe("on a phone, a code block's Copy right under a key's line", () => {
  it.each(Object.entries(TEXT_SCALE))("at text size %s (× %s), takes taps only inside its own block, not on the line above", (_size, scale) => {
    renderApp(<MessageBubble message={message(`key ${KEY}\n\`\`\`js\nconst b = 2;\n\`\`\``)} peerPubKey="peer" />);
    const block = screen.getByTestId("rich-codeblock"), copy = screen.getByTestId("rich-codeblock-copy");
    const bar = block.firstElementChild!;
    // The button sits in the bar, the block's first box: the bar's top padding above it, nothing between the block's
    // top and the bar's.
    expect(bar).toHaveClass("rich-codeblock-bar");
    expect(copy.parentElement).toBe(bar);
    expect(screen.getByTestId("rich-blob-copy")).toBeInTheDocument();

    // Each line of a message is `.chat-text-message`'s line height; the bar's words and its button inherit it.
    const line = first(sized(INDEX, ".chat-text-message", "line-height", scale));
    const [barTop] = sized(RICH, ".rich-codeblock-bar", "padding") as number[];
    const barBorder = first(sized(RICH, ".rich-codeblock-bar", "border-bottom"));
    const [preTop, , preBottom] = sized(RICH, ".rich-codeblock pre", "padding") as number[];
    const codeLine = first(sized(RICH, ".rich-codeblock pre", "line-height", scale));
    // The shortest block: its bar and one line of code.
    const blockHeight = barTop * 2 + line + barBorder + preTop + preBottom + codeLine;

    const hit = hitArea(copy, line);
    const fromBlockTop = { top: barTop + hit.top, bottom: barTop + hit.bottom };
    expect(hit.tall, "the code block's Copy takes a tap on 44 px of height or more").toBeGreaterThanOrEqual(44);
    expect(fromBlockTop.top, "where a tap lands on the code block's Copy starts at the block's top edge, not above it").toBeGreaterThanOrEqual(0);
    expect(fromBlockTop.bottom, `…and ends inside the block (${blockHeight.toFixed(1)} px with one line of code)`).toBeLessThanOrEqual(blockHeight);
  });

  it("the key's Show all and Copy above keep a hit area centred on them", () => {
    renderApp(<MessageBubble message={message(`key ${KEY}\n\`\`\`js\nconst b = 2;\n\`\`\``)} peerPubKey="peer" />);
    const line = first(sized(INDEX, ".chat-text-message", "line-height"));
    for (const id of ["rich-blob-toggle", "rich-blob-copy"]) {
      const hit = hitArea(screen.getByTestId(id), line);
      expect(hit.tall, id).toBeGreaterThanOrEqual(44);
      expect(hit.top + hit.bottom, `${id}: as far above it as below`).toBeCloseTo(line);
    }
  });
});
