import { useEffect, useState } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { useSavedMessages, useSavedRead } from "../../hooks/useSavedMessages";
import { getPrefix } from "../../lib/storage";
import { SavedIcon } from "./SavedIcon";

/**
 * Whether this profile had the way to its saved messages when they were last read: drawn at once from this, so the
 * rows under it are not pushed down when the engine answers, a second or more after the chat list is drawn.
 */
const shownKey = () => `${getPrefix()}saved_row`;
function shownBefore(): boolean {
  try { return localStorage.getItem(shownKey()) === "1"; } catch { return false; }
}
function rememberShown(shown: boolean) {
  try { if (shown) localStorage.setItem(shownKey(), "1"); else localStorage.removeItem(shownKey()); } catch { /* drawn when they are read next time */ }
}

/**
 * The way to the Saved view, above the chat list (the phone's chat list too): there only while this profile has a
 * saved message, so a profile that never saved one sees no empty place. It says how many there are.
 */
export function SidebarSaved({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const { t } = useI18n();
  const saved = useSavedMessages();
  const read = useSavedRead();
  const [before] = useState(shownBefore);
  const shown = read ? saved.length > 0 : before;
  useEffect(() => { if (read) rememberShown(shown); }, [read, shown]);
  if (!shown) return null;
  return (
    <div className="px-3 pb-2 bg-sidebar-bg">
      <button type="button" data-testid="sidebar-saved" onClick={onOpen} aria-label={read ? t("saved.rowLabel", { count: saved.length }) : t("saved.title")} aria-current={active ? "page" : undefined}
        className={`flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-start text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-11 ${
          active ? "bg-surface-hover text-text-primary" : "bg-search-bg text-text-secondary hover:bg-surface-hover hover:text-text-primary"}`}>
        <SavedIcon className="shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium">{t("saved.title")}</span>
        <span data-testid="sidebar-saved-count" className="shrink-0 text-xs tabular-nums text-text-muted">{read ? saved.length : ""}</span>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-muted rtl:-scale-x-100"><path d="m9 6 6 6-6 6" /></svg>
      </button>
    </div>
  );
}
