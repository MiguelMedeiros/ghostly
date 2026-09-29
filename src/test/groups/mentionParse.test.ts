import { describe, expect, it } from "vitest";
import { validMentions } from "@ghostly/core";
import { parseMessage, plainText } from "../../lib/parse";
import {
  composeMentions, filterCandidates, insertMention, markMentions, mentionLabel, mentionQueryAt, mentionViews, PICKER_ROWS,
} from "../../lib/parse/mentions";

// covers: groups.mentions

const K = (c: string) => c.padEnd(52, "y");
const people = [
  { key: K("a"), name: "Ana Lima", tag: "…aaaaaa" },
  { key: K("b"), name: "Bob", tag: "…bbbbbb" },
  { key: K("c"), name: "Émile", tag: "…cccccc" },
  { key: K("d"), name: "Member ybndrf...yyyyyy", tag: "…zzz999" },
];

describe("the @ being typed", () => {
  it("is an @ at the start, or after a space or an opening bracket, up to the caret", () => {
    expect(mentionQueryAt("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(mentionQueryAt("hi @bo", 6)).toEqual({ start: 3, end: 6, query: "bo" });
    expect(mentionQueryAt("(@bo", 4)).toEqual({ start: 1, end: 4, query: "bo" });
    expect(mentionQueryAt("line\n@x", 7)).toEqual({ start: 5, end: 7, query: "x" });
    // The caret decides: in the middle of the text, only what is before it counts.
    expect(mentionQueryAt("hi @bob there", 7)).toEqual({ start: 3, end: 7, query: "bob" });
  });
  it("is not an address, a finished word, or an @ after a space was typed", () => {
    expect(mentionQueryAt("me@bob", 6)).toBeNull();
    expect(mentionQueryAt("@bob ", 5)).toBeNull();
    expect(mentionQueryAt("@@", 2)).toBeNull();
    expect(mentionQueryAt("@" + "x".repeat(33), 34)).toBeNull();
    expect(mentionQueryAt("plain", 5)).toBeNull();
  });
});

describe("which members fit", () => {
  it("everyone for a bare @, then names that start with it, words that do, and keys", () => {
    expect(filterCandidates(people, "").map(p => p.name)).toEqual(people.map(p => p.name));
    expect(filterCandidates(people, "b").map(p => p.name)).toEqual(["Bob"]);
    expect(filterCandidates(people, "li").map(p => p.name)).toEqual(["Ana Lima"]);
    // Accents and case do not matter.
    expect(filterCandidates(people, "EMI").map(p => p.name)).toEqual(["Émile"]);
    // The key: its tag, or the key itself.
    expect(filterCandidates(people, "zzz9").map(p => p.name)).toEqual(["Member ybndrf...yyyyyy"]);
    expect(filterCandidates(people, "ay").map(p => p.name)).toEqual([]);
    expect(filterCandidates([{ key: "ybndrf".padEnd(52, "q"), name: "Kim", tag: "…qqqqqq" }], "ybn").map(p => p.name)).toEqual(["Kim"]);
    // Two letters found somewhere inside someone's key are not them.
    expect(filterCandidates([{ key: "x".repeat(20) + "bo" + "x".repeat(30), name: "Carol", tag: "…xxxxxx" }], "bo")).toEqual([]);
    expect(filterCandidates(people, "q").map(p => p.name)).toEqual([]);
  });
  it("ranks a name's start before a word's", () => {
    const two = [{ key: K("x"), name: "Lee Ann", tag: "" }, { key: K("y"), name: "Ann", tag: "" }];
    expect(filterCandidates(two, "ann").map(p => p.name)).toEqual(["Ann", "Lee Ann"]);
  });
  it("shows at most a few rows", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ key: K(String(i)), name: `M${i}`, tag: "" }));
    expect(filterCandidates(many, "m")).toHaveLength(PICKER_ROWS);
  });
});

