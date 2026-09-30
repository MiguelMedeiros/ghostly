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

const clocks = new Map<string, Intl.DateTimeFormat>();

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
  if (!clock) { clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }); clocks.set(key, clock); }
  return clock.format(at);
}

const formats = new Map<string, Intl.DateTimeFormat>();

/**
 * A date or time written with `options` in the app's language when one is given, else as this device writes it (the
 * chat's Tech Info, its connection panel and history), with one formatter per language and options.
 */
export function formatAt(at: number, options: Intl.DateTimeFormatOptions, language?: Language): string {
  const locale = language ? languageTag(language) : [];
  if (!(Math.abs(at) <= 8.64e15)) return new Date(at).toLocaleString(locale, options);
  const key = `${language ? languageTag(language) : ""} ${JSON.stringify(options)}`;
  let format = formats.get(key);
  if (!format) { format = new Intl.DateTimeFormat(locale, options); formats.set(key, format); }
  return format.format(at);
}
