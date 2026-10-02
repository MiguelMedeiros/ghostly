import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { GroupView } from "@ghostly/browser/shared/types";
import { PeerAvatar } from "./Avatar";
import { GroupAvatar } from "./GroupAvatar";
import { ContactMarks, FaceCorner } from "./identities/ContactMarks";
import { useChosenProfile, type ContactFace } from "./identities/contactFace";
import { PinIcon } from "./PinIcon";
import { DeliveryIcon } from "./chat/DeliveryStatus";
import { TypingText } from "./TypingIndicator";
import { usePeerTypingActivity } from "../hooks/useTyping";
import { BellIcon, MuteMenu } from "./ChatMute";
import { useI18n } from "../contexts/I18nContext";
import { filePreview, formatListTime, previewText } from "../lib/chatList";
import { cardLine, showsCard } from "../lib/statusCards";
import { deliveryShape, useDeliveryWords, useDhtOnly, waitsForLive, type DhtOnlyBy } from "../lib/delivery";
import { groupChat, mentionsNotify, muteEndText, useChatMute } from "../lib/chatMute";
import { authorName, groupReadAt, groupStatusText, groupUnreadAt } from "../lib/groups";
import { reactionNoteText } from "../lib/reactions";
import { errorText } from "../lib/errorText";
import type { ChatListDensity } from "../lib/settings";
import type { ChatMessage } from "../lib/types";
import { servicesPlatform } from "../lib/platform";
import { paymentLine } from "./paymentWords";
import { callEventText } from "../lib/callLines";
import type { Translate } from "../locales/translate";

/*
 * The rows of the chat list, drawn the way messengers draw theirs: the name and the time on one line, the last
 * message (with its delivery mark) and the unread count on the next. `compact` (the default) keeps the contact's
 * key out of the row — it is in the row's tooltip and the chat's header; `comfortable` gives it its own line.
 * What the chat is set to (muted, pinned) is a quiet mark just before the time, in the time's own tone; on a pointer
 * device the row's actions (mute, pin, delete) take the marks' and the time's place while it is hovered.
 */

const AVATAR = { compact: 46, comfortable: 52 } as const;
/** How long a group invitation's row says why its answer did not go. */
export const REFUSAL_SHOWN_MS = 8000;
const ROW = { compact: "min-h-[66px] py-2.5", comfortable: "min-h-[80px] py-3" } as const;

/** Where my last message is, with the chat's marks: a clock, one tick, two ticks or the red circle. */
export function DeliveryMark({ delivery, live }: { delivery?: ChatMessage["delivery"]; live?: DhtOnlyBy }) {
  const words = useDeliveryWords();
  const shape = deliveryShape(delivery);
  const state = delivery ?? "sent";
  return (
    <span role="img" data-testid="chat-row-delivery" data-delivery={state} aria-label={words.label(state, live)}
      className={`inline-flex shrink-0 align-middle -mt-0.5 ${shape === "sent" || shape === "delivered" ? "me-0.5" : "me-1"} ${shape === "failed" ? "text-danger" : shape === "delivered" ? "text-link" : "text-text-muted"}`}>
      <DeliveryIcon shape={shape} cutout="var(--color-sidebar-bg)" />
    </span>
  );
}

