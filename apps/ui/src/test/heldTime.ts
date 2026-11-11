const CLOCK = new Set<string>(["hour", "minute", "second", "fractionalSecond"]);

/**
 * `format`'s text for `at` as the app writes it (lib/time.ts): a plain space between a time's digits and its day period
 * becomes a no-break one. ICU 72-77 gives English a narrow no-break space there already, ICU 78 a plain one and Arabic
 * always a plain one, so a test that expects raw `toLocaleTimeString` text passes or fails with the ICU it runs on.
 */
export function heldTime(format: Intl.DateTimeFormat, at: number): string {
  const parts = format.formatToParts(at);
  const beside = (i: number) =>
    (parts[i - 1]?.type === "dayPeriod" && CLOCK.has(parts[i + 1]?.type ?? "")) || (parts[i + 1]?.type === "dayPeriod" && CLOCK.has(parts[i - 1]?.type ?? ""));
  return parts.map((p, i) => (p.type === "literal" && beside(i) ? p.value.replace(/ /g, "\u00a0") : p.value)).join("");
}
