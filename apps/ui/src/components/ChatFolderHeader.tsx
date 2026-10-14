import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from "react";
import { useI18n } from "../contexts/I18nContext";
import { folderUnread, type BadgeGroup } from "../lib/appBadge";
import { OTHER_CHATS_ID, deleteFolder, folderChatsId, moveFolder, renameFolder, type ChatFolder } from "../lib/chatFolders";
import { MUTE_EVENT } from "../lib/chatMute";
import type { ChatSession } from "../lib/types";
import { DeleteFolderDialog, FolderNameDialog } from "./chat/ChatFolderDialogs";
import { Menu, MenuItem, MenuSeparator } from "./Menu";

/*
 * A folder of the chat list (lib/chatFolders.ts): its header, which folds and unfolds it, and its chats' unread added
 * up. Folded, the header and its count are all that shows of the folder.
 */

/**
 * The header row, 44 px tall in both densities: a button with the folder's name that folds and unfolds it, and the
 * count beside it. The count is not in the button, so the button is named by the folder alone and described by the count.
 * Its ⋮ renames the folder, moves it among the others (`place`: where it is among how many) and deletes it.
 */
export function ChatFolderHeader({ folder, sessions, groups, place, onToggle, ordered = false, onByLatest }: {
  folder: ChatFolder;
  /** The person put its rows in their own order (by dragging): its ⋮ offers the order of the latest message back. */
  ordered?: boolean;
  onByLatest?(): void;
  /** The folder's chats and groups that can have something unread: all but the one open. */
  sessions: readonly ChatSession[];
  groups: readonly BadgeGroup[];
  place: { index: number; count: number };
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [asking, setAsking] = useState<"name" | "delete">();
  const menuRef = useRef<HTMLDivElement>(null), optionsRef = useRef<HTMLButtonElement>(null);
  const closeMenu = () => setMenuOpen(false);
  // A folder moved from its ⋮ keeps the focus on that ⋮, in its new place: the page puts the moved rows back in, which drops it.
  const moved = useRef(false);
  useLayoutEffect(() => { if (moved.current) { moved.current = false; optionsRef.current?.focus(); } }, [place.index]);
  const move = (by: -1 | 1) => { moved.current = true; moveFolder(folder.id, by); closeMenu(); };
  const optionsLabel = t("sidebar.folder.options", { name: folder.name });
  const label = unread && (unread.count === 1 ? t("sidebar.folder.unreadOne", { name: folder.name }) : t("sidebar.folder.unreadCount", { count: unread.count, name: folder.name }));
  return (
    <div data-testid="chat-folder" data-folder={folder.id} data-folded={folder.folded || undefined} className="relative flex h-11 items-center border-b border-border/40 bg-sidebar-bg">
      <button type="button" data-testid="chat-folder-toggle" aria-expanded={!folder.folded} aria-controls={folder.folded ? undefined : folderChatsId(folder.id)} aria-describedby={unread ? badgeId : undefined} onClick={onToggle}
        className={`flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 ps-3 text-start ${unread ? "pe-12" : "pe-2"} text-[13px] font-semibold text-text-secondary transition-colors hover:bg-surface-alt hover:text-text-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent`}>
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 transition-transform ${folder.folded ? "-rotate-90 rtl:rotate-90" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
        <span dir="auto" data-testid="chat-folder-name" title={folder.name} className="min-w-0 truncate">{folder.name}</span>
      </button>
      {unread && <span id={badgeId} role="img" aria-label={label || undefined} data-testid="chat-folder-unread" data-muted={unread.muted || undefined}
        className={`pointer-events-none absolute end-12 top-1/2 inline-flex h-5 min-w-5 -translate-y-1/2 items-center justify-center rounded-full px-1.5 text-[11px] font-bold leading-none ${unread.muted ? "bg-text-secondary text-sidebar-bg" : "bg-accent text-on-accent"}`}>
        {unread.count > 99 ? "99+" : unread.count}
      </span>}
      <div ref={menuRef} className="relative flex shrink-0 pe-1.5">
        <button ref={optionsRef} type="button" data-testid="chat-folder-options" aria-haspopup="true" aria-expanded={menuOpen} aria-label={optionsLabel} title={optionsLabel} onClick={() => setMenuOpen(o => !o)}
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-text-muted transition-colors hover:bg-text-primary/10 hover:text-accent aria-expanded:bg-text-primary/10 aria-expanded:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" /></svg>
        </button>
        <Menu testId="chat-folder-options-menu" open={menuOpen} onClose={closeMenu} anchorRef={menuRef} portal focusFirst label={optionsLabel}>
          <MenuItem testId="chat-folder-rename" onClick={() => { closeMenu(); setAsking("name"); }}>{t("sidebar.folder.rename")}</MenuItem>
          {place.index > 0 && <MenuItem testId="chat-folder-up" onClick={() => move(-1)}>{t("chat.menu.moveUp")}</MenuItem>}
          {place.index < place.count - 1 && <MenuItem testId="chat-folder-down" onClick={() => move(1)}>{t("chat.menu.moveDown")}</MenuItem>}
          {ordered && onByLatest && <MenuItem testId="chat-folder-by-latest" onClick={() => { closeMenu(); onByLatest(); }}>{t("sidebar.folder.byLatest")}</MenuItem>}
          <MenuSeparator />
          <MenuItem danger testId="chat-folder-delete" onClick={() => { closeMenu(); setAsking("delete"); }}>{t("sidebar.folder.delete")}</MenuItem>
        </Menu>
      </div>
      {asking === "name" && <FolderNameDialog name={folder.name} returnFocus={optionsRef} onClose={() => setAsking(undefined)} onSave={name => { renameFolder(folder.id, name); setAsking(undefined); }} />}
      {asking === "delete" && <DeleteFolderDialog name={folder.name} onClose={() => setAsking(undefined)} onConfirm={() => deleteFolder(folder.id)} />}
    </div>
  );
}

/**
 * The heading of the chats and groups in no folder, shown once there is a folder: it folds and unfolds them as a
 * folder's header does, with their unread added up while they are folded away. It has no ⋮: it is not a folder.
 */
export function OtherChatsHeader({ folded, sessions, groups, onToggle }: {
  folded: boolean;
  /** The rows that can have something unread: all but the one open. */
  sessions: readonly ChatSession[];
  groups: readonly BadgeGroup[];
  onToggle(): void;
}) {
  const { t } = useI18n();
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    window.addEventListener(MUTE_EVENT, redraw);
    return () => window.removeEventListener(MUTE_EVENT, redraw);
  }, []);
  const name = t("sidebar.folder.others");
  const unread = folded ? folderUnread(sessions, groups) : undefined;
  const badgeId = useId();
  const label = unread && (unread.count === 1 ? t("sidebar.folder.unreadOne", { name }) : t("sidebar.folder.unreadCount", { count: unread.count, name }));
  return (
    <div data-testid="chat-folder-others" data-folded={folded || undefined} className="relative flex h-11 items-center border-b border-border/40 bg-sidebar-bg">
      <button type="button" data-testid="chat-folder-others-toggle" aria-expanded={!folded} aria-controls={folded ? undefined : OTHER_CHATS_ID} aria-describedby={unread ? badgeId : undefined} onClick={onToggle}
        className={`flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 ps-3 text-start ${unread ? "pe-12" : "pe-2"} text-[13px] font-semibold text-text-secondary transition-colors hover:bg-surface-alt hover:text-text-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent`}>
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 transition-transform ${folded ? "-rotate-90 rtl:rotate-90" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
        <span className="min-w-0 truncate">{name}</span>
      </button>
      {unread && <span id={badgeId} role="img" aria-label={label || undefined} data-testid="chat-folder-others-unread" data-muted={unread.muted || undefined}
        className={`pointer-events-none absolute end-3 top-1/2 inline-flex h-5 min-w-5 -translate-y-1/2 items-center justify-center rounded-full px-1.5 text-[11px] font-bold leading-none ${unread.muted ? "bg-text-secondary text-sidebar-bg" : "bg-accent text-on-accent"}`}>
        {unread.count > 99 ? "99+" : unread.count}
      </span>}
    </div>
  );
}
