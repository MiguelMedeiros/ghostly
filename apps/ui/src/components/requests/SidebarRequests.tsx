import { useI18n } from "../../contexts/I18nContext";
import { useEngineState } from "../../lib/engineState";

/**
 * The way to Requests (WISP 8xx, Contact Links), above the chat list: there while this profile has a contact link or
 * requests wait, so a profile that never made one never sees it. It says how many wait. A request never reaches the
 * chat list itself: only an accept makes it a chat.
 */
export function SidebarRequests({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const { t } = useI18n();
  const state = useEngineState();
  const waiting = state?.contactRequests?.length ?? 0;
  if (!state?.contactLink && !waiting) return null;
  const label = waiting ? t("requests.sidebarCount", { count: waiting }) : t("requests.title");
  return (
    <div className="px-3 pb-2 bg-sidebar-bg">
      <button type="button" data-testid="sidebar-requests" onClick={onOpen} aria-label={label} aria-current={active ? "page" : undefined}
        className={`flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-start text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-11 ${
          active ? "bg-surface-hover text-text-primary" : "bg-search-bg text-text-secondary hover:bg-surface-hover hover:text-text-primary"}`}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
          <path d="M4 5h16v11H8l-4 4z" /><path d="M9 10.5h6" />
        </svg>
        <span className="min-w-0 flex-1 truncate font-medium">{t("requests.title")}</span>
        {waiting > 0 && (
          <span data-testid="sidebar-requests-count" className="shrink-0 rounded-full bg-accent text-on-accent h-5 min-w-5 px-1.5 grid place-items-center text-[11px] font-bold tabular-nums">
            {waiting > 99 ? "99+" : waiting}
          </span>
        )}
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-muted rtl:-scale-x-100"><path d="m9 6 6 6-6 6" /></svg>
      </button>
    </div>
  );
}
