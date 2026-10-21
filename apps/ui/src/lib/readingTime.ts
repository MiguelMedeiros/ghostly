import type { Language } from "./settings";

/**
 * How many characters a minute an adult reads silently, by language (IReST, Trauzettel-Klosinski et al. 2012; spaces
 * not counted). Japanese and Chinese are read about three times slower per character than English.
 */
const PER_MINUTE: Record<Language, number> = { en: 987, pt: 913, es: 1025, fr: 998, it: 950, ja: 357, zh: 255, ar: 612 };

/** Seen before it is read: a card comes up away from where the eyes are (above the composer, after a picker closed). */
const NOTICE_MS = 2_000;

/** How long a line takes to notice and read in `language`, and never less than `least`. */
export function readingTime(text: string, language: Language, least: number): number {
  const chars = [...text.replace(/\s/g, "")].length;
  return Math.max(least, Math.round(NOTICE_MS + chars / (PER_MINUTE[language] ?? PER_MINUTE.en) * 60_000));
}
