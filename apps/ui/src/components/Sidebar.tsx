import { contactTag, publicKeyLabel } from "../lib/publicKeyLabel";
import { DeleteChatDialog } from "./DeleteChatDialog";
import { useUsageByPeer } from "../hooks/useUsage";
import { useWorkingByPeer } from "../hooks/useWorking";
import { ChatRow, GroupRow } from "./ChatRow";
import { ChatFolderHeader, OtherChatsHeader } from "./ChatFolderHeader";
import { OTHER_CHATS_ID, createFolder, folderChatsId, inOrder, movePinnedBeside, setChatFolder, setFolderFolded, setOthersFolded, setSectionOrder, useChatFolders } from "../lib/chatFolders";
import { FolderNameDialog } from "./chat/ChatFolderDialogs";
import { FolderIcon } from "./chat/ChatFolderMenu";
import { groupChat } from "../lib/chatMute";
import { formatListTime } from "../lib/chatList";
import { foldText } from "../lib/chatSearch";
import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { NewGroupDialog } from "./NewGroupDialog";
import { groupPath, groupRouteId, invitationRow } from "../lib/groups";
import { useIsMobile } from "../hooks/useIsMobile";
import { useLabelsFit } from "../hooks/useLabelsFit";
import { Menu, MenuItem } from "./Menu";
import { useLocation, useNavigate } from "react-router-dom";
import { JoinDialog } from "./JoinDialog";
import { useBackgroundPoller } from "../hooks/useBackgroundPoller";
import { useI18n } from "../contexts/I18nContext";
import { useSettings } from "../contexts/SettingsContext";
import { AccountBar } from "./AccountBar";
import { AppBrand } from "./AppBrand";
import { OfflineBanner } from "./OfflineBanner";
import { StorageFullBanner } from "./StorageFullBanner";
import { LimitedBanner } from "./devices/LimitedStart";
import { InstallHint } from "./InstallApp";
import { StorageKeeper } from "./StorageKeeper";
import { UpdateBanner } from "./UpdateBanner";
import {
  isSessionPinned,
  setSessionPinned,
  deleteSession,
  getUnreadCount,
  markSessionAsRead,
  ensureSession,
  getInviteCode,
  listShownSessions,
} from "../lib/storage";
import { createPairedChat } from "../lib/pairedChat";
import { chatPath, decodePart } from "../lib/url";
import type { ChatSession } from "../lib/types";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { useRowReorder } from "../hooks/useRowReorder";
import { usePageShown } from "../hooks/usePageShown";
import { shownContactName, useContactFaces } from "./identities/contactFace";
import { reactionNoteText } from "../lib/reactions";
import { SidebarTasks } from "./tasks/SidebarTasks";
import { openJoinProfile } from "../lib/devices";

const subscribeEngine = (listener: () => void) => engine.subscribe(listener);
const engineSnapshot = () => engine.state;

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 420;
/** What the page beside the list always keeps, however wide the list is dragged: a phone's width, about. */
const MIN_PAGE_WIDTH = 320;

/** Search folds case and accents, as the in-chat search does: "jose" finds "José". `q` is folded already. */
const found = (text: string | undefined, q: string) => !!text && foldText(text).includes(q);

/** The groups whose name has the search in it; all of them with no search. (Outside the component: the React Compiler keeps its memoization then.) */
function groupsFound<G extends { name: string }>(groups: G[], search: string): G[] {
  const q = foldText(search);
  return search ? groups.filter(g => found(g.name, q)) : groups;
}

/** The pinned chats among `sessions`, as the list shows them. (Outside the component, as `groupsFound`.) */
const pinnedRows = (sessions: ChatSession[]): string[] => sessions.filter(s => isSessionPinned(s.id)).map(s => s.id);

