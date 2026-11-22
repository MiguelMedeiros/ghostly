/** "3 min ago", "2 h ago", "5 d ago", or the date. */
export function ago(seconds: number, now = Date.now() / 1000): string {
  const d = Math.max(0, now - seconds);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86_400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 30 * 86_400) return `${Math.floor(d / 86_400)} d ago`;
  return new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

import { languageTag } from "./documentLanguage";
import type { Language } from "./settings";

/** A formatter, and whether it writes a plain space between a time and its day period ("9:41 م", "오후 9:41") that a line may break at. */
type Held = { format: Intl.DateTimeFormat; loose: boolean };

const CLOCK = new Set<string>(["hour", "minute", "second", "fractionalSecond"]);

/** Whether the literal at `i` stands between the time's digits and its day period (not between "PM" and a zone's "UTC"). */
const besideDayPeriod = (parts: Intl.DateTimeFormatPart[], i: number) =>
  (parts[i - 1]?.type === "dayPeriod" && CLOCK.has(parts[i + 1]?.type ?? "")) || (parts[i + 1]?.type === "dayPeriod" && CLOCK.has(parts[i - 1]?.type ?? ""));

function hold(format: Intl.DateTimeFormat): Held {
  const parts = format.formatToParts(0);
  return { format, loose: parts.some((p, i) => p.type === "literal" && p.value.includes(" ") && besideDayPeriod(parts, i)) };
}

/**
 * The time written by `held`, its day period kept on the time's line: Arabic puts a plain space between them where
 * English gets a narrow no-break one, so a wrapped line could end in "9:41" and start the next with "م".
 */
function written({ format, loose }: Held, at: number): string {
  if (!loose) return format.format(at);
  const parts = format.formatToParts(at);
  return parts.map((p, i) => (p.type === "literal" && besideDayPeriod(parts, i) ? p.value.replace(/ /g, "\u00a0") : p.value)).join("");
}

const clocks = new Map<string, Held>();

/**
 * A time of day ("14:05", "2:05 PM", "٢:٠٥ م") in the app's language when one is given, else as this device writes it,
 * with one formatter per language for all: each `toLocaleTimeString` call builds its own, and a long chat has thousands.
 */
export function clockTime(at: number, language?: Language): string {
  const locale = language ? languageTag(language) : [];
  // No date holds it (a peer can send any number): "Invalid Date" as before, where the formatter would throw.
  if (!(Math.abs(at) <= 8.64e15)) return new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const key = language ? languageTag(language) : "";
  let clock = clocks.get(key);
  if (!clock) { clock = hold(new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" })); clocks.set(key, clock); }
  return written(clock, at);
}

const formats = new Map<string, Held>();

/**
 * A date or time written with `options` in the app's language when one is given, else as this device writes it (the
 * chat's Tech Info, its connection panel and history), with one formatter per language and options.
 */
export function formatAt(at: number, options: Intl.DateTimeFormatOptions, language?: Language): string {
  const locale = language ? languageTag(language) : [];
  if (!(Math.abs(at) <= 8.64e15)) return new Date(at).toLocaleString(locale, options);
  const key = `${language ? languageTag(language) : ""} ${JSON.stringify(options)}`;
  let format = formats.get(key);
  if (!format) { format = hold(new Intl.DateTimeFormat(locale, options)); formats.set(key, format); }
  return written(format, at);
}
