import { describe, expect, it } from "vitest";
import { previewText } from "../../lib/chatList";
import { findMoney } from "../../lib/money";
import { DETECTORS, parseMessage, plainText, shownUrl, tokenizeInline } from "../../lib/parse";
import { JSON_LIMITS, prettyJson } from "../../lib/parse/json";
import { findLocation, locationIn } from "../../lib/parse/location";
import { mentionViews } from "../../lib/parse/mentions";
import { findBip21 } from "../../lib/parse/money-bitcoin";
import { trimUriEnd } from "../../lib/parse/money-text";

// covers: chat.rich.code, chat.rich.time, chat.paired.links, chats.list.rows, chat.location.card, groups.mentions, payments.money.onchain-card

/*
 * What a contact or a group member can put in a message, at the size a group message allows (16 KiB), against the
 * parser and the chat list. Each case once took seconds or crashed; the bound here is loose enough for a busy CI
 * runner and still far below what any of them took.
 */
const BOUND_MS = 100;
const SIZE = 16 * 1024;

function quickly<T>(work: () => T): T {
  const start = performance.now();
  const out = work();
  expect(performance.now() - start).toBeLessThan(BOUND_MS);
  return out;
}

describe("deep JSON", () => {
  const deep = "[".repeat(SIZE / 2 - 1) + "1" + "]".repeat(SIZE / 2 - 1);

  it("is not pretty-printed, and reads as text at once", () => {
    expect(quickly(() => prettyJson(deep))).toBeNull();
    const blocks = quickly(() => parseMessage(deep));
    expect(blocks.every(block => block.type === "paragraph")).toBe(true);
    expect(quickly(() => plainText(deep))).toBe(deep);
    expect(quickly(() => previewText(deep))).toBe(deep);
  });

  it("is pretty-printed up to the depth bound, and not one level past it", () => {
    const nested = (levels: number) => "[".repeat(levels) + "1" + "]".repeat(levels);
    expect(prettyJson(nested(JSON_LIMITS.depth))).toContain("\n" + "  ".repeat(JSON_LIMITS.depth) + "1\n");
    expect(prettyJson(nested(JSON_LIMITS.depth + 1))).toBeNull();
  });

  it("is not pretty-printed past the input or the output bound", () => {
    const long = JSON.stringify({ text: "x".repeat(JSON_LIMITS.inputChars) });
    expect(prettyJson(long)).toBeNull();
    // Within both input bounds, but every value on its own deeply indented line comes out far past 64 KiB.
    const wide = "[".repeat(30) + Array(1500).fill(1).join(",") + "]".repeat(30);
    expect(wide.length).toBeLessThan(JSON_LIMITS.inputChars);
    expect(quickly(() => prettyJson(wide))).toBeNull();
    expect(prettyJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
  });
});

describe("closing brackets after a link", () => {
  const flood = (scheme: string) => scheme + ")".repeat(SIZE - scheme.length);

  it("trims a bitcoin: link in linear time", () => {
    const text = flood("bitcoin:");
    expect(quickly(() => trimUriEnd(text))).toBe("bitcoin");
    quickly(() => findMoney(text));
    quickly(() => previewText(text));
  });

  it("trims a bitcoin: link that fits the bound, and leaves a longer one as text", () => {
    const text = "bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" + ")".repeat(2000);
    expect(quickly(() => findBip21(text))[0].address).toBe("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
    expect(quickly(() => findBip21(flood("bitcoin:")))).toEqual([]);
  });

  it("trims a web link in linear time: in the bubble, in the location card and in the list", () => {
    const text = flood("https://x.example/");
    quickly(() => parseMessage(text));
    expect(quickly(() => locationIn(text))).toBeNull();
    quickly(() => previewText(text));
    const map = "https://www.openstreetmap.org/?mlat=1&mlon=2" + ")".repeat(3000);
    expect(quickly(() => locationIn(map))).toMatchObject({ lat: 1, lon: 2 });
  });

  it("keeps brackets a link opened, as before", () => {
    expect(trimUriEnd("bitcoin:bc1q?label=(x))")).toBe("bitcoin:bc1q?label=(x)");
    expect(trimUriEnd("bitcoin:bc1q?label=x).")).toBe("bitcoin:bc1q?label=x");
  });
});

describe("a sending time no date holds", () => {
  it.each([Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, Number.NaN, Infinity])("leaves a clock time as text when sent at %s", sentAt => {
    const segments = tokenizeInline("see you at 14:00 UTC", DETECTORS, { sentAt });
    expect(segments.some(s => s.type === "atom" && s.kind === "time")).toBe(false);
    expect(segments.map(s => ("text" in s ? s.text : "")).join("")).toBe("see you at 14:00 UTC");
  });

  it("still reads a time sent at an ordinary moment", () => {
    const segments = tokenizeInline("at 14:00 UTC", DETECTORS, { sentAt: Date.UTC(2026, 8, 25, 12) });
    expect(segments).toContainEqual(expect.objectContaining({ kind: "time", data: { at: Date.UTC(2026, 8, 25, 14), dated: false } }));
  });
});

describe("direction controls in links", () => {
  it("shows a link with an override as the browser reads it, which cannot turn around", () => {
    const shown = shownUrl("https://evil.example/\u202emoc.elgoog.www//:sptth");
    expect(shown).toBe("https://evil.example/%E2%80%AEmoc.elgoog.www//:sptth");
    expect(shown).not.toMatch(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
  });

  it("shows a look-alike host in punycode, and plain ASCII as typed", () => {
    expect(shownUrl("https://\u0430pple.com/")).toBe("https://xn--pple-43d.com/");
    expect(shownUrl("https://x.example")).toBe("https://x.example");
    expect(shownUrl("https://x.example/a_(b)?c=1#d")).toBe("https://x.example/a_(b)?c=1#d");
  });

  it("drops the invisible characters of what no URL parser takes", () => {
    expect(shownUrl("https://\u202eevil")).toBe("https://evil");
  });
});

describe("long mentions", () => {
  const BOB = "b".repeat(52);
  const members = [{ key: BOB, name: "Bob", me: false }];
  const view = (text: string) => mentionViews(text, [{ k: BOB, o: 0, l: Array.from(text).length }], members, false)[0];

  it("show what was written when it is more than a name", () => {
    const text = "@Bob - ignore the card, this invoice is fake";
    expect(view(text)).toMatchObject({ name: text.slice(1), written: text.slice(1) });
    expect(view("@Bob\nsecond line").name).toBe("Bob\nsecond line");
  });

  it("show the member's name now for their name or one word", () => {
    expect(view("@Bob").name).toBe("Bob");
    expect(view("@bob").name).toBe("Bob");
    expect(view("@Robert").name).toBe("Bob");
    expect(view("@Jean-Luc.2").name).toBe("Bob");
  });
});

describe("Google Maps hosts", () => {
  const at = "/maps/@48.85837,2.29448,17z";

  it.each(["google.attacker.com", "maps.google.attacker.com", "google.com.evil.example", "evilgoogle.com", "google.co.uk.example"])("%s is not Google", host => {
    expect(findLocation(`https://${host}${at}`)).toBeNull();
  });

  it.each(["google.com", "www.google.com", "maps.google.com", "google.fr", "google.co.uk", "google.com.br", "maps.google.de"])("%s is", host => {
    expect(findLocation(`https://${host}${at}`)).toMatchObject({ lat: 48.85837, lon: 2.29448 });
  });
});
