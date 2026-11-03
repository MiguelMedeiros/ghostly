import { describe, expect, it } from "vitest";
import { KNOWN_SESSION_CAPABILITIES, PIN_CAPABILITY, SessionCapabilities, TIMER_CAPABILITY } from "../src/pairedCapabilities";
import { PIN_CLOCK_SKEW_MS, PIN_LIMITS } from "../src/pins";
import {
  TIMED_FRAME, TIMER_CHOICES, TIMER_FRAME, TIMER_LIMITS, effectiveTtl, nextTimerNumber, parseTimedFrame, parseTimerFrame, readTimer, readTtl, timedFrame,
  timerFrame, timerIsNewer, type WireTimer,
} from "../src/pairedTimer";

const DAY = 86_400;

describe("timer frames", () => {
  it("encodes and decodes a setting, turning it off and a receipt", () => {
    const frame = timerFrame({ s: DAY, n: 5 });
    expect(frame).toBe('{"t":"paired-timer","s":86400,"n":5}');
    expect(parseTimerFrame(JSON.parse(frame))).toEqual({ s: DAY, n: 5 });
    expect(parseTimerFrame({ t: TIMER_FRAME, s: 0, n: 6 })).toEqual({ s: 0, n: 6 });
    expect(timedFrame(5)).toBe('{"t":"paired-timered","n":5}');
    expect(parseTimedFrame(JSON.parse(timedFrame(5)))).toBe(5);
  });

  it("takes any whole number of seconds from a minute to a year on the wire, not only the choices offered", () => {
    for (const s of [60, 61, 3_600, 90_000, TIMER_LIMITS.maxS]) expect(readTimer({ s, n: 1 }), String(s)).toEqual({ s, n: 1 });
    expect(TIMER_LIMITS.minS).toBe(60);
    expect(TIMER_LIMITS.maxS).toBe(31_536_000);
  });

  it("refuses a malformed setting or receipt", () => {
    for (const bad of [
      { t: TIMER_FRAME, s: 59, n: 1 }, { t: TIMER_FRAME, s: 1, n: 1 }, { t: TIMER_FRAME, s: -60, n: 1 }, { t: TIMER_FRAME, s: 31_536_001, n: 1 },
      { t: TIMER_FRAME, s: 60.5, n: 1 }, { t: TIMER_FRAME, s: "3600", n: 1 }, { t: TIMER_FRAME, s: null, n: 1 }, { t: TIMER_FRAME, n: 1 },
      { t: TIMER_FRAME, s: Number.NaN, n: 1 }, { t: TIMER_FRAME, s: Infinity, n: 1 },
      { t: TIMER_FRAME, s: DAY, n: 0 }, { t: TIMER_FRAME, s: DAY, n: 1.5 }, { t: TIMER_FRAME, s: DAY, n: "1" }, { t: TIMER_FRAME, s: DAY },
      { t: "paired-pin", s: DAY, n: 1 },
    ]) expect(parseTimerFrame(bad as Record<string, unknown>), JSON.stringify(bad)).toBeNull();
    for (const bad of [{ t: TIMED_FRAME }, { t: TIMED_FRAME, n: -1 }, { t: TIMED_FRAME, n: 1.5 }, { t: "paired-pinned", n: 1 }]) expect(parseTimedFrame(bad)).toBeNull();
    expect(readTimer([DAY, 1])).toBeNull();
    expect(readTimer(null)).toBeNull();
  });

  it("writes only the wire fields, in a fixed order", () => {
    expect(timerFrame({ s: 0, n: 7, by: "me" } as WireTimer)).toBe('{"t":"paired-timer","s":0,"n":7}');
  });
});

describe("the choices a person picks from", () => {
  it("are Off, 1 hour, 1 day, 1 week and 4 weeks, each one the wire takes", () => {
    expect(TIMER_CHOICES).toEqual([0, 3_600, DAY, 7 * DAY, 28 * DAY]);
    for (const s of TIMER_CHOICES) expect(readTimer({ s, n: 1 })).toEqual({ s, n: 1 });
  });
});

