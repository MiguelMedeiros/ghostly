import type { Level } from "@/lib/status";
import { NEXT_VERSION, RELEASED_VERSION } from "@/lib/status";
import type { Locale } from "@/lib/i18n";
import { shell } from "@/content/shell";

/** An availability badge. The label always says the level in words, never color alone. */
export function LevelBadge({ level, locale = "en", small }: { level: Level; locale?: Locale; small?: boolean }) {
  const t = shell[locale];
  return (
    <span
      className={`level ${small ? "level--sm" : ""}`}
      data-level={level}
      title={t.levelHelp[level].replace("{v}", RELEASED_VERSION).replace("{n}", NEXT_VERSION)}
    >
      {t.levels[level]}
    </span>
  );
}

export function levelHelp(level: Level, locale: Locale) {
  return shell[locale].levelHelp[level].replace("{v}", RELEASED_VERSION).replace("{n}", NEXT_VERSION);
}
