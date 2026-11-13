import { describe, expect, it } from "vitest";
import { RichText, SEARCH_MARK_BUDGET } from "../../components/rich/RichText";
import { renderApp } from "../render";

// covers: chat.search

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

describe("a chat search's marks in one bubble", () => {
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
