import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CueChat } from "../lib/cues";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { engine } from "@ghostly/browser/platform/engine";
import type { EngineState, GroupJoinStage, GroupPayNote, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../components/MessageBubble";
import { MessageInput } from "../components/MessageInput";
import { JumpToLatest } from "../components/chat/JumpToLatest";
import { leftOn, leftScrolledUp, useChatScroll } from "../hooks/useChatScroll";
import { useRowWindow } from "../hooks/useRowWindow";
import { GroupMembersDialog } from "../components/GroupMembersDialog";
import { DeleteChatDialog } from "../components/DeleteChatDialog";
import { LeaveGroupDialog } from "../components/LeaveGroupDialog";
import { GroupShareDialog } from "../components/GroupLinkPanel";
import { GroupConnection } from "../components/GroupConnection";
import { TasksButton } from "../components/chat/TasksButton";
import { RoutineStack } from "../components/chat/RoutineCard";
import type { MemberFaceOf } from "../components/chat/SenderAvatar";
import { routineStacks } from "../lib/statusCards";
import { GroupPaymentComposer } from "../components/GroupPaymentComposer";
import { GroupPaymentCaption, GroupPaymentNote } from "../components/GroupPaymentNote";
import { Menu, MenuItem, MenuSeparator } from "../components/Menu";
import { MuteMenu, MuteMenuItem } from "../components/ChatMute";
import { forgetChatMute, groupChat } from "../lib/chatMute";
import { useI18n, type Translate } from "../contexts/I18nContext";
import { authorName, groupStatusText, markGroupRead, memberName, memberPhoto } from "../lib/groups";
import { authorsOf, type MessageAuthor } from "../lib/senderRuns";
import { MemberColorsProvider } from "../contexts/MemberColorsContext";
import { chatsByPeer } from "../lib/identities";
import { useContactFaces, withContactFaces } from "../components/identities/contactFace";
import type { ChatMessage } from "../lib/types";
import { useSettings } from "../contexts/SettingsContext";
import { GroupAvatar } from "../components/GroupAvatar";
import { AvatarViewer } from "../components/AvatarViewer";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { useGroupTypingSender } from "../hooks/useTyping";
import { GroupTypingText, type GroupTyper } from "../components/TypingIndicator";
import { navOnly } from "../lib/navigation";
import { mentionViews, type MentionCandidate } from "../lib/parse/mentions";
import { COMMUNITY_LIMITS, GROUP_LIMITS, mayPin, replySnippet, type GroupMention, type RoutineCard } from "@ghostly/core";
import { messageSnippet, quoteFor, replyIndex, replyTarget, type NameOf, type QuoteView } from "../lib/replies";
import { buttonsViews, compactPresses } from "../lib/buttons";
import { useForwarding } from "../hooks/useForwarding";
import { useChatSearch } from "../hooks/useChatSearch";
import { ChatSearchBar, SearchIcon } from "../components/chat/ChatSearch";
import { PinnedBar } from "../components/chat/PinnedBar";
import { MessageAnnouncer } from "../components/chat/MessageAnnouncer";
import { canEditInGroup } from "@ghostly/browser/shared/edits";
import { paymentWireId } from "@ghostly/browser/shared/paymentIds";
import { replyRef } from "@ghostly/browser/shared/replies";
import { errorText } from "../lib/errorText";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;

/** `myName`: how a mention of me reads (my own name, as a member sees it); the others go by the roster's names. */
function toChatMessage(message: StoredMessage, group: GroupView, t: Translate, myName = ""): ChatMessage {
  const names = group.members.map(m => ({ key: m.key, me: m.me, name: m.me ? myName : memberName(m, t) }));
  const mentions = mentionViews(message.text, message.mentions, names, message.sender === "me");
  return { id: message.id, text: message.text, sender: message.sender, timestamp: message.timestamp, paymentId: message.paymentId,
    nick: message.sender === "peer" && message.member ? authorName(group, message.member, t) : undefined,
    ...(mentions.length ? { mentions } : {}), ...(message.replyTo && { replyTo: message.replyTo }), ...(message.reactions && { reactions: message.reactions }),
    ...(message.edit && { edit: message.edit }), ...(message.forwarded && { forwarded: message.forwarded }), ...(message.card && { card: message.card }) };
}

/** A member as a reply's quote names them: me, the roster's name, or for a key no longer in the roster its former name or its start. */
const replyNames = (group: GroupView, you: string, t: Translate): NameOf => (from, key) => {
  if (from === "me") return you;
  const member = key ? group.members.find(m => m.key === key) : undefined;
  return member?.me ? you : key ? authorName(group, key, t) : undefined;
};

/** Whom "@" offers in the composer: every other member, by name and the end of their key. */
function mentionCandidates(group: GroupView, t: Translate): MentionCandidate[] {
  return group.members.filter(m => !m.me).map(m => ({ key: m.key, name: memberName(m, t), tag: `…${m.key.slice(-6)}` }));
}

/** The group note a payment of this device is part of: a request's own, or the request a payment answers (by its id on the wire). */
function noteIdOf(state: EngineState, paymentId: string): string {
  const payment = state.payments[paymentId];
  return paymentWireId(payment?.kind === "payment" && payment.requestId ? payment.requestId : paymentId);
}

/**
 * The note that captions a payment bubble: the one about that bubble's own payment, which the member who started it
 * says (the payee of a request, the payer of a payment), never a note of another member that reuses its id.
 */
function captionOf(state: EngineState, notes: ReadonlyMap<string, GroupPayNote>, message: StoredMessage, myKey: string | undefined): GroupPayNote | undefined {
  const payment = state.payments[message.paymentId!];
  // Said once, under the request (or the payment) itself: not again under a payment that answers it.
  if (payment?.kind === "payment" && payment.requestId) return undefined;
  const note = notes.get(noteIdOf(state, message.paymentId!));
  const starter = message.sender === "me" ? myKey : message.member;
  return note && starter && (note.kind === "request" ? note.to : note.from) === starter ? note : undefined;
}

/** What the engine writes after "Group created. " and "You joined. ": who can read what (GROUP_READ_NOTE), in the interface's words. */
const readNote = (group: GroupView, t: Translate) => group.profile === "community"
  ? t("group.readNoteCommunity", { count: COMMUNITY_LIMITS.store }) : t("group.readNote", { count: GROUP_LIMITS.relay });

/** The engine's words for a line with no member to name (engine/groups.ts, engine/community.ts), said again in the interface's. */
const FIXED_EVENTS = new Map([
  ["Keys rotated: a fresh epoch", "rotated"],
  ["You were removed from this group", "removed"],
  ["The membership history forked", "forked"],
] as const);

/** The lines that name their member, said again from their kind: those of a member who has left too. */
const FORMER_EVENTS = new Set<StoredMessage["event"]>(["joined", "admin", "picture", "renamed"]);

/**
 * A membership line, naming its member as the roster knows them now; what was stored, when they are gone. The engine
 * stores it in English: the line is said again in the interface's language from its kind, where the stored text has
 * the shape the engine writes. Any other text (a reason the core gave) is shown as it is.
 */
function eventText(message: StoredMessage, group: GroupView, t: Translate): string {
  const member = message.member ? group.members.find(m => m.key === message.member) : undefined;
  const text = message.text;
  // A member who has left since: a private group still knows the name they had (`formerNames`), so their lines are
  // said in the interface's language too. A community keeps no former names: its stored line stays as it is.
  const former = !member && !!message.member && group.profile !== "community" && FORMER_EVENTS.has(message.event);
  if (!member && !former) {
    if (message.event === "created" && text.startsWith("Group created. ")) return `${t("group.event.created")} ${readNote(group, t)}`;
    if (message.event === "joined" && !message.member && text.startsWith("You joined. ")) return `${t("group.event.youJoined")} ${readNote(group, t)}`;
    const gone = " is no longer a member";
    if (message.event === "gone" && text.endsWith(gone)) return t("group.event.gone", { name: text.slice(0, -gone.length) });
    const fixed = (FIXED_EVENTS as Map<string, string>).get(text);
    return fixed === "rotated" ? t("group.event.rotated") : fixed === "removed" ? t("group.event.removed") : fixed === "forked" ? t("group.event.forked") : text;
  }
  const name = member ? memberName(member, t) : authorName(group, message.member!, t);
  if (message.event === "joined") return t("group.event.joined", { name });
  if (message.event === "admin") return member?.me ? t("group.event.adminYou") : t("group.event.admin", { name });
  if (message.event === "picture") {
    const removed = text.endsWith("removed the group's picture");
    if (member?.me) return removed ? t("group.event.pictureRemovedYou") : t("group.event.pictureChangedYou");
    return removed ? t("group.event.pictureRemoved", { name }) : t("group.event.pictureChanged", { name });
  }
  const marker = " renamed the group to “";
  const renamed = message.event === "renamed" ? text.indexOf(marker) : -1;
  if (renamed >= 0 && text.endsWith("”")) {
    const group = text.slice(renamed + marker.length, -1);
    return member?.me ? t("group.event.renamedYou", { group }) : t("group.event.renamed", { name, group });
  }
  return text;
}

/**
 * A join through a link, step by step: what the joiner's app knows so far, never more. In a community
 * any member's app answers. The last step ("in", connecting to the members) starts once let in; this
 * screen gives way to the chat when it does, with a notice until someone is reached.
 */
type JoinStep = GroupJoinStage | "in";
const joinSteps = (community: boolean, t: Translate): { stage: JoinStep; label: string }[] => [
  { stage: "knocked", label: community ? t("group.join.step.knockedCommunity") : t("group.join.step.knocked") },
  { stage: "answered", label: community ? t("group.join.step.answeredCommunity") : t("group.join.step.answered") },
  { stage: "admitted", label: t("group.join.step.admitted") },
  { stage: "in", label: community ? t("group.join.step.inCommunity") : t("group.join.step.in") },
];
/** How long after joining a group with nobody reached yet says it is still connecting (later, they are simply away). */
const JUST_JOINED_MS = 5 * 60_000;
/**
 * A knock nobody answered for this long: the link may have been replaced since it was shared (a replaced link reaches
 * nobody, and nothing tells the joiner so: WISP 9xx), or every app that could answer is closed. The joiner is told both.
 */
const LONG_KNOCK_MS = 2 * 60_000;
const NO_MESSAGES: StoredMessage[] = [];

/** True once `ms` have passed since `since` (none: never), re-rendering when they do. */
function usePast(since: number | undefined, ms: number): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    if (since === undefined) { setPast(false); return; }
    const left = since + ms - Date.now();
    setPast(left <= 0);
    if (left <= 0) return;
    const timer = setTimeout(() => setPast(true), left);
    return () => clearTimeout(timer);
  }, [since, ms]);
  return past;
}
const JOIN_ORDER: JoinStep[] = ["knocking", "knocked", "answered", "admitted", "in"];