describe("the token a choice inserts", () => {
  it("replaces what was typed with @Name and a space, the caret after it", () => {
    const text = "hi @bo and more";
    expect(insertMention(text, { start: 3, end: 6, query: "bo" }, "Bob")).toEqual({ text: "hi @Bob and more", caret: 8 });
    expect(insertMention("@", { start: 0, end: 1, query: "" }, "Ana Lima")).toEqual({ text: "@Ana Lima ", caret: 10 });
  });
  it("is the member's name, with no @ in it and not longer than a mention may be", () => {
    expect(mentionLabel("  Ana   Lima ")).toBe("Ana Lima");
    expect(mentionLabel("@bob@")).toBe("bob");
    expect(Array.from(mentionLabel("👻".repeat(100)))).toHaveLength(64);
    expect(mentionLabel("@")).toBe("member");
  });
});

describe("the mentions of a text about to be sent", () => {
  const bob = { key: K("b"), label: "Bob" }, ana = { key: K("a"), label: "Ana Lima" };
  it("finds each chosen token that still stands whole, in code points of the trimmed text", () => {
    const text = "  👻 @Bob and @Ana Lima, and @Bobby ";
    const mentions = composeMentions(text, [bob, ana]);
    expect(mentions).toEqual([{ k: K("b"), o: 2, l: 4 }, { k: K("a"), o: 11, l: 9 }]);
    // What the receiving side keeps is exactly this.
    expect(validMentions(mentions, text.trim(), false)).toEqual(mentions);
  });
  it("forgets a token edited away, and names every place a token stands", () => {
    expect(composeMentions("@Bo hi", [bob])).toEqual([]);
    expect(composeMentions("@Bob, @Bob!", [bob])).toEqual([{ k: K("b"), o: 0, l: 4 }, { k: K("b"), o: 6, l: 4 }]);
  });
  it("lets a longer token win where two start at the same place", () => {
    const ann = { key: K("n"), label: "Ann" }, annLee = { key: K("l"), label: "Ann Lee" };
    expect(composeMentions("@Ann Lee hi @Ann", [ann, annLee])).toEqual([{ k: K("l"), o: 0, l: 8 }, { k: K("n"), o: 12, l: 4 }]);
  });
  it("sends at most sixteen", () => {
    expect(composeMentions("@Bob ".repeat(20), [bob])).toHaveLength(16);
  });
});

describe("a text cut at its mentions", () => {
  it("marks each place for the rich text, which draws it as a mention atom with formatting around it", () => {
    const view = { o: 3, l: 4, key: K("b"), name: "Bobby", me: true };
    const marked = markMentions("👻 *@Bob*, hi", [view]);
    expect(marked).toBe("👻 *\uE0000\uE001*, hi");
    const [block] = parseMessage(marked, { mentions: [view] });
    expect(block).toEqual({ type: "paragraph", segments: [
      { type: "text", text: "👻 " },
      { type: "span", style: "bold", children: [{ type: "atom", kind: "member-mention", text: "\uE0000\uE001", data: view }] },
      { type: "text", text: ", hi" },
    ] });
    expect(plainText(marked, { mentions: [view] })).toBe("👻 @Bobby, hi");
    // A place past the end, or behind the last one, stays text; a text that already holds a mark is left alone.
    expect(markMentions("hi", [{ o: 1, l: 5 }])).toBe("hi");
    expect(markMentions("x\uE000 @Bob", [{ o: 3, l: 4 }])).toBe("x\uE000 @Bob");
    // Without its mention, a mark is no atom.
    expect(parseMessage(marked)[0]).not.toMatchObject({ segments: [{}, { children: [{ type: "atom" }] }] });
  });
  it("names each mention as the group knows the member now", () => {
    const members = [{ key: K("a"), name: "Ana", me: false }, { key: K("m"), name: "", me: true }];
    const text = "@Anna @me @Old @everyone";
    const mentions = [{ k: K("a"), o: 0, l: 5 }, { k: K("m"), o: 6, l: 3 }, { k: K("o"), o: 10, l: 4 }, { k: "*", o: 15, l: 9 }];
    expect(mentionViews(text, mentions, members, false).map(v => [v.name, v.me])).toEqual([["Ana", false], ["me", true], ["Old", false], ["everyone", true]]);
    expect(mentionViews(text, mentions, members, true)[3].me).toBe(false);
    expect(mentionViews(text, undefined, members, false)).toEqual([]);
  });
});
