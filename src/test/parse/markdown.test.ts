import { describe, expect, it } from "vitest";
import { labelMisleads, parseMessage, plainText, type Block, type Segment } from "../../lib/parse";

// covers: chat.rich.blocks, chat.rich.mdlinks, chats.list.rows

/** Segments written short, as in tokenizer.test.ts: text as itself, <style:…>, <code:…>, [kind:text]. */
function short(segments: Segment[]): string {
  return segments.map((s) => {
    if (s.type === "text") return s.text;
    if (s.type === "code") return `<code:${s.text}>`;
    if (s.type === "span") return `<${s.style}:${short(s.children)}>`;
    return `[${s.kind}:${s.text}]`;
  }).join("");
}

/** Blocks written short, one per line: p(…), code(…), h2(…), ul/ol with items, quote{…}. */
function outline(blocks: Block[], indent = ""): string {
  return blocks.map((b) => {
    if (b.type === "paragraph") return `${indent}p(${short(b.segments)})`;
    if (b.type === "codeblock") return `${indent}code(${b.code})`;
    if (b.type === "heading") return `${indent}h${b.level}(${short(b.segments)})`;
    if (b.type === "quote") return `${indent}quote{\n${outline(b.blocks, indent + "  ")}\n${indent}}`;
    return b.items.map((item) => [
      `${indent}${b.ordered ? "ol" : "ul"} ${item.marker} ${short(item.segments)}`,
      ...item.children.map((child) => outline([child], indent + "  ")),
    ].join("\n")).join("\n");
  }).join("\n");
}
const parse = (text: string) => outline(parseMessage(text));

describe("lists", () => {
  it("reads -, * and • lines as one bullet list, with formatting inside", () => {
    expect(parse("- one\n* *two*\n• three")).toBe("ul • one\nul • <bold:two>\nul • three");
    expect(parseMessage("- a\n- b")).toEqual([{ type: "list", ordered: false, items: [
      { marker: "•", segments: [{ type: "text", text: "a" }], children: [] },
      { marker: "•", segments: [{ type: "text", text: "b" }], children: [] },
    ] }]);
  });

  it("keeps the author's numbers and their . or )", () => {
    expect(parse("1. first\n2) second\n7. seventh")).toBe("ol 1. first\nol 2) second\nol 7. seventh");
    const [list] = parseMessage("3. c\n10. j");
    expect(list.type === "list" && list.items.map((i) => i.number)).toEqual([3, 10]);
  });

  it("nests one level by a two-space (or tab) indent, deeper counting the same", () => {
    expect(parse("- a\n  - a1\n\t- a2\n      - a3\n- b")).toBe("ul • a\n  ul • a1\n  ul • a2\n  ul • a3\nul • b");
    expect(parse("1. a\n  - x\n  2. y")).toBe("ol 1. a\n  ul • x\n  ol 2. y");
  });

  it("goes on with an indented line and ends at an unindented one", () => {
    expect(parse("- a\n  more of a\n- b\nThanks")).toBe("ul • a\nmore of a\nul • b\np(Thanks)");
  });

  it("starts a new list when bullets turn to numbers", () => {
    expect(parse("- a\n1. b")).toBe("ul • a\nol 1. b");
  });

  it("takes the blank lines and line breaks around a list as the list's own room", () => {
    expect(parse("Intro:\n\n- a\n- b\n\nOutro")).toBe("p(Intro:)\nul • a\nul • b\np(Outro)");
  });

  it("is not a list without the space after the marker", () => {
    for (const text of ["1.5 kg of flour", "-5 °C tonight", "*bold* start", "2026.09.27", "--flag", "-", "- ", "•"]) {
      expect(parseMessage(text).every((b) => b.type === "paragraph")).toBe(true);
    }
    expect(parse("1.5 kg")).toBe("p(1.5 kg)");
  });

  it("is never read inside code", () => {
    expect(parse("```\n- not an item\n> nor a quote\n# nor a heading\n```")).toBe("code(- not an item\n> nor a quote\n# nor a heading)");
    expect(parse("`- a` is how you write one")).toBe("p(<code:- a> is how you write one)");
    expect(parse("- `- a` inside an item")).toBe("ul • <code:- a> inside an item");
  });
});

describe("quotes", () => {
  it("reads > lines as one quote, what they hold read again", () => {
    expect(parse("> said\n> - item\n> ## title")).toBe("quote{\n  p(said)\n  ul • item\n  h2(title)\n}");
  });

  it("takes > alone as an empty line of the quote", () => {
    expect(parse("> a\n>\n> b")).toBe("quote{\n  p(a\n\nb)\n}");
  });

  it("is only at the start of a line", () => {
    expect(parse("a > b")).toBe("p(a > b)");
    expect(parse("x\n5 > 3")).toBe("p(x\n5 > 3)");
    expect(parse(">no space")).toBe("p(>no space)");
  });

  it("is text when it holds nothing", () => {
    for (const text of [">", "> ", ">\n>"]) expect(parseMessage(text)).toEqual([{ type: "paragraph", segments: [{ type: "text", text }] }]);
  });

  it("holds no quote inside a quote", () => {
    expect(parse("> > deeper")).toBe("quote{\n  p(> deeper)\n}");
  });
});

