import { bech32 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { findLightningDestination } from "../src/lnurl";
import { LINK_MAX_CHARS, linkEnd, linksIn, parseLinkPreview } from "../src/linkPreview";
import { MESSAGE_CLOCK_SKEW_MS, receivedTimestamp } from "../src/messageTime";

// covers: chat.link-preview.wire, wallet.lnurl.protocol, chats.list.rows

/*
 * What a peer can put in a message, at the size a group message allows (16 KiB), against the text helpers the engine
 * runs on every message it receives. The bound is loose enough for a busy CI runner and far below the seconds the
 * old quadratic trims took.
 */
const BOUND_MS = 100;
const SIZE = 16 * 1024;
const LNURL = bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode("https://ln.example.com/lnurlp/alice")), 2048);

function quickly<T>(work: () => T): T {
  const start = performance.now();
  const out = work();
  expect(performance.now() - start).toBeLessThan(BOUND_MS);
  return out;
}

describe("closing brackets after a link", () => {
  it("are trimmed in linear time", () => {
    const text = "https://x.example/" + ")".repeat(SIZE);
    expect(quickly(() => linkEnd(text))).toBe("https://x.example/");
    expect(quickly(() => linksIn(text))).toEqual([]);
    quickly(() => parseLinkPreview({ u: "https://x.example/", t: "t" }, text));
  });

  it("that the link opened stay, and the sentence's do not", () => {
    expect(linkEnd("https://en.wikipedia.org/wiki/Tor_(network))")).toBe("https://en.wikipedia.org/wiki/Tor_(network)");
    expect(linkEnd("https://x.example/a].")).toBe("https://x.example/a");
    expect(linkEnd("https://x.example/{a}")).toBe("https://x.example/{a}");
  });

  it("past the bound leave the link as text", () => {
    const long = "https://x.example/" + "a".repeat(LINK_MAX_CHARS);
    expect(linksIn(`${long} https://y.example/`)).toEqual(["https://y.example/"]);
  });

  it("after an LNURL are trimmed in linear time", () => {
    const text = LNURL + ")".repeat(SIZE) + "x";
    expect(quickly(() => findLightningDestination(text))).toBeNull();
    expect(findLightningDestination(`pay ${LNURL}).`)?.destination).toMatchObject({ kind: "lnurl", url: "https://ln.example.com/lnurlp/alice" });
  });
});

describe("a received message's time", () => {
  const now = Date.UTC(2026, 8, 26, 12);

  it("is kept as sent up to a few minutes ahead of this clock", () => {
    expect(receivedTimestamp(now - 60_000, now)).toBe(now - 60_000);
    expect(receivedTimestamp(now + MESSAGE_CLOCK_SKEW_MS, now)).toBe(now + MESSAGE_CLOCK_SKEW_MS);
  });

  it("is taken as the moment of receipt at the latest", () => {
    expect(receivedTimestamp(Number.MAX_SAFE_INTEGER, now)).toBe(now + MESSAGE_CLOCK_SKEW_MS);
    expect(receivedTimestamp(now + MESSAGE_CLOCK_SKEW_MS + 1, now)).toBe(now + MESSAGE_CLOCK_SKEW_MS);
  });

  it("is now when it is not a positive number", () => {
    for (const ts of [0, -1, Number.NaN, Infinity]) expect(receivedTimestamp(ts, now)).toBe(now);
  });
});
