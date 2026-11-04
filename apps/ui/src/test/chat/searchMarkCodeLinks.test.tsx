import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { RichText } from "../../components/rich/RichText";
import { matchRanges, searchText } from "../../lib/chatSearch";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: chat.search

/**
 * Search inside a chat finds a message by a fenced code block's code and by a link's words, so the bubble marks them
 * there: in the block, plain or highlighted, and in the link's text or address as it shows. Only text and inline code
 * were marked, so "1 of 1" jumped to a pasted log or a link with nothing marked in it.
 */
const render = (text: string, term: string) => renderApp(<RichText testId="message-text" text={text} highlight={term} />).container;
const marksIn = (container: HTMLElement) => [...container.querySelectorAll("mark[data-search-match]")].map(mark => mark.textContent);
const marks = (text: string, term: string) => marksIn(render(text, term));

describe("a chat search's words in a code block or a link", () => {
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
