import { useEffect, useId, useReducer } from "react";
import { useI18n } from "../contexts/I18nContext";
import { folderUnread, type BadgeGroup } from "../lib/appBadge";
import { folderChatsId, type ChatFolder } from "../lib/chatFolders";
import { MUTE_EVENT } from "../lib/chatMute";
import type { ChatSession } from "../lib/types";

/*
 * A folder of the chat list (lib/chatFolders.ts): its header, which folds and unfolds it, and its chats' unread added
 * up. Folded, the header and its count are all that shows of the folder.
 */

/**
 * The header row, 44 px tall in both densities: a button with the folder's name that folds and unfolds it, and the
 * count beside it. The count is not in the button, so the button is named by the folder alone and described by the count.
 */
export function ChatFolderHeader({ folder, sessions, groups, onToggle }: {
  folder: ChatFolder;
  /** The folder's chats and groups that can have something unread: all but the one open. */
  sessions: readonly ChatSession[];
  groups: readonly BadgeGroup[];
  onToggle(): void;
}) {
  const { t } = useI18n();
  // A chat muted or unmuted moves its unread in or out of the count; the list itself is not drawn again for it.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    window.addEventListener(MUTE_EVENT, redraw);
    return () => window.removeEventListener(MUTE_EVENT, redraw);
  }, []);
  const unread = folderUnread(sessions, groups);
  const badgeId = useId();
  const label = unread && (unread.count === 1 ? t("sidebar.folder.unreadOne", { name: folder.name }) : t("sidebar.folder.unreadCount", { count: unread.count, name: folder.name }));
  return (
    <div data-testid="chat-folder" data-folder={folder.id} data-folded={folder.folded || undefined} className="relative flex h-11 items-center border-b border-border/40 bg-sidebar-bg">
      <button type="button" data-testid="chat-folder-toggle" aria-expanded={!folder.folded} aria-controls={folder.folded ? undefined : folderChatsId(folder.id)} aria-describedby={unread ? badgeId : undefined} onClick={onToggle}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 ps-3 pe-12 text-start text-[13px] font-semibold text-text-secondary transition-colors hover:bg-surface-alt hover:text-text-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 transition-transform ${folder.folded ? "-rotate-90 rtl:rotate-90" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
        <span dir="auto" data-testid="chat-folder-name" className="min-w-0 truncate">{folder.name}</span>
      </button>
      {unread && <span id={badgeId} role="img" aria-label={label || undefined} data-testid="chat-folder-unread" data-muted={unread.muted || undefined}
        className={`pointer-events-none absolute end-3 top-1/2 inline-flex h-5 min-w-5 -translate-y-1/2 items-center justify-center rounded-full px-1.5 text-[11px] font-bold leading-none ${unread.muted ? "bg-text-secondary text-sidebar-bg" : "bg-accent text-on-accent"}`}>
        {unread.count > 99 ? "99+" : unread.count}
      </span>}
    </div>
  );
}
