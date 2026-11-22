/**
 * `text` with its no-break spaces (U+00A0, U+202F) as plain ones, for tests that compare a time and not its spaces: the
 * space before English's "PM" is a plain one the app holds with U+00A0 where the runtime's `formatToParts` reports a plain
 * space (Node 26), while older V8 (Node 20-24) reports U+202F in its parts but writes a plain one from
 * `format`/`toLocaleTimeString`, so neither text is the same everywhere.
 */
export const plainSpaces = (text: string) => text.replace(/[\u00a0\u202f]/g, " ");

const CLOCK = new Set<string>(["hour", "minute", "second", "fractionalSecond"]);

/** Whether `format`'s parts put a plain space between a time's digits and its day period, the space lib/time.ts holds. */
export function plainBeforeDayPeriod(format: Intl.DateTimeFormat, at: number): boolean {
  const parts = format.formatToParts(at);
  return parts.some((p, i) => p.type === "literal" && p.value.includes(" ") &&
    ((parts[i - 1]?.type === "dayPeriod" && CLOCK.has(parts[i + 1]?.type ?? "")) || (parts[i + 1]?.type === "dayPeriod" && CLOCK.has(parts[i - 1]?.type ?? ""))));
}
