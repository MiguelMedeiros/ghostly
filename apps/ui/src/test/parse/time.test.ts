import { describe, expect, it } from "vitest";
import { DETECTORS, tokenizeInline, type Atom, type TimeData } from "../../lib/parse";

// covers: chat.rich.time

/** Sent on 2026-09-25 at 12:00 UTC. */
const SENT = Date.UTC(2026, 8, 25, 12);
const times = (text: string, sentAt = SENT) =>
  tokenizeInline(text, DETECTORS, { sentAt }).filter((s): s is Atom<"time", TimeData> => s.type === "atom" && s.kind === "time");
const one = (text: string, sentAt = SENT) => {
  const found = times(text, sentAt);
  expect(found).toHaveLength(1);
  return found[0];
};

describe("times with a zone", () => {
  it.each([
    ["2026-09-25T14:00:00Z", Date.UTC(2026, 8, 25, 14)],
    ["2026-09-25T14:00Z", Date.UTC(2026, 8, 25, 14)],
    ["2026-09-25T14:00:00.123Z", Date.UTC(2026, 8, 25, 14)],
    ["2026-09-25 14:00 UTC", Date.UTC(2026, 8, 25, 14)],
    ["2026-09-25T14:00:00+02:00", Date.UTC(2026, 8, 25, 12)],
    ["2026-09-25T14:00-0300", Date.UTC(2026, 8, 25, 17)],
  ])("reads the ISO timestamp %s", (text, at) => {
    const atom = one(`deploy at ${text}.`);
    expect(atom.text).toBe(text);
    expect(atom.data).toEqual({ at, dated: true });
  });

  it.each([
    ["at 14:00 UTC", "14:00 UTC", Date.UTC(2026, 8, 25, 14)],
    ["call at 9:30 GMT", "9:30 GMT", Date.UTC(2026, 8, 25, 9, 30)],
    ["3pm UTC", "3pm UTC", Date.UTC(2026, 8, 25, 15)],
    ["3 p.m. GMT", "3 p.m. GMT", Date.UTC(2026, 8, 25, 15)],
    ["12am UTC", "12am UTC", Date.UTC(2026, 8, 25, 0)],
    ["at 14:00 UTC+2", "14:00 UTC+2", Date.UTC(2026, 8, 25, 12)],
    ["at 10:00 GMT-03:00", "10:00 GMT-03:00", Date.UTC(2026, 8, 25, 13)],
    ["9:30 am EST", "9:30 am EST", Date.UTC(2026, 8, 25, 14, 30)],
    ["18:00 CEST", "18:00 CEST", Date.UTC(2026, 8, 25, 16)],
    ["10:00 BRT", "10:00 BRT", Date.UTC(2026, 8, 25, 13)],
    ["at 14:00 utc", "14:00 utc", Date.UTC(2026, 8, 25, 14)],
  ])("reads %s as that day's time where it was written", (text, written, at) => {
    const atom = one(text);
    expect(atom.text).toBe(written);
    expect(atom.data).toEqual({ at, dated: false });
  });

  it("takes the day where the zone is, not the reader's", () => {
    // 23:30 UTC on the 25th is already the 26th in Tokyo: "09:00 JST" is the 26th's.
    expect(one("09:00 JST", Date.UTC(2026, 8, 25, 23, 30)).data.at).toBe(Date.UTC(2026, 8, 26, 0));
  });
});

describe("no false positives", () => {
  it.each([
    "at 14:00",
    "the score was 3:2 UTC",
    "5 UTC",
    "v1.14:00 UTC",
    "12:00:00:00 UTC",
    "1400 UTC",
    "25:00 UTC",
    "13pm UTC",
    "14:61 UTC",
    "14:00 CST",
    "14:00 IST",
    "14:00 UTC+25",
    "3pm estimate",
    "2026-02-30T10:00Z",
    "2026-13-01T10:00Z",
    "2026-09-25T14:00",
    "2026-09-25",
    "call me 555-14:00",
    "ratio 16:9",
    "1:00 2:00 3:00",
  ])("%s", (text) => expect(times(text)).toEqual([]));
});
