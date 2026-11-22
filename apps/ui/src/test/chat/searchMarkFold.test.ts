import { describe, expect, it, vi } from "vitest";
import { matchRanges } from "../../lib/chatSearch";

// covers: chat.search

/*
 * A chat search marks its words in each bubble it finds (`matchRanges`), and it found where they are by folding the text
 * (case and accents off) one character at a time: 1.8 ms for a 16 KB message, 180 ms for each new word with 100 of them
 * found on screen. A run of ASCII is folded whole now, and any other character is folded once. Counted by `foldText`'s
 * calls; the places found are the same.
 */

const counts = vi.hoisted(() => ({ fold: 0 }));

vi.mock("@ghostly/browser/shared/fold", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ghostly/browser/shared/fold")>();
  return { ...actual, foldText: (text: string) => { counts.fold++; return actual.foldText(text); } };
});

const long = (words: string, size = 16_000) => words.repeat(Math.ceil(size / words.length)).slice(0, size);
const folds = (text: string, term: string) => {
  counts.fold = 0;
  const ranges = matchRanges(text, term);
  return { ranges, folds: counts.fold };
};

describe("a search's marks in a long message", () => {
  it("fold an English text whole, not a character at a time", () => {
    const { ranges, folds: count } = folds(long("The ghost in the attic moved the LANTERN again. "), "lantern");
    expect(ranges.length).toBeGreaterThan(300);
    expect(ranges[0]).toEqual([33, 40]);
    expect(count).toBeLessThan(10);
  });

  it("fold each other character once, however often it comes", () => {
    const text = long("Olá, o fantasma no sótão mexeu a lanterna. 幽霊が屋根裏でランタンを動かした。");
    folds(text, "sotao");
    const { ranges, folds: count } = folds(text, "ランタン");
    expect(ranges.length).toBeGreaterThan(100);
    // Its words were folded by the first search: the second folds only its own words.
    expect(count).toBeLessThan(10);
  });

  it("find the same places as folding a character at a time: accents, case, combining accents, emoji", () => {
    const texts = ["Café CAFE cafe\u0301! Ação na İstanbul. 😀 café", long("Ein Straße, ÅNGSTRÖM, naïve 😀 x\u0301y. "), "한국어 텍스트 ﬁle ǅemal Ωmega"];
    for (const text of texts) for (const term of ["cafe", "acao", "istanbul", "angstrom", "naive", "x", "y", "😀", "한국", "ﬁle", "ǆe", "ω"]) {
      expect(matchRanges(text, term), `${term} in ${text.slice(0, 20)}`).toEqual(oneAtATime(text, term));
    }
  });
});

/** `matchRanges` as it was: every character folded on its own. */
function oneAtATime(text: string, query: string): [number, number][] {
  const fold = (s: string) => s.normalize("NFD").toLowerCase().replace(/\p{M}/gu, "");
  const needle = fold(query.trim());
  let folded = "";
  const from: number[] = [];
  for (let i = 0; i < text.length;) {
    const size = (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    const part = fold(text.slice(i, i + size));
    folded += part;
    for (let j = 0; j < part.length; j++) from.push(i);
    i += size;
  }
  const ranges: [number, number][] = [];
  for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length)) {
    const last = from[at + needle.length - 1];
    let end = last + ((text.codePointAt(last) ?? 0) > 0xffff ? 2 : 1);
    while (end < text.length && fold(text[end]) === "") end++;
    ranges.push([from[at], end]);
  }
  return ranges;
}
