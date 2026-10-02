import type { Translate } from "../locales/translate";

/** "2 minutes", "3 hours": how far the clock is off, in the app's language, to the minute (or the hour past ninety minutes). */
export function clockOffAmount(ms: number, language: string): string {
  const minutes = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  const [value, unit] = minutes >= 90 ? [Math.round(minutes / 60), "hour"] : [minutes, "minute"];
  try { return new Intl.NumberFormat(language, { style: "unit", unit, unitDisplay: "long" }).format(value); }
  catch { return `${value} ${unit}${value === 1 ? "" : "s"}`; }
}

/**
 * The words of the note that this device's clock seems to be off by `ms` (positive: ahead): the short line, and what
 * is behind its ⓘ. The same in the chat's connection panel (`ClockOffHint`) and in Settings, Network.
 */
export function clockOffTexts(t: Translate, ms: number, language: string): { hint: string; info: string } {
  const amount = clockOffAmount(ms, language);
  return { hint: t("connection.clockOff.hint", { amount }), info: t(ms > 0 ? "connection.clockOff.infoAhead" : "connection.clockOff.infoBehind", { amount }) };
}
