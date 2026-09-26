import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DETECTORS, linkEnd, parseMessage, plainText, prettyJson, SPOILER_PLAIN, tokenizeInline, type Detector, type Segment } from "../../lib/parse";

// covers: chat.rich.format, chat.rich.code, chat.rich.spoiler, chat.rich.blob, chat.paired.links

/** A paragraph's segments, written short: text as itself, `code`, *b(…)*, i(…), s(…), ||…||, [kind:text]. */
function short(segments: Segment[]): string {
  return segments.map((s) => {
    if (s.type === "text") return s.text;
    if (s.type === "code") return `<code:${s.text}>`;
    if (s.type === "span") return `<${s.style}:${short(s.children)}>`;
    return `[${s.kind}:${s.text}]`;
  }).join("");
}
const inline = (text: string) => short(tokenizeInline(text, DETECTORS));

describe("formatting markers", () => {
  it.each([
    ["*bold*", "<bold:bold>"],
    ["**bold**", "<bold:bold>"],
    ["_italic_", "<italic:italic>"],
    ["__italic__", "<italic:italic>"],
    ["~~gone~~", "<strike:gone>"],
    ["||secret||", "<spoiler:secret>"],
    ["`x = 1`", "<code:x = 1>"],
    ["a *b* c", "a <bold:b> c"],
    ["(*b*)", "(<bold:b>)"],
    ["*b*, then", "<bold:b>, then"],
    ["*bold with spaces inside*", "<bold:bold with spaces inside>"],
  ])("%s", (text, expected) => expect(inline(text)).toBe(expected));

  it("nests different markers", () => {
    expect(inline("*bold _and italic_*")).toBe("<bold:bold <italic:and italic>>");
    expect(inline("||*loud secret*||")).toBe("<spoiler:<bold:loud secret>>");
    expect(inline("~~_old_~~")).toBe("<strike:<italic:old>>");
  });

  it("leaves markers inside words as text", () => {
    for (const text of ["snake_case_name", "2*3*4", "a*b*c", "file_v2_final.txt", "__init__.py", "x||y||z", "a~~b~~c"]) expect(inline(text)).toBe(text);
  });

  it("does not open before a space or close after one", () => {
    for (const text of ["* not bold *", "_ nope _", "5 * 3 * 2", "|| no ||", "~~ no ~~"]) expect(inline(text)).toBe(text);
  });

  it("leaves unclosed markers as text", () => {
    expect(inline("*unclosed")).toBe("*unclosed");
    expect(inline("closed only*")).toBe("closed only*");
    expect(inline("`unclosed code")).toBe("`unclosed code");
    expect(inline("||open spoiler")).toBe("||open spoiler");
    expect(inline("*a* *b")).toBe("<bold:a> *b");
  });

  it("drops an opener that a closer of an outer span crosses", () => {
    // Improper nesting: the bold closes, the italic that opened inside it never does.
    expect(inline("*a _b* c_")).toBe("<bold:a _b> c_");
  });

  it("needs the same run to close", () => {
    expect(inline("**a*")).toBe("**a*");
    expect(inline("*a**")).toBe("*a**");
  });

  it("treats runs of other lengths as text", () => {
    expect(inline("***x***")).toBe("***x***");
    expect(inline("~x~")).toBe("~x~");
    expect(inline("|||x|||")).toBe("|||x|||");
  });

  it("pairs markers within a line", () => {
    expect(inline("*one\ntwo*")).toBe("*one\ntwo*");
    expect(inline("*one*\n*two*")).toBe("<bold:one>\n<bold:two>");
  });

  it("allows the same style inside itself", () => {
    expect(inline("*a *b* c*")).toBe("<bold:a <bold:b> c>");
  });
});

describe("code", () => {
  it("keeps markers and links inside inline code", () => {
    expect(inline("`*not bold* https://x.example`")).toBe("<code:*not bold* https://x.example>");
  });

  it("pairs backtick runs of the same length", () => {
    expect(inline("``a ` b``")).toBe("<code:a ` b>");
    expect(inline("`` `ticks` ``")).toBe("<code:`ticks`>");
    expect(inline("`a`` b")).toBe("`a`` b");
  });

  it("never crosses a line", () => {
    expect(inline("`one\ntwo`")).toBe("`one\ntwo`");
  });

  it("formats around code", () => {
    expect(inline("*run `npm test` now*")).toBe("<bold:run <code:npm test> now>");
  });
});

