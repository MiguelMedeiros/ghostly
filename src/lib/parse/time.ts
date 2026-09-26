import type { Detector } from "./types";

/**
 * Times the reader may want in their own zone: an ISO timestamp with its offset ("2026-09-25T14:00:00Z",
 * "2026-09-25 14:00 +02:00") and a clock time with a named zone ("at 14:00 UTC", "3pm GMT+2", "9:30 am EST").
 * Conservative on purpose: a time with no zone, a bare number, a score ("3:2") or a version ("v1.14:00") is text.
 * A clock time with no date means that day where the message was written, the day it was sent.
 */

/** Zone abbreviations read the same way everywhere (no CST, IST or BST, which name several zones). Minutes east of UTC. */
const ZONES: Record<string, number> = {
  UTC: 0, GMT: 0, Z: 0,
  EST: -300, EDT: -240, MST: -420, MDT: -360, PST: -480, PDT: -420,
  CET: 60, CEST: 120, EET: 120, EEST: 180, BRT: -180, JST: 540, AEST: 600, AEDT: 660,
};
const NAMED = "UTC|GMT|EST|EDT|MST|MDT|PST|PDT|CET|CEST|EET|EEST|BRT|JST|AEST|AEDT";
const OFFSET = "[+-]\\d{1,2}(?::?\\d{2})?";

const ISO = `(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.\\d{1,9})?)?\\s?(Z|UTC|GMT|[+-]\\d{2}:?\\d{2})`;
const CLOCK = `(\\d{1,2})(?::(\\d{2}))?\\s?(?:([ap])\\.?m\\b\\.?)?\\s?(?:(UTC|GMT)(${OFFSET})?|(${NAMED}))`;

export interface TimeData {
  /** The moment written, in ms since the epoch. */
  at: number;
  /** Whether the text carried its date; a clock time alone takes the day it was sent. */
  dated: boolean;
}

/** Minutes east of UTC for "+02:00", "-3", "+0530"; null past ±14 h. */
function offsetMinutes(offset: string): number | null {
  const m = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(offset);
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  if (Number(m[2]) > 14 || Number(m[3] ?? 0) > 59) return null;
  return m[1] === "-" ? -minutes : minutes;
}

export const time: Detector<"time", TimeData> = {
  kind: "time",
  // Not after a word, a digit, a colon, a dot or a slash, and not before one: "v1.14:00 UTC" and "12:00:00:00" stay text.
  pattern: new RegExp(`(?<![\\w:./+-])(?:${ISO}|${CLOCK})(?![\\w:+-])`, "gi"),
  accept(m, _text, ctx) {
    if (m[1] !== undefined) {
      const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
      const zone = m[7].toUpperCase();
      const offset = zone in ZONES ? ZONES[zone] : offsetMinutes(zone);
      if (offset === null || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
      const at = Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60_000;
      // February 30th rolls over into March: not a date anyone wrote.
      if (new Date(at + offset * 60_000).getUTCDate() !== day) return null;
      return { data: { at, dated: true } };
    }
    let hour = Number(m[8]);
    const minute = m[9] === undefined ? 0 : Number(m[9]);
    const meridiem = m[10]?.toLowerCase();
    // A bare hour needs am/pm: "5 UTC" could be anything.
    if (m[9] === undefined && !meridiem) return null;
    if (minute > 59) return null;
    if (meridiem) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
    } else if (hour > 23) return null;
    const offset = m[13] ? ZONES[m[13].toUpperCase()] : m[12] ? offsetMinutes(m[12]) : 0;
    if (offset === null || offset === undefined) return null;
    // The day it was where the message was written.
    const there = new Date((ctx.sentAt ?? Date.now()) + offset * 60_000);
    const at = Date.UTC(there.getUTCFullYear(), there.getUTCMonth(), there.getUTCDate(), hour, minute) - offset * 60_000;
    return { data: { at, dated: false } };
  },
};
