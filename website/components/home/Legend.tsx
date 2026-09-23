import { LevelBadge, levelHelp } from "@/components/site/Level";
import { LEVELS } from "@/lib/status";
import type { Locale } from "@/lib/i18n";

export function Legend({ locale, title, draft }: { locale: Locale; title: string; draft: string }) {
  return (
    <aside className="legend wrap" aria-labelledby="legend-title">
      <h2 id="legend-title" className="legend-title mono">
        {title}
      </h2>
      <ul className="legend-list">
        {LEVELS.map((l) => (
          <li key={l}>
            <LevelBadge level={l} locale={locale} small />
            <span>{levelHelp(l, locale)}</span>
          </li>
        ))}
      </ul>
      <p className="legend-draft">
        <span className="chip">Draft</span> {draft}
      </p>
    </aside>
  );
}
