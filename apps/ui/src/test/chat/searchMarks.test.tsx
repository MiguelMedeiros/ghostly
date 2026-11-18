import { describe, expect, it } from "vitest";
import { RichText, SEARCH_MARK_BUDGET } from "../../components/rich/RichText";
import { renderApp } from "../render";
import { waitFor, render, screen } from "@testing-library/react";
import { matchRanges, searchText } from "../../lib/chatSearch";
import type { ChatMessage } from "../../lib/types";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Highlight } from "../../components/chat/ChatSearch";

// covers: chat.search
describe("a chat search's marks in one bubble", () => {
  /*
   * A chat search marks its words in each bubble it finds. The marks were not counted in the bubble's element budget
   * (agents#1749): a common word ("e", "the") in an agent's long answers drew hundreds of <mark> per bubble, 60,000 over
   * the 100 rows on screen of an 8 KiB-a-message chat, and each new word took 380-500 ms of one long task in Chromium to
   * draw them and take the last ones away. A bubble now marks its first SEARCH_MARK_BUDGET matches; it is still found,
   * jumped to and counted as before.
   */

  const marks = (text: string, term: string) => {
    const view = renderApp(<RichText testId="message-text" text={text} highlight={term} />);
    const found = [...view.container.querySelectorAll("mark[data-search-match]")];
    const out = { count: found.length, first: found[0]?.textContent, text: view.container.textContent };
    view.unmount();
    return out;
  };

  const WORDS = "the ghost in the attic moved the lantern again ";
  /** What a bubble may mark at most (`SEARCH_MARK_BUDGET`). */
  const BOUND = 100;

  const long: Record<string, string> = {
    paragraphs: Array.from({ length: 40 }, () => WORDS.repeat(8)).join("\n\n"),
    list: Array.from({ length: 200 }, () => `- ${WORDS}`).join("\n"),
    code: "```\n" + `${WORDS}\n`.repeat(200) + "```",
    mixed: Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? "```ts\n" + `const the = "${WORDS}";\n`.repeat(5) + "```" : i % 3 === 1 ? `- **the** ${WORDS}\n- ${WORDS}` : WORDS.repeat(5))).join("\n\n"),
    // A link whose text names another host shows its address, marked where that holds the words.
    "links showing their address": Array.from({ length: 3 }, () => `[paypal.com](https://x.example/${"the-".repeat(150)})`).join(" "),
  };

  for (const [name, text] of Object.entries(long)) it(`are bounded in a long message: ${name}`, () => {
    const all = text.split("the").length - 1;
    expect(all).toBeGreaterThan(BOUND);
    const { count, first, text: shown } = marks(text, "the");
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(BOUND);
    expect(first).toBe("the");
    // Nothing of the text is lost past them.
    expect(shown!.split("the").length - 1).toBe(all);
  });

  it("is the budget the bubbles keep to", () => {
    expect(SEARCH_MARK_BUDGET).toBe(BOUND);
  });

  it("marks every match of an ordinary message", () => {
    expect(marks("the ghost and *the* lantern:\n- the attic\n```\nthe end\n```", "the").count).toBe(4);
  });
});

