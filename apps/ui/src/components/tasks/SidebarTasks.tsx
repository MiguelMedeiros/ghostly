import { useMemo } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { useCardIndex } from "../../hooks/useTaskBoard";
import { boardEntries, isActiveTask } from "../../lib/taskBoard";

/**
 * The way to the Tasks board, above the chat list (the phone's chat list too): there only while this profile has a
 * bot's card in some chat or group, so a profile without bots never sees an empty place. It says how many tasks are
 * still going, across every chat. Not a place of the account bar or the phone's tab bar: those hold five at most.
 */
export function SidebarTasks({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const { t } = useI18n();
  const index = useCardIndex();
  const going = useMemo(() => {
    const entries = boardEntries(index);
    return { cards: entries.length, active: entries.filter((e) => e.card.kind === "task" && isActiveTask(e.card)).length };
  }, [index]);
  if (!going.cards) return null;
  const label = going.active ? t("cards.panel.buttonCount", { count: going.active }) : t("cards.panel.button");
  return (
    <div className="px-3 pb-2 bg-sidebar-bg">
      <button type="button" data-testid="sidebar-tasks" onClick={onOpen} aria-label={label} aria-current={active ? "page" : undefined}
        className={`flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-start text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-11 ${
          active ? "bg-surface-hover text-text-primary" : "bg-search-bg text-text-secondary hover:bg-surface-hover hover:text-text-primary"}`}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
          <path d="M9 6h11M9 12h11M9 18h11" /><path d="m3.5 6 1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17" />
        </svg>
        <span className="min-w-0 flex-1 truncate font-medium">{t("cards.panel.button")}</span>
        <span data-testid="sidebar-tasks-summary" className="shrink-0 text-xs text-text-muted">{going.active ? t("cards.panel.activeCount", { count: going.active }) : t("cards.panel.idle")}</span>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-muted rtl:-scale-x-100"><path d="m9 6 6 6-6 6" /></svg>
      </button>
    </div>
  );
}
