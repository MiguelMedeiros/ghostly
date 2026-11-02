import { forwardRef, memo, useCallback, useRef, type ReactNode } from "react";
import type { GroupView } from "@ghostly/browser/shared/types";
import { PeerAvatar } from "./Avatar";
import { GroupAvatar } from "./GroupAvatar";
import { invitationStatus, invitationWaitsForMe } from "./GroupInvitation";
import { useI18n } from "../contexts/I18nContext";
import { groupChat, mentionsNotify, useChatMute } from "../lib/chatMute";
import { groupReadAt, groupUnreadAt } from "../lib/groups";
import { sameValue } from "../lib/sameValue";
import { RAIL_SHORTCUT, railShortcutLabel } from "../hooks/useRailShortcut";

/*
 * The chat list folded to a rail (a wide window only): each chat's and group's picture, in the list's order, with its
 * unread count, its name in the tooltip. A click opens the chat and leaves the rail as it is; the button at its top, or
 * the shortcut, unfolds the list again. Under that button, the list's ways as icons: New chat, Join, and Saved and
 * Tasks while the list shows them. Settings → `chatListCollapsed` keeps the choice on this device.
 */

/** The rail's width: a picture and its margins. */
export const RAIL_WIDTH = 72;
const AVATAR = 46;

/** The panel icon: its bar at the list's side, the arrow folding toward it (`collapse`) or away. Mirrored right to left. */
function PanelIcon({ collapse }: { collapse: boolean }) {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="rtl:-scale-x-100">
      <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16" /><path d={collapse ? "m16 10-2 2 2 2" : "m14 10 2 2-2 2"} />
    </svg>
  );
}

/** Folds the list (`collapsed` false) or unfolds it: one button in either place, which says which it does. */
export const RailToggle = forwardRef<HTMLButtonElement, { collapsed: boolean; onToggle(): void }>(function RailToggle({ collapsed, onToggle }, ref) {
  const { t } = useI18n();
  const label = collapsed ? t("sidebar.rail.expand") : t("sidebar.rail.collapse");
  return (
    <button ref={ref} type="button" data-testid="chat-list-toggle" onClick={onToggle} aria-expanded={!collapsed} aria-keyshortcuts={RAIL_SHORTCUT}
      aria-label={label} title={t("sidebar.rail.title", { action: label, keys: railShortcutLabel() })}
      className="inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <PanelIcon collapse={!collapsed} />
    </button>
  );
});

/**
 * A way the full list offers in its header or above its rows (New chat, Join, Saved, Tasks), as an icon at the rail's
 * top: its name in the tooltip, a count on its corner where the list's row says one.
 */
export function RailAction({ testId, label, title = label, accent, active, count, onClick, children }: {
  testId: string; label: string; title?: string; accent?: boolean; active?: boolean; count?: number; onClick(): void; children: ReactNode;
}) {
  return (
    <button type="button" data-testid={testId} onClick={onClick} title={title} aria-label={label} aria-current={active ? "page" : undefined}
      className="group flex h-12 w-full shrink-0 items-center justify-center cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent">
      <span className={`relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${accent ? "bg-accent text-panel-header group-hover:bg-accent-hover"
        : active ? "bg-surface-hover text-text-primary" : "text-text-secondary group-hover:bg-surface-hover group-hover:text-text-primary"}`}>
        {children}
        {!!count && <span aria-hidden="true" data-testid={`${testId}-count`} className={`absolute -top-1 -end-1 min-w-5 h-5 inline-flex items-center justify-center rounded-full px-1 text-[11px] font-bold leading-none ${badge(false)}`}>{count > 99 ? "99+" : count}</span>}
      </span>
    </button>
  );
}

/** One place on the rail: the picture as a button, the unread mark on its corner, the open chat marked at its side. */
function RailItem({ testId, id, name, label, active, onOpen, mark, children }: {
  testId: string; id: string; name: string; label: string; active: boolean; onOpen(): void; mark?: ReactNode; children: ReactNode;
}) {
  return (
    <button type="button" data-testid={testId} data-chat={id} onClick={onOpen} title={name} aria-label={label} aria-current={active ? "page" : undefined}
      className="group relative flex h-14 w-full shrink-0 items-center justify-center cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent">
      {/* The open chat: a bar at the list's edge, as the row's own colour says it in the list. */}
      {active && <span aria-hidden="true" data-testid="chat-rail-active" className="absolute inset-y-2 start-0 w-1 rounded-e-full bg-accent" />}
      <span className={`relative flex shrink-0 items-center justify-center rounded-full transition-colors ${active ? "bg-surface-alt ring-2 ring-accent" : "bg-surface-hover group-hover:ring-2 group-hover:ring-text-primary/15"}`} style={{ width: AVATAR, height: AVATAR }}>
        {children}
        {mark && <span className="absolute -top-1 -end-1 z-10 flex">{mark}</span>}
      </span>
    </button>
  );
}