describe("the last setting wins", () => {
  it("by number, whatever order the settings arrive in, and the same on every side", () => {
    const settings: WireTimer[] = [{ s: DAY, n: 10 }, { s: 0, n: 30 }, { s: 3_600, n: 20 }];
    const settle = (order: WireTimer[]) => order.reduce<WireTimer | undefined>((kept, t) => timerIsNewer(kept, t) ? t : kept, undefined);
    expect(settle(settings)).toEqual({ s: 0, n: 30 });
    expect(settle([...settings].reverse())).toEqual({ s: 0, n: 30 });
    // A late copy of the setting kept changes nothing.
    expect(timerIsNewer({ s: DAY, n: 5 }, { s: DAY, n: 5 })).toBe(false);
  });

  it("two sides at the same millisecond end on the shorter timer, off counting as the longest", () => {
    const settle = (order: WireTimer[]) => order.reduce<WireTimer | undefined>((kept, t) => timerIsNewer(kept, t) ? t : kept, undefined);
    expect(settle([{ s: DAY, n: 5 }, { s: 3_600, n: 5 }])).toEqual({ s: 3_600, n: 5 });
    expect(settle([{ s: 3_600, n: 5 }, { s: DAY, n: 5 }])).toEqual({ s: 3_600, n: 5 });
    expect(settle([{ s: 0, n: 5 }, { s: 28 * DAY, n: 5 }])).toEqual({ s: 28 * DAY, n: 5 });
    expect(settle([{ s: 28 * DAY, n: 5 }, { s: 0, n: 5 }])).toEqual({ s: 28 * DAY, n: 5 });
  });

  it("a new setting goes past the one kept, even when the clock is behind it", () => {
    expect(nextTimerNumber(0, 1_000)).toBe(1_000);
    expect(nextTimerNumber(5_000, 1_000)).toBe(5_001);
    expect(timerIsNewer({ s: DAY, n: 5_000 }, { s: 0, n: nextTimerNumber(5_000, 1_000) })).toBe(true);
  });
});

