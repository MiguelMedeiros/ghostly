import { describe, expect, it } from "vitest";
import { RichText } from "../../components/rich/RichText";
import { renderApp } from "../render";

// covers: chat.search

/**
 * Search inside a chat finds a formatted message by the words it shows ("*hello* world" by "hello world"), and the
 * bubble marks those words where it shows them: across the formatting, and inside code too. Only a plain run of text
 * was marked, so such a match was counted and jumped to with nothing marked in its bubble.
 */
const marks = (text: string, term: string) => {
  const { container } = renderApp(<RichText testId="message-text" text={text} highlight={term} />);
  return [...container.querySelectorAll("mark[data-search-match]")].map(mark => mark.textContent);
};

describe("a chat search's words in a formatted bubble", () => {
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