// covers: chat.search
describe("a chat search's words in a code block or a link", () => {
  /**
   * Search inside a chat finds a message by a fenced code block's code and by a link's words, so the bubble marks them
   * there: in the block, plain or highlighted, and in the link's text or address as it shows. Only text and inline code
   * were marked, so "1 of 1" jumped to a pasted log or a link with nothing marked in it.
   */
  const render = (text: string, term: string) => renderApp(<RichText testId="message-text" text={text} highlight={term} />).container;
  const marksIn = (container: HTMLElement) => [...container.querySelectorAll("mark[data-search-match]")].map(mark => mark.textContent);
  const marks = (text: string, term: string) => marksIn(render(text, term));

  it("are marked in a plain code block", () => {
    const container = render("here:\n```\nplain wolfram log\n```", "wolfram");
    expect(marksIn(container)).toEqual(["wolfram"]);
    expect(container.querySelector("[data-testid=rich-codeblock] mark")?.textContent).toBe("wolfram");
  });

  it("are marked in a highlighted code block, across its tokens", async () => {
    const container = render("here:\n```js\nconst wolfram = 1;\nwolfram++\n```", "const wolfram");
    expect(marksIn(container)).toEqual(["const wolfram"]);
    await waitFor(() => expect(container.querySelector("[data-testid=rich-codeblock][data-highlighted]")).not.toBeNull());
    expect(marksIn(container)).toEqual(["const", " wolfram"]);
    expect(container.querySelector("[data-testid=rich-codeblock] code")?.textContent).toBe("const wolfram = 1;\nwolfram++");
  });

  it("are marked in a link's text and in an address it shows", () => {
    expect(marks("see [the wolfram docs](https://example.com/x)", "wolfram")).toEqual(["wolfram"]);
    expect(marks("see https://wolfram.example/a", "wolfram")).toEqual(["wolfram"]);
    expect(marks("see https://wolfram.example/a", "see https")).toEqual(["see ", "https"]);
    // Across the link's edge and its formatting; a covered spoiler in it stays covered and unmarked.
    expect(marks("the [*wolfram* docs](https://example.com/x) here", "the wolfram")).toEqual(["the ", "wolfram"]);
    expect(marks("[||wolfram|| wolfram](https://example.com/x)", "wolfram")).toEqual(["wolfram"]);
  });

  it("leave the words after a link marked where they are", () => {
    expect(marks("[docs](https://example.com/x) and wolfram", "wolfram")).toEqual(["wolfram"]);
    expect(marks("[*docs*](https://example.com/x) wolfram [wolfram](https://example.com/y)", "wolfram")).toEqual(["wolfram", "wolfram"]);
  });

  it("mark a link's text whole when they are only in the address it does not show", () => {
    // Search finds a link by its address (lib/chatSearch, and the chat list the same): the text that goes there is marked.
    expect(marks("see [the *docs*](https://wolfram.example/x)", "wolfram")).toEqual(["the ", "docs"]);
    expect(marks("[docs](https://example.com/wolfram) and wolfram", "wolfram")).toEqual(["docs", "wolfram"]);
    // A label that reads as another address shows the address instead: marked where it holds the words, whole otherwise.
    expect(marks("[wolfram.example](https://other.example/a)", "wolfram")).toEqual(["https://other.example/a"]);
    expect(marks("[wolfram.example](https://other.example/wolfram)", "wolfram")).toEqual(["wolfram"]);
  });

  it("are marked in every message search counts", () => {
    for (const text of [
      "here:\n```js\nconst wolfram = 1;\n```",
      "here:\n```\nplain wolfram log\n```",
      "see [the wolfram docs](https://example.com/x)",
      "see [the docs](https://example.com/wolfram)",
      "see https://wolfram.example/a",
      "plain wolfram",
    ]) {
      const found = matchRanges(searchText({ id: "m", text, sender: "peer", timestamp: 0 } as ChatMessage) ?? "", "wolfram");
      expect(found.length, text).toBe(1);
      expect(marks(text, "wolfram").length, text).toBeGreaterThan(0);
    }
  });
});

