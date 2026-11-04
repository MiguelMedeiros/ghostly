import type { Translate } from "../locales/translate";
import { sharedRows } from "./chatRows";
import type { Language } from "./settings";
import { formatAt } from "./time";

/** The local midnight starting the day `at` is on. */
export function dayOf(at: number): number {
  return new Date(at).setHours(0, 0, 0, 0);
}

/** The local midnight of the day after the one starting at `day` (a day of 23 or 25 hours where the clocks change). */
export function nextDay(day: number): number {
  const date = new Date(day);
  return date.setDate(date.getDate() + 1);
}

/**
 * The day each row of a timeline goes under, by its time (`NaN` for none: rows before any dated one). Never a day before
 * the row above's: a row dated earlier than the day it follows (a member's clock behind, a late catch-up) stays in that
 * day, so the rows keep their order and each day has one label. The last day is kept as its two midnights: a history
 * comes in time order, so a Date is made once a day, not once a row (local time is slow).
 */
export function rowDays(times: readonly number[]): number[] {
  return daysOn([], times.length, i => times[i]!);
}

/**
 * `rowDays` for one chat's rows as its list changes, each row's time by `timeOf`: a row's day comes from the rows above
 * it, so the days of the rows a new list has the same from its start are the ones found before, and only the rest are
 * found. A new array for each new list; it is never changed once given.
 */
export function rowDaysReader<R>(timeOf: (row: R) => number): (rows: readonly R[]) => readonly number[] {
  let list: readonly R[] = [];
  let days: readonly number[] = [];
  return rows => {
    if (rows === list) return days;
    const same = sharedRows(list, rows);
    days = daysOn(days.slice(0, same), rows.length, i => timeOf(rows[i]!));
    list = rows;
    return days;
  };
}

/** `days`, the days of the first rows, with those of the rest up to `count`, each row's time by `timeAt`. */
function daysOn(days: number[], count: number, timeAt: (i: number) => number): number[] {
  let day = days.length ? days[days.length - 1]! : NaN, from = 0, to = -1;
  for (let i = days.length; i < count; i++) {
    const at = timeAt(i);
    if (Number.isFinite(at) && at > 0 && !(at < day)) {
      if (at < from || at >= to) {
        from = dayOf(at);
        to = nextDay(from);
      }
      day = from;
    }
    days.push(day);
  }
  return days;
}

/** The rows of a timeline's page (`rows`, from its row `from` on) in runs of one day, each with its day from `days`. */
export function byDay<R>(rows: readonly R[], days: readonly number[], from = 0): { day: number; rows: R[] }[] {
  const out: { day: number; rows: R[] }[] = [];
  rows.forEach((row, i) => {
    const day = days[from + i];
    const last = out[out.length - 1];
    if (last && (last.day === day || (Number.isNaN(last.day) && Number.isNaN(day)))) last.rows.push(row);
    else out.push({ day, rows: [row] });
  });
  return out;
}

/**
 * How a day of a chat is named above its messages: Today, Yesterday, else its weekday and date, with the year when it is
 * not this year's, in the interface's language. One formatter per language and year or none: a chat with a message a day
 * has a hundred days in its page, named again on each render.
 */
export function dayLabel(day: number, today: number, language: Language, t: Translate): string {
  if (day === today) return t("chat.today");
  const yesterday = new Date(today);
  if (day === yesterday.setDate(yesterday.getDate() - 1)) return t("chat.yesterday");
  const year = new Date(day).getFullYear() !== new Date(today).getFullYear();
  return formatAt(day, { weekday: "long", day: "numeric", month: "long", ...(year && { year: "numeric" }) }, language);
}