const badge = (muted: boolean) => `ring-2 ring-sidebar-bg ${muted ? "bg-text-secondary text-sidebar-bg" : "bg-accent text-on-accent"}`;

/** The latest `onOpen` given, as one function: a place on the rail is not drawn again for a new one (`ChatRow`). */
function useLatestOpen(onOpen: () => void): () => void {
  const latest = useRef(onOpen);
  latest.current = onOpen;
  return useCallback(() => latest.current(), []);
}

interface RailChatProps { chatId: string; name: string; named: boolean; peerPubKey: string; photo?: string; unread: number; active: boolean; onOpen(): void }

/**
 * A 1:1 chat on the rail. Drawn again only when what it shows changes, as a chat's row in the list is (`ChatRow`): the
 * rail is drawn again on every engine state and every time it reads the chats again.
 */
export function RailChat(props: RailChatProps) {
  return <SameRailChat {...props} onOpen={useLatestOpen(props.onOpen)} />;
}

/** Its unread count on the picture's corner, grey in a muted chat as in the list. */
const SameRailChat = memo(function SameRailChat({ chatId, name, named, peerPubKey, photo, unread, active, onOpen }: RailChatProps) {
  const { t } = useI18n();
  const muted = useChatMute(chatId) !== undefined;
  const label = unread === 0 ? name : unread === 1 ? t("sidebar.rail.unreadOne", { name }) : t("sidebar.rail.unreadCount", { name, count: unread });
  return (
    <RailItem testId="chat-rail-chat" id={chatId} name={name} label={label} active={active} onOpen={onOpen}
      mark={unread > 0 && <span aria-hidden="true" data-testid="chat-rail-unread" data-muted={muted || undefined}
        className={`min-w-5 h-5 inline-flex items-center justify-center rounded-full px-1 text-[11px] font-bold leading-none ${badge(muted)}`}>{unread > 99 ? "99+" : unread}</span>}>
      <PeerAvatar peerPubKey={peerPubKey} label={name} named={named} photo={photo} testId="chat-rail-avatar" />
    </RailItem>
  );
}, sameValue);

/** A group on the rail, drawn again only when what it shows changes (`GroupRow`): when it was read is taken here, at each draw of the rail. */
export function RailGroup({ group, active, onOpen }: { group: GroupView; active: boolean; onOpen(): void }) {
  return <SameRailGroup group={group} active={active} readAt={groupReadAt(group.id)} onOpen={useLatestOpen(onOpen)} />;
}

/**
 * The list's unread dot on the picture's corner (a group counts no messages); an unread mention its "@" instead, grey in
 * a muted group only when the mute keeps mentions quiet too (`GroupRow`). An invitation has its own mark, in the accent
 * while its row waits for my answer, and its label says what it waits for, as the row's line does.
 */
const SameRailGroup = memo(function SameRailGroup({ group, active, readAt, onOpen }: { group: GroupView; active: boolean; readAt: number; onOpen(): void }) {
  const { t } = useI18n();
  const muted = useChatMute(groupChat(group.id)) !== undefined;
  const name = group.name || t("group.chat.unnamed");
  const invitation = group.invitation;
  const unread = !active && !invitation && groupUnreadAt(group) > readAt;
  const mention = unread && (group.lastMentionAt ?? 0) > readAt;
  const mentionQuiet = muted && !mentionsNotify(groupChat(group.id));
  const label = invitation ? t("sidebar.rail.invitation", { name, status: invitationStatus(group, t) })
    : mention ? t("sidebar.rail.mention", { name }) : unread ? t("sidebar.rail.unread", { name }) : name;
  const waiting = invitation && !invitationWaitsForMe(invitation);
  const mark = invitation ? <span aria-hidden="true" data-testid="chat-rail-invitation" data-muted={waiting || undefined}
      className={`h-5 w-5 inline-flex items-center justify-center rounded-full ${badge(!!waiting)}`}><EnvelopeIcon /></span>
    : mention ? <span aria-hidden="true" data-testid="chat-rail-mention" data-muted={mentionQuiet || undefined}
      className={`h-5 w-5 inline-flex items-center justify-center rounded-full text-[12px] font-bold leading-none ${badge(mentionQuiet)}`}>@</span>
    : unread && <span aria-hidden="true" data-testid="chat-rail-unread" data-muted={muted || undefined} className={`h-3 w-3 rounded-full ${badge(muted)}`} />;
  return (
    <RailItem testId="chat-rail-group" id={groupChat(group.id)} name={name} label={label} active={active} onOpen={onOpen} mark={mark}>
      <GroupAvatar picture={group.picture} size={AVATAR} testId="chat-rail-avatar" className={active ? "bg-surface-alt" : "bg-surface-hover"} />
    </RailItem>
  );
}, sameValue);

/** An invitation's mark: a small envelope. */
function EnvelopeIcon() {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" />
    </svg>
  );
}