describe("a setting numbered far ahead of the clock", () => {
  const now = 1_790_000_000_000;

  it("is refused, so nobody is left without a higher number to change it with", () => {
    expect(readTimer({ s: DAY, n: Number.MAX_SAFE_INTEGER }, now)).toBeNull();
    expect(parseTimerFrame({ t: TIMER_FRAME, s: DAY, n: Number.MAX_SAFE_INTEGER })).toBeNull();
    expect(readTimer({ s: DAY, n: now + PIN_CLOCK_SKEW_MS + 1 }, now)).toBeNull();
    // Clocks drift: a number a few minutes ahead is taken, the same bound as a pin's.
    expect(readTimer({ s: DAY, n: now + PIN_CLOCK_SKEW_MS }, now)).toEqual({ s: DAY, n: now + PIN_CLOCK_SKEW_MS });
    expect(parseTimerFrame({ t: TIMER_FRAME, s: DAY, n: now + 7 * 60_000 }, now)).toEqual({ s: DAY, n: now + 7 * 60_000 });
  });

  it("kept before receivers checked it, counts as none: any setting replaces it, and the next number is the clock", () => {
    const frozen: WireTimer = { s: DAY, n: Number.MAX_SAFE_INTEGER };
    const off: WireTimer = { s: 0, n: nextTimerNumber(frozen.n, now) };
    expect(off.n).toBe(now);
    expect(timerIsNewer(frozen, off, now)).toBe(true);
    expect(readTimer(off, now)).toEqual(off);
    expect(timerIsNewer(off, { s: 3_600, n: nextTimerNumber(off.n, now) }, now)).toBe(true);
  });

  it("the next number never passes the largest safe integer", () => {
    expect(nextTimerNumber(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(nextTimerNumber(2 ** 53, now))).toBe(true);
  });
});

describe("a message's ttl", () => {
  it("is taken on a text, a file's announcement and a held item's meta when it is a whole number of seconds from a minute to a year", () => {
    expect(readTtl({ t: "paired-message", id: "AAAAAAAAAAAAAAAAAAAAAA", ts: 1, m: "hi", ttl: DAY })).toBe(DAY);
    expect(readTtl({ t: "pf-offer", id: "f", name: "a.txt", size: 1, ttl: 3_600 })).toBe(3_600);
    expect(readTtl({ t: "pf-start", id: "f", ttl: 60 })).toBe(60);
    expect(readTtl({ kind: "text", ttl: 31_536_000 })).toBe(31_536_000);
  });

  it("is dropped when it is anything else, and the message is kept: it then takes the reader's own setting", () => {
    for (const ttl of [0, 59, 31_536_001, -60, 60.5, "3600", null, true, Number.NaN, Infinity, [60], { s: 60 }]) {
      expect(readTtl({ t: "paired-message", ttl }), JSON.stringify(ttl)).toBeUndefined();
    }
    expect(readTtl({ t: "paired-message" })).toBeUndefined();
    expect(readTtl(null)).toBeUndefined();
    expect(readTtl("ttl")).toBeUndefined();
    expect(readTtl([DAY])).toBeUndefined();
  });

  it("the reader applies the shorter of the message's ttl and its own setting", () => {
    expect(effectiveTtl(DAY, 3_600)).toBe(3_600);
    expect(effectiveTtl(3_600, DAY)).toBe(3_600);
    // The reader's timer off: the sender's ttl still asks.
    expect(effectiveTtl(DAY, 0)).toBe(DAY);
    // No ttl (an older app, the DHT floor, one dropped as malformed): the reader's own setting.
    expect(effectiveTtl(undefined, DAY)).toBe(DAY);
    expect(effectiveTtl(undefined, 0)).toBeUndefined();
  });
});

describe("timer/1", () => {
  it("is a session capability this app knows, kept apart from pin/1", () => {
    expect(TIMER_CAPABILITY).toBe("timer/1");
    expect(KNOWN_SESSION_CAPABILITIES).toContain(TIMER_CAPABILITY);
    expect(TIMER_CAPABILITY).not.toBe(PIN_CAPABILITY);
  });

  it("is on only while both sides list it", () => {
    const caps = new SessionCapabilities(() => [TIMER_CAPABILITY]);
    expect(caps.agreed(TIMER_CAPABILITY)).toBe(false);
    expect(caps.receive({ t: "paired-capabilities", c: [TIMER_CAPABILITY] })).toEqual([TIMER_CAPABILITY]);
    expect(caps.agreed(TIMER_CAPABILITY)).toBe(true);
    // A side that does not offer it never agrees it, whatever the peer lists.
    const older = new SessionCapabilities(() => [PIN_CAPABILITY]);
    expect(older.receive({ t: "paired-capabilities", c: [TIMER_CAPABILITY, PIN_CAPABILITY] })).toEqual([PIN_CAPABILITY]);
    expect(older.agreed(TIMER_CAPABILITY)).toBe(false);
  });

  it("keeps a pin's limits for its frames", () => {
    expect(TIMER_LIMITS.receive).toBe(PIN_LIMITS.receive);
    expect(TIMER_LIMITS.windowMs).toBe(PIN_LIMITS.windowMs);
    expect(TIMER_LIMITS.resendMs).toBe(PIN_LIMITS.resendMs);
  });

  it("holds the design's numbers for the sweep: unread at most 4 weeks, swept ids 8 days and 10,000 per chat", () => {
    expect(TIMER_LIMITS.unreadMaxS).toBe(28 * DAY);
    expect(TIMER_LIMITS.sweptKeepMs).toBe(8 * DAY * 1000);
    expect(TIMER_LIMITS.sweptPerChat).toBe(10_000);
  });
});
