import { bech32 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { findLightningDestination } from "../src/lnurl";
import { LINK_MAX_CHARS, linkEnd, linksIn, parseLinkPreview } from "../src/linkPreview";
import { MESSAGE_CLOCK_SKEW_MS, arrivalKey, claimedTime, heardTime, receivedTimestamp, shownTime } from "../src/messageTime";

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
  const MINUTE = 60_000, DAY = 86_400_000;

  it("keeps what the sender says only when a date can hold it", () => {
    expect(claimedTime(now + 2 * MINUTE)).toBe(now + 2 * MINUTE);
    expect(claimedTime(now - 3 * DAY)).toBe(now - 3 * DAY);
    for (const ts of [0, -1, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER, "1", undefined]) expect(claimedTime(ts)).toBeUndefined();
  });

  it("takes its place from this clock, past the last place given", () => {
    expect(arrivalKey(now)).toBe(now);
    expect(arrivalKey(now, now - MINUTE)).toBe(now);
    // Two in the same millisecond keep the order they came in.
    expect(arrivalKey(now, now)).toBe(now + 1);
    expect(arrivalKey(now, now + 7)).toBe(now + 8);
  });

  it("shows the sender's time, never later than when it came", () => {
    // The sender's clock is ahead by minutes, or by days: the time it came.
    expect(shownTime({ timestamp: now, sentAt: now + 2 * MINUTE })).toBe(now);
    expect(shownTime({ timestamp: now, sentAt: now + 3 * DAY })).toBe(now);
    // Behind (or the message waited on its way): what the sender said.
    expect(shownTime({ timestamp: now, sentAt: now - 2 * MINUTE })).toBe(now - 2 * MINUTE);
    expect(shownTime({ timestamp: now, sentAt: now - 3 * DAY })).toBe(now - 3 * DAY);
    // Mine, and a row from before the claim was kept: its own time.
    expect(shownTime({ timestamp: now })).toBe(now);
  });

  it("a group's history line is kept at its commit's time, a few minutes ahead of this clock at most", () => {
    expect(receivedTimestamp(now - 60_000, now)).toBe(now - 60_000);
    expect(receivedTimestamp(now + MESSAGE_CLOCK_SKEW_MS + 1, now)).toBe(now + MESSAGE_CLOCK_SKEW_MS);
    expect(receivedTimestamp(Number.MAX_SAFE_INTEGER, now)).toBe(now + MESSAGE_CLOCK_SKEW_MS);
    for (const ts of [0, -1, Number.NaN, Infinity]) expect(receivedTimestamp(ts, now)).toBe(now);
  });

  it("dates an edit now at the latest, and now when its time is no time", () => {
    expect(heardTime(now - MINUTE, now)).toBe(now - MINUTE);
    expect(heardTime(now + MINUTE, now)).toBe(now);
    for (const ts of [0, -1, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER]) expect(heardTime(ts, now)).toBe(now);
  });
});