function joiningText(stage: GroupJoinStage, name: string, community: boolean, t: Translate): { title: string; body: string } {
  const waiting = t("group.join.waiting");
  if (stage === "admitted") return { title: name ? t("group.join.joiningName", { name }) : t("group.join.joiningGroup"),
    body: community ? t("group.join.admittedCommunity") : t("group.join.admitted") };
  if (stage === "answered") return { title: community ? t("group.join.answeredTitleCommunity") : waiting,
    body: community ? t("group.join.answeredCommunity") : t("group.join.answered") };
  if (stage === "knocked") return { title: waiting, body: community ? t("group.join.knockedCommunity") : t("group.join.knocked") };
  return { title: waiting, body: community ? t("group.join.knockingCommunity") : t("group.join.knocking") };
}

/** One private group: its members and roles behind the header, its history, and the composer. */
export function GroupChat() {
  const { groupId = "" } = useParams();
  const navigate = useNavigate();
  const nav = useAppNavigation();
  const { t } = useI18n();
  const state = useSyncExternalStore(subscribe, snapshot);
  // Members who are contacts go by the identity they are shown as, if one was chosen (identities/contactFace.ts).
  const faceOf = useContactFaces();
  const rosterGroup = state?.groups.find(g => g.id === groupId);
  const group = useMemo(() => {
    if (!rosterGroup) return undefined;
    const chats = chatsByPeer();
    return withContactFaces(rosterGroup, state?.links, faceOf, peerKey => chats.get(peerKey)?.label);
  }, [rosterGroup, state?.links, faceOf]);
  // The history of this group only: the page stays mounted from one group to the next, and for the render that changes
  // groups the last one's messages would still be here (the timeline would open on them, and never find where this
  // group was left). Until this group's own list comes, what the engine last sent for it.
  const [loaded, setLoaded] = useState<{ groupId: string; list: StoredMessage[] }>({ groupId: "", list: NO_MESSAGES });
  const messages = loaded.groupId === groupId ? loaded.list : engine.messages.get(`group:${groupId}`) ?? NO_MESSAGES;
  /** The message the composer answers (WISP 9xx § Replies). */
  const [replyingTo, setReplyingTo] = useState<StoredMessage | null>(null);
  /**
   * The reply as it is when a message goes, not as a render's closure saw it: the composer sends what was queued one
   * after the other, and only the first of them after Reply carries it.
   */
  const replyingRef = useRef(replyingTo);
  replyingRef.current = replyingTo;
  /** The message of mine the composer edits (WISP 9xx § Edits). */
  const [editing, setEditing] = useState<StoredMessage | null>(null);
  useEffect(() => { setReplyingTo(null); setEditing(null); }, [groupId]);
  const quoteIndex = useMemo(() => replyIndex(messages, true), [messages]);
  // A bot's buttons (WISP 4xx · Message Buttons): which one was chosen, and whether I may still press, from my replies.
  const buttonsOf = useMemo(() => buttonsViews(messages, m => replyRef(m, true)), [messages]);
  const presses = useMemo(() => compactPresses(messages, m => replyRef(m, true)), [messages]);
  const [showMembers, setShowMembers] = useState(false);
  /** The member whose name or picture above a message opened the members, marked there. */
  const [focusMember, setFocusMember] = useState<string>();
  /** The group's picture, large (AvatarViewer.tsx), and the header's avatar that opened it. */
  const [viewingPicture, setViewingPicture] = useState(false);
  const avatarButton = useRef<HTMLButtonElement>(null);
  if (viewingPicture && !group?.picture) setViewingPicture(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showMute, setShowMute] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  // A new group opens on its link (the sidebar says so in the navigation's state); the header's Share link opens it again.
  const location = useLocation();
  const [sharing, setSharing] = useState<"" | "created" | "share">("");
  useEffect(() => {
    if ((location.state as { share?: string } | null)?.share !== "created") return;
    setSharing("created");
    navigate(location.pathname, { replace: true, state: navOnly(location.state) });
  }, [location.state, location.pathname, navigate]);
  const [error, setError] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const { settings } = useSettings();
  // Forward, and Select then Forward (WISP 400 § Forwards): a group's texts, to chats and other groups.
  const shown = useMemo(() => group ? messages.filter(m => !m.event && !m.groupPay).map(m => toChatMessage(m, group, t, settings.defaultNickname)) : [],
    [messages, group, settings.defaultNickname, t]);
  const forwarding = useForwarding(group ? `group:${groupId}` : undefined, shown);
  // By id: a row looks its message up once per draw, and a long group has thousands of rows.
  const shownById = useMemo(() => new Map(shown.map(c => [c.id, c])), [shown]);
  const shownOf = (m: StoredMessage) => shownById.get(m.id) ?? toChatMessage(m, group!, t, settings.defaultNickname);
  // Members learn my name on the edges, as a contact does on a chat: the engine must know it here too.
  const engineNick = state?.settings.nick;
  useEffect(() => {
    const nick = settings.defaultNickname;
    if (engineNick !== undefined && engineNick !== nick) void engine.call("updateSettings", { settings: { nick } }).catch(() => {});
  }, [settings.defaultNickname, engineNick]);
  const closeMenu = () => setMenuOpen(false);

  useEffect(() => {
    if (!groupId) return;
    let current = true;
    let whole = false;
    const show = (list: StoredMessage[]) => { if (current) { whole = true; setLoaded({ groupId, list }); } };
    // Its newest page first, straight from the store's index: a long group shows before its whole history is read, and
    // the rest comes in above it, into the page as the view goes up (useRowWindow). Not when the engine already sent this group's history, nor when the
    // group opens on a message further up, which must be there when it opens.
    const linkId = `group:${groupId}`;
    if (!engine.messages.has(linkId) && !leftScrolledUp(groupId)) {
      void engine.call("messagePage", { linkId }).then(page => { if (current && !whole) setLoaded({ groupId, list: page.messages }); }).catch(() => {});
    }
    void engine.call("groupMessages", { groupId }).then(show).catch(() => {});
    const off = engine.onMessages((linkId, list) => { if (linkId === `group:${groupId}`) show(list); });
    // Its list stops following once this group is left: coming back, the engine's copy (with what came meanwhile) is shown.
    return () => { current = false; off(); setLoaded({ groupId: "", list: NO_MESSAGES }); };
  }, [groupId]);
  // A bot's routines in a row: one row, opened on a tap (WISP 4xx · Status Cards), whichever of its rows are in the page.
  const stacks = useMemo(() => routineStacks(messages, m => m), [messages]);
  const stackHeads = useMemo(() => new Map([...stacks.values()].flatMap(run => run.slice(1).map(m => [m.id, run[0].id] as const))), [stacks]);
  // A long group has a window of its rows in the page, never the whole history (useRowWindow, see Chat.tsx).
  const rowIds = useMemo(() => messages.map(m => m.id), [messages]);
  const rowWindow = useRowWindow(rowIds, groupId ?? "", { opensOn: leftOn(groupId ?? ""), heads: stackHeads });
  // At the bottom a new message keeps the view there; scrolled up, nothing moves it and the ↓ pill counts the members'.
  // Always every message, in the page or not; a new list when the window moves (see Chat.tsx).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the window's edges: see above
  const scrollRows = useMemo(() => messages.filter(m => !m.event && !m.groupPay).map(m => ({ id: m.id, mine: m.sender === "me" })), [messages, rowWindow.from, rowWindow.to]);
  const jump = useChatScroll({ rows: scrollRows, chat: groupId, window: rowWindow });
  const search = useChatSearch({ messages: shown, chat: groupId, active: !!group && !group.invitation?.viaLink });
  useEffect(() => { if (group) markGroupRead(group.id, Math.max(group.lastMessageAt, Date.now())); }, [group?.id, group?.lastMessageAt, group]);

  const send = useCallback(async (text: string, mentions?: GroupMention[]): Promise<string | null> => {
    const answering = replyingRef.current;
    try {
      const { error } = await engine.call("sendGroupMessage", { groupId, text, ...(mentions?.length && { mentions }), ...(answering && { replyTo: answering.id }) });
      if (!error && answering) {
        if (replyingRef.current === answering) replyingRef.current = null;
        setReplyingTo(current => current === answering ? null : current);
      }
      return error;
    }
    catch (e) { return e instanceof Error ? errorText(e, t) : t("group.chat.sendFailed"); }
  }, [groupId, t]);

  // Typing (WISP 9xx · Group Mesh § Typing): private groups only; a community does not carry it yet.
  const onTyping = useGroupTypingSender(rosterGroup?.profile === "mesh" && rosterGroup.status === "active" ? groupId : undefined);
  const typers = useMemo(() => (group?.typing ?? []).map(({ key, kind, status }): GroupTyper => {
    const member = group!.members.find(m => m.key === key);
    return { key, name: member ? memberName(member, t) : t("group.member.unnamed", { key: key.slice(0, 8) }), ...(kind ? { kind } : {}), ...(status ? { status } : {}) };
  }), [group, t]);

  // "@everyone": a private group's admin only; a community has no everyone (WISP 9xx § Mentions).
  const mentions = useMemo(() => group ? { candidates: mentionCandidates(group, t), everyone: group.profile === "mesh" && group.isAdmin } : undefined, [group, t]);

  // Still knocking through a link after a while: the link may have been replaced (said under the steps).
  const knock = rosterGroup?.invitation?.viaLink ? rosterGroup.invitation.stage ?? (rosterGroup.invitation.admin ? "admitted" : "knocked") : undefined;
  const knockedLong = usePast(knock === "knocked" ? rosterGroup!.createdAt : undefined, LONG_KNOCK_MS);
  if (!state) return null;
  if (!group) return <div className="flex flex-1 items-center justify-center text-sm text-text-muted">{t("group.chat.gone")}</div>;
  const nameOf = replyNames(group, t("chat.reply.you"), t);
  const quoteOf = (m: StoredMessage): QuoteView | undefined => m.replyTo && quoteFor(m.replyTo, quoteIndex, nameOf);
  // Reactions (WISP 9xx § Reactions): one per member per message, named by the roster.
  const react = (messageId: string, emoji: string) => { void engine.call("react", { linkId: `group:${groupId}`, messageId, emoji }).catch(() => {}); };
  const reactionName = (by: string) => nameOf("peer", by) ?? by.slice(0, 8);
  // The pinned message (WISP 400 § Pinned message): any member of a private group pins, only the admin of a community.
  const canPin = group.canSend && !!group.myKey && mayPin(group.profile, group.myKey, group.members.find(m => m.role === "admin")?.key);
  const pinMessage = (messageId: string | undefined, remove = false) => { void engine.call("pinMessage", { linkId: `group:${groupId}`, messageId, remove }).catch(() => {}); };

  const others = group.members.filter(m => !m.me);
  const reachable = others.filter(m => m.online).length;
  // Payments: this device's own bubbles (from the desk, over an edge) and the notes the group shares about them.
  const notes = new Map<string, GroupPayNote>(messages.filter(m => m.groupPay).map(m => [m.groupPay!.id, m.groupPay!]));
  // A note is left out of the timeline only when one of these bubbles is about it: its own caption, or a payment answering it.
  const ownNotes = new Set(messages.filter(m => m.paymentId && !m.groupPay && (captionOf(state, notes, m, group.myKey) || state.payments[m.paymentId]?.requestId))
    .map(m => noteIdOf(state, m.paymentId!)));
  // Who wrote each member's message (their colour, their picture once per run): see `authorsOf`.
  // A bot's routines folded into one row count as one message of the run (the rest are under it, drawn when it opens).
  const folded = stackHeads;
  const authors = authorsOf(messages.filter(m => !folded.has(m.id)), group, ownNotes, key => memberPhoto(group, { key, me: false }, state.links, faceOf));
  /** A member's face in the Tasks panel, as their messages show it (`authorsOf`); none for my own cards ("me"). */
  const memberFace = (key: string): MemberFaceOf | undefined => key === "me" ? undefined : {
    key, name: group.members.find(x => x.key === key)?.nick || group.formerNames?.[key] || "",
    picture: memberPhoto(group, { key, me: false }, state.links, faceOf),
  };
  /** `inStack`: a message inside a folded row, as that row's writer, its picture beside the stack's last one. */
  const authorProps = (m: StoredMessage, inStack?: MessageAuthor) => {
    const author = inStack ?? authors.get(m.id);
    if (!author) return {};
    const inRoster = group.members.some(x => x.key === author.key);
    return { author, ...(inRoster && { onOpenAuthor: () => { setFocusMember(author.key); setShowMembers(true); } }) };
  };
  const peerOf = (paymentId: string) => { const linkId = state.payments[paymentId]?.linkId; return state.edges?.find(l => l.id === linkId)?.peerPubKeyZ32 ?? ""; };
  // A row of the timeline: an event, a payment's note, or a message.
  const row = (m: StoredMessage, inStack?: MessageAuthor) => m.event
    ? <div key={m.id} data-testid="group-event" className="flex justify-center mb-3.5 px-6"><span className="rounded-lg bg-surface-alt/90 px-3 py-1.5 text-center text-[11px] text-text-muted">{eventText(m, group, t)}</span></div>
    // A note about a payment this device is part of is shown under its own bubble instead.
    : m.groupPay ? (ownNotes.has(m.groupPay.id) ? null : <GroupPaymentNote key={m.id} note={m.groupPay} group={group} />)
    : m.paymentId ? <div key={m.id} data-testid="group-payment">
      <MessageBubble message={shownOf(m)} peerAck={Number.MAX_SAFE_INTEGER} peerPubKey={peerOf(m.paymentId)} linkId={`group:${groupId}`} {...forwarding.rowProps(shownOf(m))} {...authorProps(m, inStack)} />
      {(() => { const note = captionOf(state, notes, m, group.myKey); return note && <GroupPaymentCaption note={note} group={group} />; })()}
    </div>
    : <MessageBubble key={m.id} message={shownOf(m)} peerAck={Number.MAX_SAFE_INTEGER} linkId={`group:${groupId}`} {...forwarding.rowProps(shownOf(m))} highlight={search.highlight(m.id)} {...authorProps(m, inStack)}
      onReply={replyTarget(m, true) ? () => { setEditing(null); setReplyingTo(m); } : undefined} quote={quoteOf(m)}
      buttons={group.canSend ? buttonsOf.get(m.id) : undefined} compactPress={presses.has(m.id)}
      onEdit={canEditInGroup(m) && !m.card && group.canSend ? () => { setReplyingTo(null); setEditing(m); } : undefined}
      onReact={replyTarget(m, true) && group.canSend ? emoji => react(m.id, emoji) : undefined} reactionName={reactionName}
      onPin={canPin && replyTarget(m, true) ? () => pinMessage(m.id, replyTarget(m, true) === group.pin?.id) : undefined} pinned={!!group.pin && replyTarget(m, true) === group.pin.id} />;
  const joiningByLink = group.invitation?.viaLink;
  const stage: GroupJoinStage = group.invitation?.stage ?? (group.invitation?.admin ? "admitted" : "knocked");
  // Getting in takes a group link: an app with no transport for one (no WebRTC, no native transport) is never let in,
  // so it says so rather than "you are in in a moment" (as the group's connection does, GroupConnection).
  const noLinks = state?.transport.groupLinks === false;
  const joining = noLinks ? { title: t("group.connection.noWebrtc"), body: t("group.connection.noWebrtcHint") }
    : joiningText(stage, group.name, group.profile === "community", t);
  // Just in (my own "You joined" line is recent), and no member reached yet: the edges are being set up.
  const justJoined = messages.some(m => m.event === "joined" && !m.member && Date.now() - m.timestamp < JUST_JOINED_MS);
  const connecting = group.status === "active" && others.length > 0 && reachable === 0 && justJoined;
  const community = group.profile === "community" ? group.community : undefined;
  const count = group.members.length === 1 ? t("group.chat.memberOne") : t("group.chat.memberCount", { count: group.members.length });
  const subtitle = joiningByLink ? (group.invitation!.admin ? t("group.chat.joining") : t("group.chat.joiningByLink"))
    : community && group.status === "active" ? (community.hub ? t("group.chat.communityHub", { members: count })
      : community.connected ? t("group.chat.communityConnected", { members: count }) : t("group.chat.communityConnecting", { members: count }))
    : group.invitation ? (group.invitation.contact ? t("group.chat.invitation", { contact: group.invitation.contact }) : t("group.chat.invitationUnknown"))
    : group.status === "active" ? t("group.chat.reachable", { members: count, reachable, total: others.length })
    : group.statusReason ?? (group.status && groupStatusText(group.status, t));
  // In a community every member can let people in, so every member hands the link out; in a private group, the admin.
  const canShare = group.status === "active" && (group.isAdmin || (group.profile === "community" && !!group.entryLink));
  const openShare = async () => {
    setError("");
    // The link may be off: sharing it turns it on. On or not, the engine hears it is being handed out
    // (whoever gets it opens it soon, so this app looks for knocks faster a while).
    try { await engine.call("enableGroupLink", { groupId }); }
    catch (e) { if (!group.entryLink) { setError(e instanceof Error ? errorText(e, t) : t("group.link.enableFailed")); return; } }
    setSharing("share");
  };
  const act = async (action: () => Promise<unknown>) => {
    setMenuOpen(false); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? errorText(e, t) : t("group.error.generic")); }
  };

  return (
    <CueChat.Provider value={groupChat(groupId)}>
    {/* Each member's colour, given out over the roster: the same on every member's device (lib/memberColors.ts). */}
    <MemberColorsProvider keys={group.members.map(m => m.key)}>
    <div className="flex-1 flex flex-col h-full bg-chat-bg" data-testid="group-chat" data-status={group.status ?? "invitation"}>
      {/* A member's message that comes while the group is open, read out once to a screen reader. */}
      <MessageAnnouncer chat={groupId} messages={messages} nameOf={m => m.member ? authorName(group, m.member, t) : group.name || t("group.chat.unnamed")} />
      <div className="h-14 header-safe flex items-center justify-between px-4 max-md:pl-1 max-md:pr-1 bg-panel-header border-b border-border shrink-0">
        <div className="flex items-center gap-3 max-md:gap-1.5 min-w-0">
          <button onClick={nav.up} className="md:hidden w-11 h-11 flex items-center justify-center text-text-secondary rounded-full active:bg-surface-hover cursor-pointer shrink-0" title={t("common.back")} data-testid="chat-back">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 19l-7-7 7-7" /></svg>
          </button>
          {/* With a picture, the avatar opens it large; without one, the members, as the line under the name does. */}
          <button ref={avatarButton} onClick={() => (group.picture ? setViewingPicture(true) : setShowMembers(true))} data-testid="group-avatar-open"
            className={`relative rounded-full shrink-0 ${group.picture ? "cursor-zoom-in" : ""}`}
            {...(group.picture ? { "aria-label": t("common.viewPhoto", { name: group.name || t("group.chat.unnamed") }) } : { title: t("group.chat.membersButton"), "aria-label": t("group.chat.membersButton") })}>
            <GroupAvatar picture={group.picture} size={40} glyph={20} testId="group-avatar" className="bg-accent/15" />
          </button>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="text-[15px] m-0 leading-tight truncate text-text-primary" data-testid="group-name">{group.name || t("group.chat.unnamed")}</p>
            </div>
            <button onClick={() => setShowMembers(true)} data-testid="group-members" className="block max-w-full text-xs text-text-muted truncate hover:text-accent cursor-pointer">
              {/* Who is typing while it lasts, in place of the member count, as a 1:1 chat's header does. */}
              <span role="status" aria-live="polite">{typers.length ? <GroupTypingText testId="group-typing" typers={typers} /> : subtitle}</span>
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {group.status === "active" && <GroupConnection group={group} />}
          {/* Only while a bot's card is here (WISP 4xx · Status Cards). */}
          <TasksButton rows={messages} nameOf={author => nameOf("peer", author) ?? `…${author.slice(-6)}`} faceOf={memberFace} />
          {canShare && <button onClick={() => void openShare()} data-testid="group-share" title={t("group.chat.shareHint")} aria-label={t("group.chat.shareLink")}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-accent/15 px-3 text-sm font-semibold text-accent hover:bg-accent/25 max-md:min-h-11 max-md:px-2.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
            <span className="max-[480px]:hidden">{t("group.chat.shareLink")}</span>
          </button>}
          <div className="relative" ref={menuRef}>
            <button onClick={() => setMenuOpen(!menuOpen)} className="p-2 max-md:p-2.5 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer" title={t("chat.options")} aria-haspopup="true" aria-expanded={menuOpen} data-testid="group-options">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" /></svg>
            </button>
            <Menu testId="group-options-menu" open={menuOpen} onClose={closeMenu} anchorRef={menuRef}>
              <MenuItem onClick={() => { setShowMembers(true); closeMenu(); }}>{t("group.menu.members")}</MenuItem>
              <MuteMenuItem chat={groupChat(group.id)} onChoose={() => { closeMenu(); setShowMute(true); }} onDone={closeMenu} />
              {!joiningByLink && <MenuItem testId="chat-search-open" onClick={() => { closeMenu(); search.show(); }} icon={<SearchIcon />}>{t("chat.search.open")}</MenuItem>}
              {group.isAdmin && <MenuItem testId="group-rotate" onClick={() => void act(() => engine.call("rotateGroup", { groupId }))}>{t("group.menu.rotate")}</MenuItem>}
              <MenuSeparator />
              {group.status === "active" && <MenuItem danger testId="group-leave" onClick={() => { closeMenu(); setConfirmLeave(true); }}>{t("group.menu.leave")}</MenuItem>}
              <MenuItem danger testId="group-forget" onClick={() => { closeMenu(); setConfirmForget(true); }}>{t("group.menu.forget")}</MenuItem>
            </Menu>
            <MuteMenu chat={groupChat(group.id)} open={showMute} onClose={() => setShowMute(false)} anchorRef={menuRef} mentions />
          </div>
        </div>
      </div>

      {!joiningByLink && <ChatSearchBar search={search} />}
      {!joiningByLink && <PinnedBar pin={group.pin} index={quoteIndex} onUnpin={canPin ? () => pinMessage(undefined, true) : undefined} />}

      {connecting && !error &&<div role="status" data-testid="group-connecting" className="px-4 py-2 text-xs bg-surface-alt text-text-secondary border-b border-border">
        {community ? t("group.chat.connectingCommunity") : t("group.chat.connectingMembers")}
      </div>}
      {(error || (group.status && group.status !== "active")) && <div role="status" data-testid="group-notice" className="px-4 py-2 text-xs bg-surface-alt text-text-secondary border-b border-border">
        {error || group.statusReason}
      </div>}


      {joiningByLink ? <div className="flex flex-1 items-center justify-center overflow-y-auto chat-wallpaper px-4">
        <div role="status" data-testid="group-joining" className="w-full max-w-sm rounded-2xl border border-border bg-sidebar-bg/95 p-6 text-center shadow-xl">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-accent/15 text-accent">
            <svg className={noLinks ? undefined : "animate-spin"} width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.22-8.56" /></svg>
          </div>
          <h2 className="mt-4 text-base font-semibold text-text-primary">{joining.title}</h2>
          <p className="mt-2 text-sm leading-relaxed text-text-muted">{joining.body}</p>
          <ol data-testid="group-joining-steps" data-stage={stage} className="mx-auto mt-4 w-fit space-y-1.5 text-left text-xs">
            {joinSteps(group.profile === "community", t).map(step => {
              const done = JOIN_ORDER.indexOf(stage) >= JOIN_ORDER.indexOf(step.stage);
              const current = !done && JOIN_ORDER[JOIN_ORDER.indexOf(step.stage) - 1] === stage;
              return <li key={step.stage} data-state={done ? "done" : current ? "current" : "todo"} className={`flex items-center gap-2 ${done ? "text-text-primary" : current ? "text-accent" : "text-text-muted"}`}>
                <span aria-hidden="true" className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${done ? "bg-accent text-on-accent" : current ? "border border-accent" : "border border-border"}`}>{done ? "✓" : ""}</span>
                {step.label}
              </li>;
            })}
          </ol>
          {knockedLong && <p data-testid="group-joining-stale" className="mt-4 text-xs leading-relaxed text-text-muted">{t("group.join.stale")}</p>}
          <button onClick={() => { void engine.call("forgetGroup", { groupId }).catch(() => {}); nav.home(); }} data-testid="group-joining-cancel"
            className="mt-4 rounded px-2 py-1 text-xs text-text-muted hover:bg-danger/10 hover:text-danger">{t("group.join.cancel")}</button>
        </div>
      </div> : <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={jump.listRef} data-message-list className="flex-1 overflow-y-auto [overflow-anchor:none] chat-wallpaper">
        {/* A bubble arriving slides in from its side: clipped here, it never makes the list scroll sideways (a scrollbar, and a jump). */}
        <div ref={jump.columnRef} className="max-w-3xl mx-auto py-3 overflow-x-clip">
          {(() => {
            const drawn = messages.slice(rowWindow.from, rowWindow.to);
            return drawn.map(m => {
              if (stackHeads.has(m.id)) return null;
              const run = stacks.get(m.id);
              if (!run) return row(m);
              // The folded row is one message of its sender's run: their colour, and their picture when it ends the run.
              return <RoutineStack key={`stack:${m.id}`} name={m.sender === "me" || authors.get(m.id)?.first === false ? undefined : nameOf("peer", m.member) ?? undefined} mine={m.sender === "me"}
                cards={run.map(r => r.card as RoutineCard)} {...authorProps(m)}>
                {run.map((r, i) => { const head = authors.get(m.id); return row(r, head && { ...head, first: false, last: i === run.length - 1 }); })}
              </RoutineStack>;
            });
          })()}
        </div>
      </div>
      <JumpToLatest count={jump.count} far={jump.far} onJump={jump.toNew} />
      </div>}

      {!joiningByLink && forwarding.bar}
      {forwarding.dialog}
      {!joiningByLink && !forwarding.selecting && <MessageInput draftId={`group:${groupId}`} key={groupId} onSend={send} disabled={!group.canSend} maxLength={16_384} recipient={group.name} mentions={mentions}
        onTyping={group.profile === "mesh" ? onTyping : undefined}
        reply={replyingTo ? { key: replyingTo.id, name: nameOf(replyingTo.sender === "me" ? "me" : "peer", replyingTo.member), snippet: messageSnippet(replyingTo),
          mine: replyingTo.sender === "me", ...(replyingTo.sender === "peer" && replyingTo.member && { member: replyingTo.member }), onCancel: () => setReplyingTo(null) } : undefined}
        // Editing one of mine (WISP 9xx § Edits): the new text shows here at once and goes to the members; @ names more.
        edit={editing ? { key: editing.id, text: editing.text, snippet: replySnippet(editing.text), onClose: () => setEditing(null),
          onSave: async (text, extra) => (await engine.call("editMessage", { linkId: `group:${groupId}`, messageId: editing.id, text, ...(extra?.mentions?.length && { mentions: extra.mentions }) })
            .catch((e: unknown) => ({ error: e instanceof Error ? errorText(e, t) : t("group.chat.editFailed") }))).error } : undefined}
        onEditLast={group.canSend ? () => {
          const last = [...messages].reverse().find(m => canEditInGroup(m) && !m.card);
          if (last) { setReplyingTo(null); setEditing(last); }
        } : undefined}
        fileUnavailable={t("group.chat.noFiles")}
        paymentsUnavailable={others.length === 0 ? t("group.chat.nobodyElse") : undefined}
        paymentComposer={close => <GroupPaymentComposer group={group} onClose={close} />} />}

      {showMembers && <GroupMembersDialog group={group} focusKey={focusMember} onClose={() => { setShowMembers(false); setFocusMember(undefined); }} />}
      {viewingPicture && group.picture && <AvatarViewer src={group.picture} name={group.name || t("group.chat.unnamed")} returnFocus={avatarButton} onClose={() => setViewingPicture(false)} />}
      {sharing && group.entryLink && <GroupShareDialog group={group} created={sharing === "created"} onClose={() => setSharing("")} />}
      {confirmLeave && <LeaveGroupDialog group={group} onClose={() => setConfirmLeave(false)}
        onConfirm={async () => { await engine.call("leaveGroup", { groupId }); forgetChatMute(groupChat(groupId)); setConfirmLeave(false); nav.home(); }} />}
      {confirmForget && <DeleteChatDialog name={group.name} onClose={() => setConfirmForget(false)}
        onConfirm={() => { setConfirmForget(false); forgetChatMute(groupChat(groupId)); void engine.call("forgetGroup", { groupId }).catch(() => {}); nav.home(); }} />}
    </div>
    </MemberColorsProvider>
    </CueChat.Provider>
  );
}