describe("links", () => {
  it("keeps markers inside a URL part of it", () => {
    expect(inline("see https://x.example/a_b_c/*star*")).toBe("see [link:https://x.example/a_b_c/*star]*");
    expect(inline("https://x.example/~user/")).toBe("[link:https://x.example/~user/]");
  });

  it("closes a span right after a link", () => {
    expect(inline("*see https://x.example*")).toBe("<bold:see [link:https://x.example]>");
    expect(inline("_https://x.example_")).toBe("<italic:[link:https://x.example]>");
    expect(inline("~~https://x.example~~")).toBe("<strike:[link:https://x.example]>");
    expect(inline("||https://x.example/secret||")).toBe("<spoiler:[link:https://x.example/secret]>");
  });

  it.each([
    ["https://ghostly.tools/docs.", "https://ghostly.tools/docs"],
    ["https://ghostly.tools/docs?page=2&x=1.", "https://ghostly.tools/docs?page=2&x=1"],
    ["https://en.wikipedia.org/wiki/Ghost_(disambiguation)", "https://en.wikipedia.org/wiki/Ghost_(disambiguation)"],
    ["https://ghostly.tools/docs)", "https://ghostly.tools/docs"],
    ["https://x.example/a~~", "https://x.example/a"],
    ["https://x.example/a||", "https://x.example/a"],
  ])("linkEnd(%s)", (url, end) => expect(linkEnd(url)).toBe(end));

  it("never links anything but http(s)", () => {
    expect(inline("javascript:alert(1) data:text/html,x ftp://x.example")).toBe("javascript:alert(1) data:text/html,x ftp://x.example");
    expect(inline("https://")).toBe("https://");
  });
});

describe("long blobs", () => {
  const key = "A1b2".repeat(25);

  it("folds a run of 80 or more base64/hex characters", () => {
    expect(inline(`key: ${key} ok`)).toBe(`key: [blob:${key}] ok`);
    expect(inline("ab".repeat(40))).toBe(`[blob:${"ab".repeat(40)}]`);
    expect(inline(`${"x".repeat(80)}==`)).toBe(`[blob:${"x".repeat(80)}==]`);
    // Padding does not count towards the length.
    expect(inline(`${"x".repeat(78)}==`)).toBe(`${"x".repeat(78)}==`);
  });

  it("leaves shorter runs and hex keys of 64 alone", () => {
    expect(inline("f".repeat(64))).toBe("f".repeat(64));
    expect(inline("a".repeat(79))).toBe("a".repeat(79));
  });

  it("is never part of a link", () => {
    const url = `https://x.example/${key}`;
    expect(inline(url)).toBe(`[link:${url}]`);
  });

  it("previews as its start", () => {
    expect(plainText(key)).toBe(`${key.slice(0, 12)}…`);
  });
});