export function Sidebar() {
  const nav = useAppNavigation();
  const navigate = useNavigate();
  const location = useLocation();
  const { t, language } = useI18n();
  // New and Join keep their words while they fit beside the logo, in this language (French needs more room).
  const headerRef = useRef<HTMLDivElement>(null), brandRef = useRef<HTMLDivElement>(null), actionsRef = useRef<HTMLDivElement>(null);
  const labelsFit = useLabelsFit(headerRef, brandRef, actionsRef, language);
  const isMobile = useIsMobile();
  const density = useSettings().settings.chatListDensity;
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [search, setSearch] = useState("");
  const [showNewChat, setShowNewChat] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null), newMoreRef = useRef<HTMLButtonElement>(null);
  const closeNewMenu = () => setNewMenuOpen(false);
  const engineState = useSyncExternalStore(subscribeEngine, engineSnapshot);
  // A bot's usage card (WISP 405 § Usage) per contact: the meter on its row.
  const usageByPeer = useUsageByPeer();
  // Each contact's running tasks (WISP 405 § Showing a card): the working mark on its row.
  const workingByPeer = useWorkingByPeer();
  const groups = engineState?.groups ?? [];
  // The chats are in the page's storage at once, the groups come with the engine's state after every chat's history
  // is read: drawn alone, the chats were pushed down under the groups a second later, and a click aimed at a chat
  // opened a group. The list waits for the groups, and draws everything at once.
  const listReady = !!engineState?.groupsLoaded;
  const activeGroupId = groupRouteId(location.pathname);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_WIDTH);
  const isResizingRef = useRef(false);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      // Right to left, the sidebar sits on the right and its edge is dragged from there.
      const edge = document.documentElement.dir === "rtl" ? window.innerWidth - ev.clientX : ev.clientX;
      const newWidth = Math.min(MAX_WIDTH, window.innerWidth - MIN_PAGE_WIDTH, Math.max(MIN_WIDTH, edge));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  const currentChatPath = location.pathname.startsWith("/chat")
    ? location.pathname
    : null;

  const activeSessionId = (() => {
    if (!currentChatPath) return null;
    const id = decodePart(currentChatPath.replace("/chat/", ""));
    return id && !id.includes("/") ? id : null;
  })();


  const { syncingSessions } = useBackgroundPoller(activeSessionId);

  const refreshSessions = useCallback(() => {
    // Read through the page's one cache: a long chat whose stored text changed is parsed once for every reader (`listShownSessions`).
    const updated = listShownSessions();

    setSessions(updated);
    // A chat deleted elsewhere takes its pending "Delete?" with it.
    setConfirmDeleteId((id) => (id && !updated.some((s) => s.id === id) ? null : id));
  }, []);

  useEffect(() => {
    refreshSessions();
    const interval = setInterval(refreshSessions, 3000);
    
    const handleSessionUpdate = () => refreshSessions();
    window.addEventListener("session-updated", handleSessionUpdate);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener("session-updated", handleSessionUpdate);
    };
  }, [refreshSessions]);

  // The open chat is read while the page shows; in a hidden window what comes stays unread (usePageShown).
  const pageShown = usePageShown();
  useEffect(() => {
    if (activeSessionId && pageShown) markSessionAsRead(activeSessionId);
  }, [activeSessionId, pageShown, sessions]);

  // The installed app's shortcuts (manifest.json): `#/new` starts a chat, `#/scan` opens Join with the camera on.
  // Each address is acted on once (StrictMode runs effects twice), and leaves the history at once (an intake, Root.tsx).
  const [scanOnOpen, setScanOnOpen] = useState(false);
  const shortcutDone = useRef<string | null>(null);
  useEffect(() => { if (!showNewChat) setScanOnOpen(false); }, [showNewChat]);
  useEffect(() => {
    const shortcut = location.pathname === "/new" || location.pathname === "/scan" ? location.pathname : null;
    // Not by the entry's key: every address typed or opened from outside has the same one ("default").
    if (!shortcut) { shortcutDone.current = null; return; }
    if (shortcutDone.current === shortcut) return;
    shortcutDone.current = shortcut;
    // Replaced, so Back never lands on it again (and makes another chat).
    navigate("/", { replace: true });
    if (shortcut === "/scan") { setScanOnOpen(true); setShowNewChat(true); return; }
    void createPairedChat().then(id => nav.conversation(chatPath(id)), () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `nav` changes with every location
  }, [location.pathname]);

  const handleDelete = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setConfirmDeleteId(sessionId);
  };

  // The identity a contact is shown as (identities/contactFace.ts): its name in the row, and found by search.
  const faceOf = useContactFaces();
  const query = foldText(search);
  const filtered = sessions.filter((s) => {
    if (!search) return true;
    if (found(s.label, query)) return true;
    if (found(s.nick, query)) return true;
    if (found(faceOf(s.peerPubKeyB64)?.name, query)) return true;
    if (found(s.peerPubKeyB64, query)) return true;
    return s.messages.some((m) => found(m.text, query));
  });
  const shownGroups = groupsFound(groups, search);
  // The person's folders, first in the list and in their order; a search shows what it finds as one list, with no folders.
  const { folders, folderOf, othersFolded, orderOf } = useChatFolders();
  const shownFolders = search ? [] : folders;
  // "Other chats" folds like a folder, once there is one. A search shows everything it finds.
  const looseFolded = shownFolders.length > 0 && othersFolded;
  const filed = (chat: string) => shownFolders.length > 0 && folderOf(chat) !== undefined;
  // The chats and groups in no folder: all of them while there are no folders, where the list is as it always was.
  // An invitation to a group is answered from its row: it stays in sight, in no folder, whatever folder the group was in.
  // A group kept here, knocking to get back in, is no invitation: it stays in its folder.
  const folderOfGroup = (g: (typeof groups)[number]) => (invitationRow(g) || shownFolders.length === 0 ? undefined : folderOf(groupChat(g.id)));
  const looseGroups = shownGroups.filter(g => folderOfGroup(g) === undefined);
  const loose = filtered.filter(s => !filed(s.id));
  // The pinned chats are put in order by dragging one among the others of its own part of the list: those of its
  // folder, or those in no folder. A search shows only some of them, so not then.
  // With folders, each part of the list (a folder, or the rows in no folder) is in order of the latest message until
  // the person drags a row inside it; from then on it keeps their order, for every row in it, pinned or not. The same
  // drag puts a chat or a group in a folder: dropped on a folder it goes there, on the rows in no folder it comes
  // out. An invitation stays where it is answered. With no folder the list is as it always was: pinned chats only.
  type PartRow = { key: string; group?: (typeof groups)[number]; session?: ChatSession };
  const partRows = (itsGroups: typeof groups, itsChats: ChatSession[], folder: string | undefined): PartRow[] => inOrder(
    [...itsGroups.filter(g => !invitationRow(g)).map(group => ({ key: groupChat(group.id), group })), ...itsChats.map(session => ({ key: session.id, session }))],
    row => row.key, orderOf(folder));
  const byFolders = shownFolders.length > 0;
  const looseRows = byFolders ? partRows(looseGroups, loose, undefined) : [];
  const folderRows = new Map(shownFolders.map(folder => [folder.id, partRows(shownGroups.filter(g => folderOfGroup(g) === folder.id), filtered.filter(s => folderOf(s.id) === folder.id), folder.id)]));
  const parts: string[][] = byFolders ? [looseRows.map(r => r.key), ...[...folderRows.values()].map(rows => rows.map(r => r.key))] : search ? [] : [pinnedRows(loose)];
  const besideRow = (id: string) => parts.find(part => part.includes(id)) ?? [];
  const partOf = (chat: string) => (filed(chat) ? folderOf(chat) : undefined);
  const movable = byFolders ? parts.flat() : [];
  /** A row let go at `index` among the rows of its part: that part keeps the order it now has. */
  const moveInPart = (id: string, index: number) => {
    const rows = besideRow(id).filter(key => key !== id);
    rows.splice(Math.max(0, Math.min(rows.length, index)), 0, id);
    setSectionOrder(partOf(id), rows);
  };
  const reorder = useRowReorder({ ids: parts.flat(), beside: besideRow, enabled: !search, onMove: byFolders ? moveInPart : movePinnedBeside,
    folders: { rows: movable, of: partOf, onDrop: setChatFolder } });
  /** A part of the list a dragged row would go to is marked while the row is over it. */
  const dropMark = (folder: string | null) => (reorder.over === folder ? " bg-accent/10 outline-2 -outline-offset-2 outline-accent" : "");

  const groupRow = (group: (typeof groups)[number]) => (
    <GroupRow key={group.id} group={group} density={density} active={activeGroupId === group.id} onOpen={() => { nav.conversation(groupPath(group.id)); setConfirmDeleteId(null); }}
      drag={movable.includes(groupChat(group.id)) ? { props: reorder.rowProps(groupChat(group.id)), dragging: reorder.dragging === groupChat(group.id), drop: reorder.drop?.id === groupChat(group.id) ? reorder.drop.edge : undefined } : undefined} />
  );
  const chatRow = (session: ChatSession) => {
    const lastMsg = session.messages[session.messages.length - 1];
    const path = chatPath(session.id);
    const isActive = activeSessionId === session.id;

    const face = faceOf(session.peerPubKeyB64);
    const shown = shownContactName({ nickname: session.label, face, nick: session.nick, fallback: t("common.unnamedContact", { key: contactTag(session.peerPubKeyB64) }) });
    const peerKey = publicKeyLabel(session.peerPubKeyB64);
    const isAnonymous = shown.from === "key";
    const peerLabel = shown.name;
    const unread = isActive ? 0 : getUnreadCount(session);
    const isCreator = !!getInviteCode(session.id);

    return (
      <ChatRow
        key={session.id}
        chatId={session.id}
        density={density}
        active={isActive}
        label={peerLabel}
        face={face}
        named={!isAnonymous}
        keyLabel={peerKey}
        peerPubKey={session.peerPubKeyB64}
        lastMessage={lastMsg}
        note={(session.lastReaction?.at ?? 0) > Math.max(lastMsg?.timestamp ?? 0, session.identitySharedAt ?? 0) ? reactionNoteText(session.lastReaction!, peerLabel, t)
          : (session.identitySharedAt ?? 0) > (lastMsg?.timestamp ?? 0) ? t("sidebar.sharedIdentity") : undefined}
        time={formatListTime(session.lastSyncAt ?? session.createdAt, undefined, language, t)}
        unread={unread}
        pinned={isSessionPinned(session.id)}
        syncing={syncingSessions.has(session.id)}
        creator={isCreator}
        onOpen={() => { markSessionAsRead(session.id); nav.conversation(path); setConfirmDeleteId(null); }}
        onTogglePin={() => setSessionPinned(session.id, !isSessionPinned(session.id))}
        onDelete={(e) => handleDelete(session.id, e)}
        deleteLabel={t("sidebar.deleteChat")}
        usage={usageByPeer.get(session.peerPubKeyB64)}
        working={workingByPeer.get(session.peerPubKeyB64)}
        reorder={besideRow(session.id).length > 1 || movable.includes(session.id)
          ? { props: reorder.rowProps(session.id), dragging: reorder.dragging === session.id, drop: reorder.drop?.id === session.id ? reorder.drop.edge : undefined }
          : undefined}
      />
    );
  };

  return (
    <div
      data-testid="sidebar"
      className={`relative flex flex-col bg-sidebar-bg ${isMobile ? "flex-1 min-w-0" : "sidebar-desktop border-e border-border shrink-0"}`}
      style={isMobile ? undefined : { width: sidebarWidth, minWidth: MIN_WIDTH, maxWidth: `min(${MAX_WIDTH}px, 100vw - ${MIN_PAGE_WIDTH}px)` }}
    >
      {/* Header */}
      <div ref={headerRef} data-labels={labelsFit ? undefined : "off"} className="sidebar-header h-14 header-safe shrink-0 flex items-center justify-between px-4 bg-panel-header">
        <div ref={brandRef} className="flex shrink-0"><AppBrand onHome={() => nav.home()} /></div>
        <div ref={actionsRef} className="grid shrink-0 grid-cols-2 items-stretch gap-1 whitespace-nowrap" data-testid="sidebar-chat-actions">
          {/* New: one click is a chat, as always; the arrow beside it also offers a group. */}
          <div ref={newMenuRef} role="group" aria-label={t("sidebar.new")} data-testid="sidebar-new" className="sidebar-new-split relative flex min-w-0">
            <button onClick={() => void createPairedChat().then(id => nav.conversation(chatPath(id)), () => {})} data-testid="sidebar-new-chat" aria-label={t("sidebar.startChat")} title={t("sidebar.newChat")} className="sidebar-header-action inline-flex min-h-10 min-w-10 flex-1 items-center justify-center gap-1 rounded-s-lg bg-accent p-2 text-sm font-semibold text-panel-header hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel-header"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v15l4-4h5 M18 14v8 M14 18h8"/></svg><span className="sidebar-action-label">{t("sidebar.new")}</span></button>
            <button ref={newMoreRef} onClick={() => setNewMenuOpen(open => !open)} aria-haspopup="true" aria-expanded={newMenuOpen} aria-controls="sidebar-new-menu" aria-label={t("sidebar.newMenu.label")} title={t("sidebar.newMenu.label")} data-testid="sidebar-new-more"
              className="inline-flex min-h-10 w-6 shrink-0 items-center justify-center rounded-e-lg border-s border-panel-header/25 bg-accent text-panel-header hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel-header">
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${newMenuOpen ? "rotate-180" : ""}`}><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <Menu id="sidebar-new-menu" testId="sidebar-new-menu" open={newMenuOpen} onClose={closeNewMenu} anchorRef={newMenuRef}>
              <MenuItem onClick={() => { closeNewMenu(); void createPairedChat().then(id => nav.conversation(chatPath(id)), () => {}); }} hint={t("sidebar.newMenu.chatHint")}
                icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v15l4-4h5 M18 14v8 M14 18h8"/></svg>}>
                {t("sidebar.newMenu.chat")}
              </MenuItem>
              <MenuItem testId="new-group" onClick={() => { closeNewMenu(); setShowNewGroup(true); }} hint={t("sidebar.newMenu.groupHint")}
                icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M16 11h6" /></svg>}>
                {t("sidebar.newMenu.group")}
              </MenuItem>
              <MenuItem testId="new-folder" onClick={() => { closeNewMenu(); setShowNewFolder(true); }} hint={t("sidebar.newMenu.folderHint")} icon={<FolderIcon />}>
                {t("sidebar.newMenu.folder")}
              </MenuItem>
            </Menu>
          </div>
          <button onClick={() => setShowNewChat(true)} aria-label={t("join.submit")} title={t("sidebar.joinChat")} className="sidebar-header-action inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center gap-1 rounded-lg p-2 text-sm font-medium text-accent hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H9l-5 3v-6 M2 12h12 M10 8l4 4-4 4"/></svg><span className="sidebar-action-label">{t("sidebar.join")}</span></button>
        </div>
      </div>
      <UpdateBanner />
      <OfflineBanner />
      <StorageFullBanner />
      <LimitedBanner />
      <InstallHint hasChats={sessions.length > 0 || groups.length > 0} />
      <StorageKeeper hasChats={sessions.length > 0 || groups.length > 0} />
      {showNewGroup && <NewGroupDialog returnFocus={newMoreRef} onClose={() => setShowNewGroup(false)} onCreated={id => { setShowNewGroup(false); nav.conversation(groupPath(id), { share: "created" }); }} />}
      {showNewFolder && <FolderNameDialog returnFocus={newMoreRef} onClose={() => setShowNewFolder(false)} onSave={name => { createFolder(name); setShowNewFolder(false); setSearch(""); }} />}
      {showNewChat && <JoinDialog autoScan={scanOnOpen} onClose={() => setShowNewChat(false)} onJoin={keys => {const id = ensureSession(keys); setShowNewChat(false); nav.conversation(chatPath(id)); refreshSessions();}}
        onOpenChat={id => { setShowNewChat(false); nav.conversation(chatPath(id)); }}
        onJoinGroup={async link => { const { groupId } = await engine.call("joinGroupByLink", { link }); setShowNewChat(false); nav.conversation(groupPath(groupId)); }} />}

      {/* Search */}
      <div className="px-3 py-2 bg-sidebar-bg">
        <div className="flex items-center gap-3 bg-search-bg rounded-lg px-3 py-1.5 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:-outline-offset-2 has-[input:focus-visible]:outline-focus-ring">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-text-muted shrink-0"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("sidebar.searchPlaceholder")}
            className="flex-1 bg-transparent border-none text-sm text-text-primary placeholder-text-muted outline-none py-1"
          />
        </div>
      </div>

      <SidebarTasks active={location.pathname === "/tasks"} onOpen={() => (location.pathname === "/tasks" ? nav.home() : nav.place("/tasks"))} />

      {/* Chat List */}
      <div className="flex-1 overflow-y-auto" data-testid="chat-list" data-drag-scroll="" aria-busy={!listReady || undefined}>
        {listReady && <>
        {shownFolders.map((folder, index) => {
          const itsGroups = shownGroups.filter(g => folderOfGroup(g) === folder.id);
          const itsChats = filtered.filter(s => folderOf(s.id) === folder.id);
          return (
            <div key={folder.id} role="group" aria-label={folder.name} data-testid="chat-folder-section" data-folder-drop={folder.id} data-drop-over={reorder.over === folder.id || undefined} className={dropMark(folder.id).trim() || undefined}>
              <ChatFolderHeader folder={folder} sessions={itsChats.filter(s => s.id !== activeSessionId)} groups={itsGroups.filter(g => g.id !== activeGroupId)} place={{ index, count: shownFolders.length }}
                ordered={!!orderOf(folder.id)?.length} onByLatest={() => setSectionOrder(folder.id, [])}
                onToggle={() => setFolderFolded(folder.id, !folder.folded)} />
              {!folder.folded && <div id={folderChatsId(folder.id)} data-testid="chat-folder-chats">
                {itsGroups.filter(invitationRow).map(groupRow)}
                {(folderRows.get(folder.id) ?? []).map(row => (row.group ? groupRow(row.group) : chatRow(row.session!)))}
                {itsGroups.length === 0 && itsChats.length === 0 && <p data-testid="chat-folder-empty" className="m-0 px-3 py-3 text-[13px] text-text-muted">{t("sidebar.folder.empty")}</p>}
              </div>}
            </div>
          );
        })}
        {/* The chats and groups in no folder. With folders it is where a dragged row comes out of one: its heading
            shows while a row is in the hand even when nothing is in it yet. */}
        <div data-testid="chat-folder-loose" {...(shownFolders.length > 0 && { "data-folder-drop": "", "data-drop-over": reorder.over === null || undefined })} className={dropMark(null).trim() || undefined}>
          {shownFolders.length > 0 && (looseGroups.length > 0 || loose.length > 0 || reorder.dragging !== undefined) && (
            <OtherChatsHeader folded={looseFolded} sessions={loose.filter(s => s.id !== activeSessionId)} groups={looseGroups.filter(g => g.id !== activeGroupId && !invitationRow(g))}
              onToggle={() => setOthersFolded(!looseFolded)} />
          )}
          {/* An invitation to a group is answered from its row: it stays in sight, folded or not. */}
          {looseFolded ? looseGroups.filter(invitationRow).map(groupRow) : (
            <div id={OTHER_CHATS_ID} data-testid="chat-folder-others-rows">
              {byFolders ? <>
                {looseGroups.filter(invitationRow).map(groupRow)}
                {looseRows.map(row => (row.group ? groupRow(row.group) : chatRow(row.session!)))}
              </> : <>
                {looseGroups.map(groupRow)}
                {loose.map(chatRow)}
              </>}
            </div>
          )}
        </div>
        {filtered.length === 0 && sessions.length === 0 && groups.length === 0 && shownFolders.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full px-8 text-center">
            <div className="text-text-muted mb-4 animate-ghost-boo">
              <svg className="w-12 h-12 mx-auto" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z"/>
                <circle cx="9" cy="9" r="1.5" fill="#111b21"/>
                <circle cx="15" cy="9" r="1.5" fill="#111b21"/>
              </svg>
            </div>
            <p className="text-text-secondary text-sm mb-1">{t("sidebar.quiet")}</p>
            <p className="text-text-muted text-xs">{t("sidebar.quietHint")}</p>
            {/* On a phone the chat list is the first screen, and the home pane, which says it on a wide screen, is never shown. */}
            {isMobile && (
              <button type="button" data-testid="sidebar-already" onClick={() => openJoinProfile()} className="mt-4 min-h-11 px-2 text-sm text-text-secondary underline underline-offset-4 hover:text-accent cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded">
                {t("devices.join.already")}
              </button>
            )}
          </div>
        )}

        {/* Nothing matches the search: neither a chat nor a group. */}
        {filtered.length === 0 && shownGroups.length === 0 && (sessions.length > 0 || groups.length > 0) && (
          <div className="flex items-center justify-center py-10 px-8">
            <p className="text-text-muted text-sm">{t("sidebar.noResults")}</p>
          </div>
        )}
        </>}
      </div>

      {confirmDeleteId && <DeleteChatDialog
        name={(() => { const target=sessions.find(s=>s.id===confirmDeleteId); return `${target?.label || target?.nick || t("common.unnamedContact", { key: contactTag(target?.peerPubKeyB64 ?? confirmDeleteId) })} · ${publicKeyLabel(target?.peerPubKeyB64 ?? confirmDeleteId)}`; })()}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => { const id=confirmDeleteId; deleteSession(id); setChatFolder(id, undefined); setConfirmDeleteId(null); refreshSessions(); window.dispatchEvent(new Event("session-updated")); if(activeSessionId===id) nav.home(); }} />}
      {!isMobile && <AccountBar />}

      {/* Resize Handle */}
      <div
        data-testid="sidebar-resize"
        onMouseDown={handleResizeStart}
        className="max-md:hidden absolute top-0 end-0 w-1 h-full cursor-col-resize z-10 hover:bg-accent/40 active:bg-accent/60 transition-colors"
      />
    </div>
  );
}
