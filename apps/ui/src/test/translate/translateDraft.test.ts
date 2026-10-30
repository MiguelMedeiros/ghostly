import { describe, expect, it, vi } from "vitest";
import { carryMentions, draftLanguage, draftParts, joinParts, translateDraft } from "../../lib/translateDraft";
import type { DetectLanguages } from "../../lib/translateWhich";

const words = (text: string, mentions?: { o: number; l: number }[]) =>
  draftParts(text, mentions).filter((part) => part.kind === "words").map((part) => part.text);

describe("what of a draft is translated", () => {
  it("only the words: code, links, Cashu tokens, invoices and long keys stay as typed", () => {
    const token = `cashuB${"o2Fte".repeat(12)}`;
    const invoice = `lnbc10u1p${"q".repeat(40)}`;
    const text = `look at this https://example.com/a?b=1 and run \`npm ci\`\n\`\`\`\nconst a = "hello";\n\`\`\`\nhere is ${token} and pay ${invoice} please`;
    expect(words(text)).toEqual(["look at this", "and run", "here is", "and pay", "please"]);
    const parts = draftParts(text);
    // Nothing is lost or moved: joined back untouched, it is the draft.
    expect(joinParts(parts, [])).toBe(text);
    const upper = joinParts(parts, words(text).map((w) => w.toUpperCase()));
    expect(upper).toContain("https://example.com/a?b=1");
    expect(upper).toContain("`npm ci`");
    expect(upper).toContain('const a = "hello";');
    expect(upper).toContain(token);
    expect(upper).toContain(invoice);
    expect(upper.startsWith("LOOK AT THIS https://")).toBe(true);
  });

  it("each line goes on its own, and its spaces and line breaks stay", () => {
    expect(words("  bom dia\n\ntudo bem?  ")).toEqual(["bom dia", "tudo bem?"]);
    expect(joinParts(draftParts("  bom dia\n\ntudo bem?  "), ["good morning", "all good?"])).toBe("  good morning\n\nall good?  ");
  });

  it("a group mention stays as typed, by its place in code points", () => {
    const text = "😀 @Ana Lima vem amanhã?";
    // "@Ana Lima" starts at code point 2 (the emoji is one code point, two UTF-16 units).
    expect(words(text, [{ o: 2, l: 9 }])).toEqual(["vem amanhã?"]);
    expect(joinParts(draftParts(text, [{ o: 2, l: 9 }]), ["coming tomorrow?"])).toBe("😀 @Ana Lima coming tomorrow?");
  });

  it("a draft without words is not sent to the translator", async () => {
    const translate = vi.fn(async (texts: string[]) => texts);
    expect(await translateDraft(draftParts("https://example.com 👍 42"), translate)).toBe("https://example.com 👍 42");
    expect(translate).not.toHaveBeenCalled();
    expect(await translateDraft(draftParts("oi https://example.com"), async () => ["hi"])).toBe("hi https://example.com");
  });
});

describe("the members a translation names", () => {
  it("are the draft's, found again wherever the translation put them", () => {
    const draft = "fala com @Bob amanhã";
    const named = [{ k: "bobkey", o: 9, l: 4 }];
    expect(carryMentions(draft, named, "talk to @Bob tomorrow")).toEqual([{ k: "bobkey", o: 8, l: 4 }]);
    expect(carryMentions(draft, named, "@Bob, talk tomorrow")).toEqual([{ k: "bobkey", o: 0, l: 4 }]);
    // Edited out of the translation: not named.
    expect(carryMentions(draft, named, "talk tomorrow")).toEqual([]);
    expect(carryMentions("hi", [], "oi")).toEqual([]);
  });
});

describe("the language a draft is written in", () => {
  const detect = (code: string, probability = 0.9): DetectLanguages => () => [{ code, probability }];

  it("is the detector's, when it is sure", () => {
    expect(draftLanguage("Tomorrow I can after six", detect("en"))).toBe("en");
    expect(draftLanguage("Amanhã eu posso depois das seis", detect("pt-BR"))).toBe("pt");
  });

  it("is unknown for a few letters, a guess it is not sure of, or undetermined", () => {
    expect(draftLanguage("ok", detect("en"))).toBeNull();
    expect(draftLanguage("lol no way 😂", detect("vo", 0.3))).toBeNull();
    expect(draftLanguage("something long enough", detect("und"))).toBeNull();
  });

  it("is nothing at all for a draft with no words", () => {
    expect(draftLanguage("https://example.com 42 😀", detect("en"))).toBeUndefined();
  });
});