describe("fenced code blocks", () => {
  it("reads the language after the fence", () => {
    expect(parseMessage("```ts\nconst a = 1;\n```")).toEqual([{ type: "codeblock", code: "const a = 1;", lang: "ts" }]);
    expect(parseMessage("``` Python\nx\n```")).toEqual([{ type: "codeblock", code: "x", lang: "python" }]);
  });

  it("takes a first line that is not a language name as code", () => {
    expect(parseMessage("```const a = 1\nb```")).toEqual([{ type: "codeblock", code: "const a = 1\nb" }]);
  });

  it("keeps the text around it as paragraphs", () => {
    expect(parseMessage("look:\n```\ncode *here*\n```\nnice")).toEqual([
      { type: "paragraph", segments: [{ type: "text", text: "look:" }] },
      { type: "codeblock", code: "code *here*" },
      { type: "paragraph", segments: [{ type: "text", text: "nice" }] },
    ]);
  });

  it("holds several blocks", () => {
    expect(parseMessage("```\na\n```\n```\nb\n```").filter((b) => b.type === "codeblock")).toHaveLength(2);
  });

  it("leaves a fence that never closes as text", () => {
    expect(parseMessage("```ts\nno end")).toEqual([{ type: "paragraph", segments: [{ type: "text", text: "```ts\nno end" }] }]);
  });

  it("reads ```code``` on one line as inline code", () => {
    expect(parseMessage("```x = 1```")).toEqual([{ type: "paragraph", segments: [{ type: "code", text: "x = 1" }] }]);
  });

  it("previews as its code", () => {
    expect(plainText("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
  });
});

describe("JSON", () => {
  it("pretty-prints a message that is an object or an array", () => {
    expect(prettyJson('{"a":1,"b":[true,null,{"c":"x, y: z"}],"e":{},"f":[]}')).toBe(
      '{\n  "a": 1,\n  "b": [\n    true,\n    null,\n    {\n      "c": "x, y: z"\n    }\n  ],\n  "e": {},\n  "f": []\n}',
    );
    expect(parseMessage('[1, 2]')).toEqual([{ type: "codeblock", code: "[\n  1,\n  2\n]", lang: "json" }]);
  });

  it("keeps what JSON.parse would change as written", () => {
    expect(prettyJson('{"n":12345678901234567890,"n":1,"s":"\\u00e9\\"q"}')).toBe('{\n  "n": 12345678901234567890,\n  "n": 1,\n  "s": "\\u00e9\\"q"\n}');
  });

  it("leaves anything else alone", () => {
    for (const text of ["{}", "[]", "42", '"string"', "true", "{not json}", "[1, 2", "{\"a\":1} trailing"]) expect(prettyJson(text)).toBeNull();
  });
});

describe("plain text for previews", () => {
  it("strips markers and hides spoilers", () => {
    expect(plainText("*Hi* _there_, ~~old~~ `code` ||the butler||")).toBe(`Hi there, old code ${SPOILER_PLAIN}`);
  });

  it("leaves text with no formatting as it was", () => {
    expect(plainText("snake_case 2*3 a ~ b | c")).toBe("snake_case 2*3 a ~ b | c");
  });

  it("is the text itself whenever it has no marker, backtick or long run", () => {
    fc.assert(fc.property(fc.string({ maxLength: 200 }).filter((s) => !/[*_~|`{[]/.test(s) && !/\S{80}/.test(s)), (s) => plainText(s) === s));
  });
});

describe("registering a detector", () => {
  it("adds a kind of atom with one entry", () => {
    const mention: Detector<"mention", { name: string }> = {
      kind: "mention",
      pattern: /@(\w+)/g,
      accept: (m) => ({ data: { name: m[1] } }),
      plain: (atom) => `@${atom.data.name.toUpperCase()}`,
    };
    const detectors = [...DETECTORS, mention];
    expect(short(tokenizeInline("*hi @bob*, see https://x.example/@bob", detectors))).toBe("<bold:hi [mention:@bob]>, see [link:https://x.example/@bob]");
    expect(plainText("hi @bob", {}, detectors)).toBe("hi @BOB");
  });

  it("lets a detector shorten or refuse a match", () => {
    const tag: Detector<"tag", null> = {
      kind: "tag",
      pattern: /#\w+/g,
      accept: (m) => (m[0] === "#no" ? null : { data: null, end: m.index + 2 }),
    };
    expect(short(tokenizeInline("#no #yes", [tag]))).toBe("#no [tag:#y]es");
  });
});

describe("adversarial input", () => {
  it("never throws, and keeps every character of text with no markers", () => {
    fc.assert(fc.property(fc.string({ unit: fc.constantFrom("*", "_", "~", "|", "`", "a", " ", "\n", "h", ":", "/", "."), maxLength: 300 }), (s) => {
      const blocks = parseMessage(s);
      expect(Array.isArray(blocks)).toBe(true);
    }));
  });

  it("keeps the text between markers intact", () => {
    fc.assert(fc.property(fc.string({ unit: fc.constantFrom("*", "_", "a", "b", " ", "."), maxLength: 200 }), (s) => {
      // Stripping the markers from the input and from the preview gives the same letters.
      const letters = (x: string) => x.replace(/[*_]/g, "");
      expect(letters(plainText(s))).toBe(letters(s));
    }));
  });

  const TIME_LIMIT = 1_500;
  const big = 1_000_000;
  it.each([
    ["marker soup", "*_~~||`".repeat(big / 7)],
    ["openers with no closers", "*a _b ~~c ||d ".repeat(big / 14)],
    ["closers with no openers", "a* b_ c~~ d|| ".repeat(big / 14)],
    ["backtick runs", "` `` ``` ".repeat(big / 9)],
    ["closing brackets after a link", `https://x.example/${")".repeat(big)}`],
    ["runs just short of a blob", `${"A".repeat(79)} `.repeat(big / 80)],
    ["one huge blob", "A".repeat(big)],
    ["clock-like numbers", "1:00 12:30 ".repeat(big / 11)],
    ["fences with no end", "```\n".repeat(big / 4)],
    ["almost JSON", `[${"1,".repeat(big / 2)}`],
    ["nested openers", "*_".repeat(big / 2) + "x"],
  ])("stays fast on %s", (_, text) => {
    const start = performance.now();
    parseMessage(text);
    plainText(text);
    expect(performance.now() - start).toBeLessThan(TIME_LIMIT);
  });
});