describe("headings", () => {
  it("reads # to ### with a space", () => {
    expect(parse("# One\n## Two\n### Three\n#### Four")).toBe("h1(One)\nh2(Two)\nh3(Three)\np(#### Four)");
  });

  it("leaves hashtags and issue numbers as text", () => {
    expect(parse("#general")).toBe("p(#general)");
    expect(parse("#360 is merged")).toBe("p(#360 is merged)");
  });
});

describe("mixed", () => {
  it("reads a status report", () => {
    const report = [
      "## Status",
      "Merged today:",
      "- #360 delivery states",
      "  - two follow-ups",
      "1. rebase",
      "2) CI",
      "> waiting on review",
      "> - one comment left",
      "Next: [the plan](https://ghostly.tools/docs)",
    ].join("\n");
    expect(parse(report)).toBe([
      "h2(Status)",
      "p(Merged today:)",
      "ul • #360 delivery states",
      "  ul • two follow-ups",
      "ol 1. rebase",
      "ol 2) CI",
      "quote{",
      "  p(waiting on review)",
      "  ul • one comment left",
      "}",
      "p(Next: [md-link:[the plan](https://ghostly.tools/docs)])",
    ].join("\n"));
  });

  it("leaves text with none of them exactly as today: one paragraph, line breaks kept", () => {
    for (const text of ["a\nb\n\nc", "\n\nhi\n\n", " ", "one - two\nthree > four"]) {
      expect(parseMessage(text)).toEqual([{ type: "paragraph", segments: [{ type: "text", text }] }]);
    }
  });
});

describe("[text](url) links", () => {
  const link = (text: string) => parseMessage(text).flatMap((b) => (b.type === "paragraph" ? b.segments : [])).find((s) => s.type === "atom");

  it("shows the text, and takes a bracket pair in the address", () => {
    expect(link("see [the docs](https://ghostly.tools/docs).")).toMatchObject({ kind: "md-link", data: { url: "https://ghostly.tools/docs", showUrl: false } });
    expect(link("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))")).toMatchObject({ data: { url: "https://en.wikipedia.org/wiki/Foo_(bar)" } });
  });

  it("reads formatting in the text", () => {
    expect(link("[*bold* and _not_](https://ghostly.tools)")).toMatchObject({ data: { label: [{ type: "span", style: "bold" }, { type: "text", text: " and " }, { type: "span", style: "italic" }] } });
  });

  it("is not made across code: code is read first, and nothing inside it", () => {
    expect(link("[`x`](https://ghostly.tools)")).toMatchObject({ kind: "link" });
    expect(parse("`[a](https://ghostly.tools)`")).toBe("p(<code:[a](https://ghostly.tools)>)");
  });

  it("refuses anything but http(s)", () => {
    for (const text of ["[a](javascript:alert(1))", "[a](data:text/html,<b>x</b>)", "[a](file:///etc/passwd)", "[a](//evil.example)", "[a](ftp://x.example)"]) {
      expect(link(text)).toBeUndefined();
      expect(plainText(text)).toBe(text);
    }
  });

  it("shows the address when the text names another host", () => {
    expect(link("[ghostly.tools](https://evil.example/login)")).toMatchObject({ data: { showUrl: true } });
    expect(link("[https://ghostly.tools](https://evil.example)")).toMatchObject({ data: { showUrl: true } });
    expect(link("[ghostly.tools](https://ghostly.tools.evil.example)")).toMatchObject({ data: { showUrl: true } });
    expect(plainText("[ghostly.tools](https://evil.example/login)")).toBe("https://evil.example/login");
  });

  it("shows the text when it names the link's own host, or one it sits under", () => {
    for (const [label, url] of [
      ["ghostly.tools", "https://ghostly.tools/docs"],
      ["www.ghostly.tools", "https://ghostly.tools"],
      ["GHOSTLY.TOOLS", "https://ghostly.tools"],
      ["ghostly.tools", "https://docs.ghostly.tools"],
      ["https://ghostly.tools/a", "https://ghostly.tools/b"],
      ["the docs, v1.2", "https://ghostly.tools"],
      ["e.g. this", "https://ghostly.tools"],
    ]) expect(labelMisleads(label, url)).toBe(false);
  });

  it("treats look-alike hosts, addresses and hidden characters as misleading", () => {
    expect(labelMisleads("аpple.com", "https://apple.com")).toBe(true);
    expect(labelMisleads("apple.com", "https://xn--pple-43d.com")).toBe(true);
    expect(labelMisleads("10.0.0.1", "https://ghostly.tools")).toBe(true);
    expect(labelMisleads("‮moc.elppa", "https://evil.example")).toBe(true);
    expect(labelMisleads("docs​", "https://ghostly.tools")).toBe(true);
    // A file name reads as a host: the address shows, the safe side.
    expect(labelMisleads("report.pdf", "https://ghostly.tools/report.pdf")).toBe(true);
  });

  it("previews as its text in the chat list", () => {
    expect(plainText("read [**the plan**](https://ghostly.tools/p) now")).toBe("read the plan now");
  });

  it("leaves a bare link inside the brackets to the text check, not to a second link", () => {
    const segments = parseMessage("[https://ghostly.tools](https://ghostly.tools)")[0];
    expect(segments.type === "paragraph" && segments.segments).toHaveLength(1);
  });
});

describe("the chat list", () => {
  it("keeps list markers as • and the author's numbers, quotes and headings as their text", () => {
    expect(plainText("## Plan\n- *a*\n  - b\n2) c\n> said")).toBe("Plan\n• a\n  • b\n2) c\nsaid");
  });
});