// covers: app.accessibility
describe("Highlight: a search's marked words", () => {
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

// covers: chat.search
describe("a chat search's words in a formatted bubble", () => {
  /**
   * Search inside a chat finds a formatted message by the words it shows ("*hello* world" by "hello world"), and the
   * bubble marks those words where it shows them: across the formatting, and inside code too. Only a plain run of text
   * was marked, so such a match was counted and jumped to with nothing marked in its bubble.
   */
  const marks = (text: string, term: string) => {
    const { container } = renderApp(<RichText testId="message-text" text={text} highlight={term} />);
    return [...container.querySelectorAll("mark[data-search-match]")].map(mark => mark.textContent);
  };

  it("are marked across the formatting", () => {
    expect(marks("*hello* world", "hello world")).toEqual(["hello", " world"]);
    expect(marks("~~old~~ *new* plan, ~~old~~ *new* day", "old new")).toEqual(["old", " ", "new", "old", " ", "new"]);
    // In a heading and a list item, after a link: each run is searched as it reads, the link's words left as they are.
    expect(marks("# *Big* news\n- see https://ghostly.tools then *big* news", "big news")).toEqual(["Big", " news", "big", " news"]);
  });

  it("are marked inside code", () => {
    expect(marks("run `npm ci` first", "npm ci")).toEqual(["npm ci"]);
    expect(marks("run `npm ci` first", "run npm")).toEqual(["run ", "npm"]);
  });

  it("are marked in plain text as before, whatever the case and accents", () => {
    expect(marks("Um Café amanhã? café!", "CAFE")).toEqual(["Café", "café"]);
    expect(marks("*bold* and plain", "plain")).toEqual(["plain"]);
    expect(marks("nothing here", "elsewhere")).toEqual([]);
  });
});

// covers: chat.rich.blocks
/*
 * agents#1749: a contact's text within the 16 KiB cap, written as marker soup, drew thousands of elements and Tab stops
 * in its bubble: 5,333 elements for `||a||` x2666, 12,002 for "- a" x4000, 7,109 for "1:00 UTC" x1777. A chat holding a
 * few dozen of them took 1.5-2.1 s of long tasks at every open and 300-500 MB of heap.
 */
describe("a message's formatting on screen", () => {
  /** Sent on 2026-09-25 at 12:00 UTC. */
  const SENT = Date.UTC(2026, 8, 25, 12);
  const SOUPS: Record<string, string> = {
    spoilers: "||a|| ".repeat(2666),
    list: "- a\n".repeat(4000),
    times: "1:00 UTC ".repeat(1777),
    links: "https://a.co ".repeat(1230),
    code: "`a` ".repeat(4000),
    mixed: "*b* _i_ ||s|| `c` https://a.co 1:00 UTC\n".repeat(400),
  };

  const draw = (text: string) => {
    const view = renderApp(<RichText text={text} sentAt={SENT} testId="rich" />);
    const root = screen.getByTestId("rich");
    const elements = root.querySelectorAll("*").length;
    const stops = root.querySelectorAll("a[href], button, [tabindex]:not([tabindex='-1'])").length;
    return { view, root, elements, stops };
  };

  for (const [name, text] of Object.entries(SOUPS)) it(`is bounded whatever the markers: ${name}, ${new TextEncoder().encode(text).length} bytes`, () => {
    const { view, elements, stops, root } = draw(text);
    console.log(`RICH ${name}: ${elements} elements, ${stops} stops`);
    expect(elements).toBeLessThanOrEqual(700);
    expect(stops).toBeLessThanOrEqual(60);
    // Nothing is lost: what is past the budget reads as text, a spoiler still covered.
    const count = (what: string) => root.textContent!.split(what).length - 1;
    if (name === "spoilers") expect(count("a") + count("▒")).toBe(2666);
    if (name === "spoilers") expect(count("▒")).toBeGreaterThan(2000);
    if (name === "list") expect(count("a")).toBe(4000);
    if (name === "code") expect(count("a")).toBe(4000);
    if (name === "links") expect(count("a.co")).toBe(1230);
    view.unmount();
  });

  it("leaves a message with ordinary formatting as it was", () => {
    const { root } = draw("*Hi* _there_, see https://ghostly.chat at 1:00 UTC:\n- one\n- ||two||\n`code`");
    expect(root.querySelector("strong")).toHaveTextContent("Hi");
    expect(root.querySelectorAll("[data-testid=rich-spoiler]")).toHaveLength(1);
    expect(root.querySelectorAll("li")).toHaveLength(2);
    expect(root.querySelector("code")).toHaveTextContent("code");
    expect(root.textContent).not.toContain("▒");
    expect(screen.queryByTestId("rich-rest")).toBeNull();
  });
});