/** The unread count; grey in a muted chat, a quiet cue rather than a call for attention. */
function UnreadBadge({ count, muted }: { count: number; muted: boolean }) {
  return (
    <span data-testid="chat-row-unread" data-muted={muted || undefined} className={`min-w-5 h-5 inline-flex items-center justify-center rounded-full px-1.5 text-[11px] font-bold leading-none ${muted ? "bg-text-secondary text-sidebar-bg" : "bg-accent text-on-accent"}`}>
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * A quiet mark for what the chat is set to, sized like the delivery ticks. Marks sit together in `status`, before
 * the time: the per-chat mute bell goes first, then the pin.
 */
export function StatusMark({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return <span role="img" aria-label={label} data-testid={testId} className="inline-flex h-3 w-3 items-center justify-center">{children}</span>;
}

/** A muted chat's bell, first among the status marks. */
function MutedMark({ label }: { label: string }) {
  return <StatusMark label={label} testId="chat-row-muted"><BellIcon muted size={12} /></StatusMark>;
}

/** A button in the row's actions: a round target that lights up under the pointer, and in the accent while it is on. */
const rowAction = (hover = "hover:text-accent") =>
  `flex h-7 w-7 items-center justify-center rounded-full text-text-secondary transition-colors cursor-pointer hover:bg-text-primary/10 ${hover} aria-pressed:text-accent aria-expanded:bg-text-primary/10 aria-expanded:text-accent data-[muted]:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`;

/**
 * The row's actions, laid over its marks and time (RowText's `timeCover`). Pointer devices only: a phone opens the
 * chat on a tap, and mutes and pins from the chat's ⋮. Hover or keyboard focus on one of them shows them, a click's
 * leftover focus does not (else the layer would hide the new mark once the pointer leaves); an open menu keeps them up.
 * Keyboard focus elsewhere in the row (the identity marks, whose card it opens) leaves them down.
 */
function RowActions({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div data-testid="chat-row-actions" className={`max-md:hidden absolute top-1/2 end-0 flex min-w-full -translate-y-1/2 items-center justify-end gap-1 rounded-md ps-1 opacity-0 transition-opacity group-hover:opacity-100 has-[:focus-visible]:opacity-100 has-[[aria-expanded=true]]:opacity-100 ${active ? "bg-surface-hover" : "bg-surface-alt"}`}>
      {children}
    </div>
  );
}

/**
 * The row's bell: mutes the chat for a while, or, muted, says until when and turns it back on, through the chat's own
 * menu of durations. A muted chat's mark so turns into this button in place. Nothing from here reaches the row, which
 * would open the chat.
 */
function RowMute({ chat, mentions }: { chat: string; mentions?: boolean }) {
  const { t, language } = useI18n();
  const until = useChatMute(chat);
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const label = until === undefined ? t("mute.open") : until === "forever" ? t("mute.bell") : t("mute.bellUntil", { time: muteEndText(until, language) });
  const close = () => {
    // Chosen or dismissed from inside the menu (the keys): back to the bell, so the row's actions stay where the keys are.
    if (document.activeElement?.closest("[data-menu]")) button.current?.focus();
    setOpen(false);
  };
  return (
    <div ref={wrapper} className="flex" onClick={e => e.stopPropagation()}>
      <button ref={button} type="button" data-testid="chat-row-mute" data-muted={until === undefined ? undefined : until === "forever" ? "forever" : "until"}
        aria-haspopup="true" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen(o => !o)} className={rowAction()}>
        <BellIcon muted={until !== undefined} />
      </button>
      <MuteMenu chat={chat} open={open} onClose={close} anchorRef={wrapper} portal mentions={mentions} />
    </div>
  );
}

/** The two (or, comfortable, three) lines beside the avatar, shared by chats and groups. */
function RowText({ name, nameClass, marks, status, time, timeClass = "text-text-muted", sub, preview, previewId, trailing, timeCover }: {
  name: ReactNode; nameClass: string;
  /** The preview line's id: what the row's button is described by. */
  previewId?: string;
  /** After the name: the contact's verified identities (identities/ContactMarks.tsx), which give way before the time does. */
  marks?: ReactNode;
  /** Before the time: what the chat is set to (StatusMark), muted, never at the time's expense. */
  status?: ReactNode;
  time?: string; timeClass?: string; sub?: ReactNode; preview: ReactNode; trailing?: ReactNode;
  /** Laid over the marks and the time while the row is hovered: the row's actions, which so never move anything. */
  timeCover?: ReactNode;
}) {
  return (
    <div className="flex-1 min-w-0">
      <div className="contact-row relative flex items-baseline gap-2">
        <span className="flex flex-1 min-w-0 items-center gap-1.5">
          <span data-testid="chat-row-name" className={`min-w-0 truncate text-[15px] leading-5 ${nameClass}`}>{name}</span>
          {marks}
        </span>
        {(status || time || timeCover) && <span className="relative flex shrink-0 items-baseline gap-2">
          {status && <span data-testid="chat-row-status" className="flex h-5 items-center gap-1.5 self-center text-text-muted">{status}</span>}
          {time && <span data-testid="chat-row-time" className={`text-xs leading-5 ${timeClass}`}>{time}</span>}
          {timeCover}
        </span>}
      </div>
      {sub}
      <div className="mt-0.5 flex items-center gap-2">
        {/* The last message in its own direction: an English one in the Arabic app, cut at its own end. */}
        <p id={previewId} dir="auto" data-testid="chat-row-preview" className="flex-1 min-w-0 truncate m-0 text-[13px] leading-5">{preview}</p>
        {trailing && <div className="flex shrink-0 items-center gap-1.5">{trailing}</div>}
      </div>
    </div>
  );
}

/**
 * What opens the row from the keyboard: a button over the whole row, first in it, so Tab reaches every chat and group
 * and Enter or Space opens it (the click it makes is the row's own). The pointer goes through it to the row and to the
 * buttons laid over it, as before; its ring is the row's edge.
 */
function RowOpen({ label, active, describedBy, testId }: { label: string; active: boolean; describedBy: string; testId: string }) {
  return <button type="button" data-testid={testId} aria-label={label} aria-describedby={describedBy} aria-current={active ? "page" : undefined}
    className="pointer-events-none absolute inset-0 rounded-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent" />;
}

const rowClass = (active: boolean, density: ChatListDensity) =>
  `group relative flex items-center gap-3 ps-3 pe-3 cursor-pointer transition-colors ${ROW[density]} ${active ? "bg-surface-hover" : "hover:bg-surface-alt has-[:focus-visible]:bg-surface-alt has-[[aria-expanded=true]]:bg-surface-alt"}`;

export interface ChatRowProps {
  /** The chat's session id: what its mute is kept under. */
  chatId: string;
  density: ChatListDensity;
  active: boolean;
  /** What the contact goes by here (identities/contactFace.ts `shownContactName`), or the "Contact · xxxxxx" fallback when `named` is false. */
  label: string;
  /** The identity the contact is shown as: its photo on the avatar, its provider on the avatar's corner. */
  face?: ContactFace;
  named: boolean;
  /** The contact's key, shortened (both ends kept). */
  keyLabel: string;
  peerPubKey: string;
  lastMessage?: ChatMessage;
  /** Something newer than the last message, said in its place: the contact shared an identity. */
  note?: string;
  time: string;
  unread: number;
  pinned: boolean;
  syncing: boolean;
  creator: boolean;
  onOpen(): void;
  onTogglePin(): void;
  onDelete(e: React.MouseEvent): void;
  deleteLabel: string;
  /**
   * A pinned chat that can be dragged to another place among the pinned ones (hooks/useRowReorder.ts): what the row
   * listens to, whether it is the one in the hand, and the line on its edge when the dragged row would land there.
   */
  reorder?: { props: Record<string, unknown>; dragging: boolean; drop?: "before" | "after" };
}

/** A join notice as the chat's line says it (MessageBubble): mine, or the contact by the name the list shows. */
function joinPreview(p: ChatRowProps, joiner: string | undefined, t: Translate): string {
  if (joiner && joiner !== p.peerPubKey) return t("chat.youJoined");
  return `${p.named ? p.label : p.keyLabel} ${t("chat.joined")}`;
}

/**
 * A payment or a request as the list's line (paymentLine: what its bubble says, in the app's language, test sats as
 * test sats), or undefined while the wallet does not know it. Only a change of that line draws the row again.
 */
function usePaymentLine(paymentId: string | undefined, t: Translate): string | undefined {
  const subscribe = useCallback((listener: () => void) => (paymentId && servicesPlatform?.subscribe(listener)) || (() => {}), [paymentId]);
  return useSyncExternalStore(subscribe, () => {
    const wallet = paymentId ? servicesPlatform?.wallet : undefined;
    const payment = wallet?.getPayment(paymentId!);
    return payment ? paymentLine(t, payment, wallet!.getState()) : undefined;
  });
}

/** A 1:1 chat in the list. */
export function ChatRow(p: ChatRowProps) {
  const { t } = useI18n();
  const muted = useChatMute(p.chatId) !== undefined;
  const size = AVATAR[p.density];
  const pinLabel = p.pinned ? t("chat.menu.unpin") : t("chat.menu.pin");
  const typing = usePeerTypingActivity(p.peerPubKey);
  const payment = usePaymentLine(p.lastMessage?.paymentId, t);
  // A file of mine waiting in a DHT-only chat waits for a live connection, as its bubble says.
  const live = waitsForLive(p.lastMessage?.sender === "me" ? p.lastMessage : undefined, useDhtOnly(p.peerPubKey));
  const previewId = useId();
  useChosenProfile(p.peerPubKey);
  return (
    <div data-testid="chat-row" data-chat={p.chatId} data-muted={muted || undefined} data-dragging={p.reorder?.dragging || undefined} onClick={p.onOpen} title={`${p.label} · ${p.keyLabel}`} {...p.reorder?.props}
      // A row that can be dragged: a held finger moves it, so it selects no text and asks for no callout. In the hand it is over its neighbours.
      className={`${rowClass(p.active, p.density)} ${p.reorder ? "select-none [-webkit-touch-callout:none]" : ""} ${p.reorder?.dragging ? "z-20 cursor-grabbing bg-surface-hover shadow-lg transition-none" : ""}`}>
      {p.reorder?.drop && <span aria-hidden="true" data-testid="chat-row-drop" data-edge={p.reorder.drop}
        className={`pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-accent ${p.reorder.drop === "before" ? "top-0" : "bottom-0"}`} />}
      <RowOpen testId="chat-row-open" label={p.named ? p.label : `${p.label} · ${p.keyLabel}`} active={p.active} describedBy={previewId} />
      <div className={`relative shrink-0 rounded-full flex items-center justify-center ${p.active ? "bg-surface-alt" : "bg-surface-hover"}`} style={{ width: size, height: size }}>
        <PeerAvatar peerPubKey={p.peerPubKey} label={p.label} named={p.named} photo={p.face?.photo} testId="chat-row-avatar" />
        {p.face && <FaceCorner face={p.face} />}
        {p.syncing && (
          <span className="absolute -top-1 -start-1 w-5 h-5 flex items-center justify-center z-10">
            <svg className="animate-ghost-boo w-5 h-5" viewBox="0 0 64 64" aria-hidden="true">
              <g transform="translate(12, 6)">
                <path d="M20 4C10.059 4 2 12.059 2 22v18c0 1.5 1.2 2 2 1.2l4-3.2 4 3.2c.8.6 1.6.6 2.4 0L18 38l3.6 3.2c.8.6 1.6.6 2.4 0L28 38l4 3.2c.8.8 2 .3 2-1.2V22C34 12.059 25.941 4 20 4z" fill="currentColor" className="text-text-muted"/>
                <circle cx="13" cy="20" r="3" fill="currentColor" className="text-sidebar-bg"/>
                <circle cx="27" cy="20" r="3" fill="currentColor" className="text-sidebar-bg"/>
              </g>
            </svg>
          </span>
        )}
        {p.creator && (
          <span className="absolute -bottom-0.5 -end-0.5 w-4 h-4 flex items-center justify-center rounded-full bg-accent text-on-accent ring-2 ring-sidebar-bg z-10 group/star">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
            </svg>
            <span className="absolute top-1/2 -translate-y-1/2 start-full ms-2 px-2 py-1 bg-surface-alt text-text-primary text-[10px] rounded whitespace-nowrap opacity-0 group-hover/star:opacity-100 transition-opacity pointer-events-none shadow-lg border border-border">
              {t("chat.createdHere")}
            </span>
          </span>
        )}
      </div>
      <RowText
        name={<bdi>{p.label}</bdi>}
        previewId={previewId}
        marks={<ContactMarks peerKey={p.peerPubKey} />}
        nameClass={!p.named ? "text-text-muted italic" : p.unread > 0 ? "text-text-primary font-semibold" : "text-text-primary"}
        time={p.time}
        timeClass={p.unread > 0 && !muted ? "text-accent font-medium" : "text-text-muted"}
        sub={<>
          {/* The key, for whoever needs it: its own line when comfortable, else read out with the name. */}
          {p.density === "comfortable"
            ? <span data-testid="chat-row-key" className="block text-[11px] leading-4 text-text-muted font-mono whitespace-nowrap">{p.keyLabel}</span>
            : <span className="sr-only"> · {p.keyLabel}</span>}
        </>}
        // The contact writing now takes the last message's place, in the accent, until it stops or the message comes.
        preview={typing
          ? <TypingText testId="chat-row-typing" activity={typing} />
          : p.note
          ? <span data-testid="chat-row-note" className="text-text-muted">{p.note}</span>
          : p.lastMessage
          ? <span className={p.unread > 0 ? "text-text-secondary font-medium" : "text-text-muted"}>
              {p.lastMessage.sender === "me" && <DeliveryMark delivery={p.lastMessage.delivery} live={live} />}
              {p.lastMessage.systemEvent?.type === "join" ? joinPreview(p, p.lastMessage.systemEvent.pubKey, t)
                : p.lastMessage.callEvent ? callEventText(t, p.lastMessage.callEvent.type, p.lastMessage.callEvent.hasVideo) ?? p.lastMessage.text
                : showsCard(p.lastMessage.card) ? cardLine(p.lastMessage.card)
                : payment ?? filePreview(p.lastMessage.file, t) ?? previewText(p.lastMessage.text, t)}
            </span>
          : <span className="italic text-text-muted">{t("chat.noMessages")}</span>}
        status={(muted || p.pinned) && <>
          {muted && <MutedMark label={t("mute.bell")} />}
          {p.pinned && <StatusMark label={t("sidebar.pinned")} testId="chat-row-pinned"><PinIcon active size={12} /></StatusMark>}
        </>}
        trailing={p.unread > 0 && <UnreadBadge count={p.unread} muted={muted} />}
        timeCover={
          // The layer covers the marks too, so a pinned chat's mark turns into its Unpin button in place.
          <RowActions active={p.active}>
            <RowMute chat={p.chatId} />
            <button type="button" title={pinLabel} aria-label={pinLabel} aria-pressed={p.pinned} data-testid="chat-row-pin"
              onClick={e => { e.stopPropagation(); p.onTogglePin(); }} className={rowAction()}>
              <PinIcon active={p.pinned} />
            </button>
            <button type="button" onClick={p.onDelete} title={p.deleteLabel} className={rowAction("hover:text-danger")}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              </svg>
            </button>
          </RowActions>
        }
      />
    </div>
  );
}

/** A group (private or community), or an invitation to one, in the chat list. */
export function GroupRow({ group, active, density, onOpen }: { group: GroupView; active: boolean; density: ChatListDensity; onOpen(): void }) {
  const { t, language } = useI18n();
  const [busy, setBusy] = useState(false);
  const muted = useChatMute(groupChat(group.id)) !== undefined;
  const invitation = group.invitation;
  const unread = !active && !invitation && groupUnreadAt(group) > groupReadAt(group.id);
  // An unread message that names me: "@" beside the dot, in the accent unless the mute keeps mentions quiet too.
  const mention = unread && (group.lastMentionAt ?? 0) > groupReadAt(group.id);
  const mentionQuiet = muted && !mentionsNotify(groupChat(group.id));
  // Why the last answer did not go, for a few seconds: Accept needs the inviter's chat live, which takes a moment after
  // the app opens, and a click that did nothing and said nothing looked broken.
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => {
    if (!refused) return;
    const timer = setTimeout(() => setRefused(null), REFUSAL_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [refused]);
  const answer = async (method: "acceptGroupInvitation" | "declineGroupInvitation") => {
    setBusy(true);
    setRefused(null);
    try { await engine.call(method, { groupId: group.id }); } catch (error) {
      const away = /not connected/i.test(error instanceof Error ? error.message : String(error));
      setRefused(!away ? t("sidebar.group.answerFailed")
        : invitation?.contact ? t("sidebar.group.inviterAway", { contact: invitation.contact }) : t("sidebar.group.inviterAwayUnknown"));
    } finally { setBusy(false); }
  };
  const members = (count: number) => count === 1 ? t("group.chat.memberOne") : t("group.chat.memberCount", { count });
  const status = invitation ? (invitation.viaLink ? (invitation.admin ? t("group.chat.joining") : group.profile === "community" ? (invitation.stage === "answered" ? t("sidebar.group.letting") : t("sidebar.group.waitingIn")) : invitation.stage === "answered" ? t("sidebar.group.adminAnswered") : t("sidebar.group.waitingAdmin"))
      : invitation.accepted ? t("group.chat.joining") : invitation.contact ? t("sidebar.group.invitedBy", { contact: invitation.contact, members: members(invitation.members) }) : t("sidebar.group.invitedByUnknown", { members: members(invitation.members) }))
    : group.status !== "active" ? (group.statusReason ? errorText(group.statusReason, t) : group.status && groupStatusText(group.status, t)) : members(group.members.length);
  // The latest reaction, while nothing was said after it (WISP 400 § Reactions).
  const reacted = !invitation && group.status === "active" && group.lastReaction && group.lastReaction.at > group.lastMessageAt ? group.lastReaction : undefined;
  const note = reacted && reactionNoteText(reacted, authorName(group, reacted.by, t), t);
  const previewId = useId();
  const size = AVATAR[density];
  return (
    <div data-testid="group-row" data-group={group.id} data-muted={muted || undefined} onClick={onOpen} title={group.name || t("group.chat.unnamed")} className={rowClass(active, density)}>
      <RowOpen testId="group-row-open" label={group.name || t("group.chat.unnamed")} active={active} describedBy={previewId} />
      <div className="relative shrink-0">
        <GroupAvatar picture={group.picture} size={size} glyph={Math.round(size * 0.46)} testId="group-row-avatar" className={active ? "bg-surface-alt" : "bg-surface-hover"} />
      </div>
      <div className="flex-1 min-w-0">
        <RowText
          name={group.name || t("group.chat.unnamed")}
          previewId={previewId}
          nameClass={unread ? "text-text-primary font-semibold" : "text-text-primary"}
          time={group.lastMessageAt > 0 ? formatListTime(group.lastMessageAt, undefined, language, t) : undefined}
          timeClass={unread && !muted ? "text-accent font-medium" : "text-text-muted"}
          status={muted && <MutedMark label={t("mute.bell")} />}
          timeCover={!invitation && <RowActions active={active}><RowMute chat={groupChat(group.id)} mentions /></RowActions>}
          preview={note ? <span data-testid="group-row-note" className="text-text-muted">{note}</span> : <span className="text-text-muted">{status}</span>}
          trailing={unread && <span className="flex items-center gap-1.5">
            {mention && <span data-testid="group-row-mention" data-muted={mentionQuiet || undefined} aria-label={t("mentions.unread")} title={t("mentions.unread")} role="img"
              className={`flex h-5 w-5 items-center justify-center rounded-full text-[12px] font-bold leading-none ${mentionQuiet ? "bg-text-secondary text-sidebar-bg" : "bg-accent text-on-accent"}`}>@</span>}
            <span data-testid="group-row-unread" data-muted={muted || undefined} aria-label={t("sidebar.unread")} role="img" className={`w-2.5 h-2.5 rounded-full ${muted ? "bg-text-secondary" : "bg-accent"}`} />
          </span>}
        />
        {invitation && !invitation.accepted && <div className="mt-1.5 flex gap-2">
          <button disabled={busy} data-testid="group-accept" onClick={e => { e.stopPropagation(); void answer("acceptGroupInvitation"); }} className="rounded-lg bg-accent px-3 py-1 text-xs font-semibold text-panel-header hover:bg-accent-hover disabled:opacity-40">{t("chat.file.accept")}</button>
          <button disabled={busy} data-testid="group-decline" onClick={e => { e.stopPropagation(); void answer("declineGroupInvitation"); }} className="rounded-lg px-3 py-1 text-xs text-text-secondary hover:bg-surface-hover disabled:opacity-40">{t("chat.file.decline")}</button>
        </div>}
        {invitation && refused && <p role="status" data-testid="group-answer-refused" className="mt-1 text-xs text-danger">{refused}</p>}
      </div>
    </div>
  );
}
