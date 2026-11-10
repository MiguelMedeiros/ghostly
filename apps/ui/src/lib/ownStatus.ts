import { STATUS_TEXT_MAX, type StatusAvailability } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";

/*
 * This profile's own status and presence (WISP 401 § Presence and status): what the account menu's picker offers and
 * the Settings switch writes. The engine keeps the status and says it to every contact; nothing is kept here.
 */

/** In the order the picker shows them: the green, the reds, the amber. */
export const AVAILABILITIES: readonly StatusAvailability[] = ["available", "busy", "dnd", "away"];

/** The dot's colour by availability, from the theme's tokens: green, red, amber. */
export const AVAILABILITY_DOT: Record<StatusAvailability, string> = { available: "bg-success", busy: "bg-danger", dnd: "bg-danger", away: "bg-warn-ink" };

/** A few emoji a status often starts with; any other one from the full panel. */
export const STATUS_EMOJI = ["📅", "🍕", "🏠", "🚗", "🤒", "🌴", "🎧", "💻"] as const;

/** When a status ends: after a while, at the end of today or of this week, at a chosen time, never, or as it was. */
export const STATUS_ENDS = ["30m", "1h", "4h", "today", "week", "custom", "never"] as const;
export type StatusEnd = (typeof STATUS_ENDS)[number] | "keep";

const LENGTH: Partial<Record<StatusEnd, number>> = { "30m": 30 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000 };

/** The day's first day of the week in this language (1 Monday … 7 Sunday), Monday where the browser cannot say. */
function firstDayOfWeek(language: string): number {
  try {
    const locale = new Intl.Locale(language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    return locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay ?? 1;
  } catch { return 1; }
}

/** When a status chosen now ends (Unix ms), undefined for no end. `custom` and `keep` are the picker's own. */
export function statusEnd(choice: Exclude<StatusEnd, "custom" | "keep">, language: string, now = Date.now()): number | undefined {
  if (choice === "never") return undefined;
  const length = LENGTH[choice];
  if (length) return now + length;
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  if (choice === "today") return midnight.getTime();
  // This week: up to the start of the next one, as the language counts weeks.
  const day = midnight.getDay() || 7;
  midnight.setDate(midnight.getDate() + ((firstDayOfWeek(language) - day + 7) % 7));
  return midnight.getTime();
}

/** A status text as long as it may be: 60 characters as a person counts them (an emoji is one, not two). */
export const capStatusText = (text: string) => [...text].slice(0, STATUS_TEXT_MAX).join("");
export const statusTextLength = (text: string) => [...text].length;

/** "11:00", "Fri 18:00", or "Dec 3, 18:00" further on: when a status ends, in the app's language. */
export function statusEndText(until: number, language: string, now = Date.now()): string {
  const end = new Date(until), days = (until - now) / 86_400_000;
  if (end.toDateString() === new Date(now).toDateString()) return end.toLocaleTimeString(language, { hour: "numeric", minute: "2-digit" });
  return end.toLocaleString(language, { ...(days < 6 ? { weekday: "short" } : { month: "short", day: "numeric" }), hour: "numeric", minute: "2-digit" });
}

/** A time as a datetime-local field writes it (local, to the minute). */
export function localDateTime(at: number): string {
  const d = new Date(at), two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The person's own words in a sentence: isolated, so a text in another direction cannot turn the sentence around. */
export const isolate = (text: string) => `⁨${text}⁩`;

export const STATUS_PICKER_EVENT = "open-status-picker";
/** Opens the picker over the app (StatusPickerHost), from wherever the account menu is. */
export function openStatusPicker(): void {
  window.dispatchEvent(new Event(STATUS_PICKER_EVENT));
}

/** Settings, "Share when I'm online": per profile, on unless switched off. */
export function setSharePresence(on: boolean): Promise<void> {
  return engine.call("updateSettings", { settings: { sharePresence: on } });
}
