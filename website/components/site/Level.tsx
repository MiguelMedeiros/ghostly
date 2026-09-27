import type { Level } from "@/lib/status";
import { shell } from "@/content/shell";

/** An availability badge. The label always says the level in words, never color alone. */
export function LevelBadge({ level, small }: { level: Level; small?: boolean }) {
  const t = shell;
  return (
    <span className={`level ${small ? "level--sm" : ""}`} data-level={level} title={t.levelHelp[level]}>
      {t.levels[level]}
    </span>
  );
}

export function levelHelp(level: Level) {
  return shell.levelHelp[level];
}
