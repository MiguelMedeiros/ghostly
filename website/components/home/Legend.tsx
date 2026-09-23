import { LevelBadge, levelHelp } from "@/components/site/Level";
import { LEVELS } from "@/lib/status";
import type { Locale } from "@/lib/i18n";
import "@/app/next.css";

function Entries({ locale, draft }: { locale: Locale; draft: string }) {
  return (
    <>
      <ul className="nx-legend-list">
        {LEVELS.map((l) => (
          <li key={l}>
            <LevelBadge level={l} locale={locale} small />
            <span className="note">{levelHelp(l, locale)}</span>
          </li>
        ))}
      </ul>
      <p className="nx-legend-draft">
        <span className="chip">Draft</span> <span className="note">{draft}</span>
      </p>
    </>
  );
}

/** How to read the badges: a thin strip on wide screens, a closed <details> on phones. */
export function Legend({ locale, title, draft }: { locale: Locale; title: string; draft: string }) {
  return (
    <aside className="nx-legend" aria-label={title}>
      <div className="wrap">
        <div className="nx-legend-strip">
          <span className="caption nx-legend-title">{title}</span>
          <Entries locale={locale} draft={draft} />
        </div>
        <details className="nx-legend-details">
          <summary>
            <span className="caption">{title}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </summary>
          <Entries locale={locale} draft={draft} />
        </details>
      </div>
    </aside>
  );
}
