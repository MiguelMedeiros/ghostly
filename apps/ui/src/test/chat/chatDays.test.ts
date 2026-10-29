import { describe, expect, it } from "vitest";
import { byDay, dayLabel, dayOf, rowDays } from "../../lib/chatDays";
import { translateWith } from "../../locales/translate";
import en from "../../locales/en";

// covers: chat.days

/** A chat's days, in local time (whatever zone the run is in): the day of a row is the reader's, not UTC's. */

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const t = translateWith(en, "en");

describe("the day each row goes under", () => {
  it("is the local day of its time, the same day for every row of it", () => {
    const days = rowDays([at(2026, 10, 27, 0, 0), at(2026, 10, 27, 23, 59), at(2026, 10, 28, 0, 0), at(2026, 10, 29, 9)]);
    expect(days).toEqual([dayOf(at(2026, 10, 27)), dayOf(at(2026, 10, 27)), dayOf(at(2026, 10, 28)), dayOf(at(2026, 10, 29))]);
    expect(new Date(days[0]).getHours()).toBe(0);
  });

  it("is never a day before the row above's: a row dated earlier stays in the day it follows", () => {
    // A member's clock a few minutes behind, just after midnight: no second "Yesterday" under "Today".
    const days = rowDays([at(2026, 10, 28, 23, 50), at(2026, 10, 29, 0, 5), at(2026, 10, 28, 23, 58), at(2026, 10, 29, 0, 10)]);
    expect(days).toEqual([dayOf(at(2026, 10, 28)), dayOf(at(2026, 10, 29)), dayOf(at(2026, 10, 29)), dayOf(at(2026, 10, 29))]);
  });

  it("is the day above for a row with no time, and none before any dated row", () => {
    const days = rowDays([0, NaN, at(2026, 10, 29), NaN]);
    expect(days.slice(0, 2)).toEqual([NaN, NaN]);
    expect(days.slice(2)).toEqual([dayOf(at(2026, 10, 29)), dayOf(at(2026, 10, 29))]);
  });
});

describe("a page of rows by day", () => {
  it("is one run per day, read from where the page starts in the timeline", () => {
    const days = rowDays([at(2026, 10, 27), at(2026, 10, 28), at(2026, 10, 28, 13), at(2026, 10, 29)]);
    expect(byDay(["b", "c", "d"], days, 1)).toEqual([
      { day: dayOf(at(2026, 10, 28)), rows: ["b", "c"] },
      { day: dayOf(at(2026, 10, 29)), rows: ["d"] },
    ]);
    expect(byDay([], days)).toEqual([]);
    expect(byDay(["x", "y"], [NaN, NaN])).toEqual([{ day: NaN, rows: ["x", "y"] }]);
  });
});

describe("a day's name", () => {
  const today = dayOf(at(2026, 10, 29));

  it("is Today and Yesterday for the last two days, in the interface's language", () => {
    expect(dayLabel(today, today, "en", t)).toBe("Today");
    expect(dayLabel(dayOf(at(2026, 10, 28)), today, "en", t)).toBe("Yesterday");
    // Over a month's end and a year's.
    expect(dayLabel(dayOf(at(2026, 10, 31)), dayOf(at(2026, 11, 1)), "en", t)).toBe("Yesterday");
    expect(dayLabel(dayOf(at(2026, 12, 31)), dayOf(at(2027, 1, 1)), "en", t)).toBe("Yesterday");
  });

  it("is the weekday and date before that, with the year when it is not this year's", () => {
    expect(dayLabel(dayOf(at(2026, 10, 27)), today, "en", t)).toBe("Tuesday, October 27");
    expect(dayLabel(dayOf(at(2026, 9, 27)), today, "en", t)).toBe("Sunday, September 27");
    expect(dayLabel(dayOf(at(2025, 10, 27)), today, "en", t)).toBe("Monday, October 27, 2025");
    // Two days before the 1st of January: last year's, so said with it.
    expect(dayLabel(dayOf(at(2026, 12, 30)), dayOf(at(2027, 1, 1)), "en", t)).toBe("Wednesday, December 30, 2026");
  });

  it("is said in the interface's language", () => {
    expect(dayLabel(dayOf(at(2026, 10, 27)), today, "pt", t)).toBe("terça-feira, 27 de outubro");
  });
});
