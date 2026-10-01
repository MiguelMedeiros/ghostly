import { ago } from "./time";

/**
 * "3 min ago" in the interface's language: lib/time's words in English, as they always read, and Intl's in any other
 * ("há 3 min.", "3 分钟前"). Past a month, the date, as lib/time gives it.
 */
export function agoIn(language: string): (seconds: number, now?: number) => string {
  if (language === "en") return ago;
  return (seconds, now = Date.now() / 1000) => {
    const d = Math.max(0, now - seconds);
    const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
    if (d < 60) return rtf.format(0, "second");
    if (d < 3600) return rtf.format(-Math.floor(d / 60), "minute");
    if (d < 86_400) return rtf.format(-Math.floor(d / 3600), "hour");
    if (d < 30 * 86_400) return rtf.format(-Math.floor(d / 86_400), "day");
    return new Date(seconds * 1000).toLocaleDateString(language, { year: "numeric", month: "short", day: "numeric" });
  };
}
