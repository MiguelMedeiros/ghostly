import { useI18n } from "../contexts/I18nContext";
import type { NeedsYou } from "../lib/needsYou";

/**
 * A step on the trail to something that needs the person (lib/needsYou): the places' dot, inline, beside a tab's, a
 * card's or a row's name. Its words are `label`'s, for whoever cannot see it.
 */
export function NeedsYouDot({ label }: { label?: string }) {
  return <>
    <span data-testid="needs-you-dot" aria-hidden="true" className="nav-dot-inline needs-you-dot" />
    {label && <span className="sr-only">, {label}</span>}
  </>;
}

/**
 * The top of a place's page while something there needs the person: each thing in one line, with the dot its place
 * wears, and Show to go to it.
 */
export function NeedsYouList({ items }: { items: NeedsYou[] }) {
  const { t } = useI18n();
  if (!items.length) return null;
  return (
    <section aria-label={t("common.needsYou.title")} data-testid="needs-you" className="bg-surface rounded-xl divide-y divide-border">
      {items.map((item) => (
        <p key={item.id} data-testid="needs-you-item" data-id={item.id} className="flex items-center gap-3 px-4 py-2 min-h-11 text-sm text-text-primary">
          <span className="nav-dot-inline" aria-hidden="true" />
          <span className="flex-1 min-w-0 break-words">{item.text}</span>
          <button type="button" onClick={item.show} aria-label={`${t("common.needsYou.show")}: ${item.text}`}
            className="shrink-0 px-2 py-1 min-h-9 rounded-lg text-accent font-medium hover:bg-surface-alt transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            {t("common.needsYou.show")}
          </button>
        </p>
      ))}
    </section>
  );
}
