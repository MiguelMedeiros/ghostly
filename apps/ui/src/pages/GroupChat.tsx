import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CueChat } from "../lib/cues";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { engine } from "@ghostly/browser/platform/engine";
import type { EngineState, GroupJoinStage, GroupPayNote, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { MessageBubble, sameMessageRow } from "../components/MessageBubble";
import { MessageInput } from "../components/MessageInput";
import { JumpToLatest } from "../components/chat/JumpToLatest";
import { DaySections } from "../components/chat/DaySections";
import { leftOn, leftScrolledUp, useChatScroll, type ScrollRow } from "../hooks/useChatScroll";
import { useRowWindow } from "../hooks/useRowWindow";
import { useOpenedHeading } from "../hooks/useOpenedHeading";
import { GroupMembersDialog } from "../components/GroupMembersDialog";
import { DeleteChatDialog } from "../components/DeleteChatDialog";
import { LeaveGroupDialog } from "../components/LeaveGroupDialog";
import { GroupShareDialog } from "../components/GroupLinkPanel";
import { GroupLinkAskDialog } from "../components/GroupLinkAskDialog";
import { GroupConnection } from "../components/GroupConnection";
import { TasksButton } from "../components/chat/TasksButton";
import { useJumpTo } from "../hooks/useJumpTo";
import { RoutineStack } from "../components/chat/RoutineCard";
import type { MemberFaceOf } from "../components/chat/SenderAvatar";
import { AdminMark } from "../components/chat/AdminMark";
import { panelCard, routineStacksReader } from "../lib/statusCards";
import { rowPicker } from "../lib/chatRows";
import { useComposerTranslation } from "../hooks/useComposerTranslation";
import { keepSentOriginal } from "../lib/sentOriginals";
import type { SentTranslation } from "../components/MessageInput";
import { GroupPaymentComposer } from "../components/GroupPaymentComposer";
import { GroupPaymentCaption, GroupPaymentNote } from "../components/GroupPaymentNote";
import { Menu, MenuItem, MenuSeparator } from "../components/Menu";
import { openOnArrow } from "../lib/menuButton";
import { MuteMenu, MuteMenuItem } from "../components/ChatMute";
import { TranslateMenu, TranslateMenuItem } from "../components/ChatTranslate";
import { ChatFolderMenu, FolderMenuItem } from "../components/chat/ChatFolderMenu";
import { groupChat } from "../lib/chatMute";
import { forgetSentOriginal } from "../lib/sentOriginals";
import { useI18n, type Translate } from "../contexts/I18nContext";
import { GroupInvitationCard, focusPastRow, rowAfter } from "../components/GroupInvitation";
import { GroupOthers } from "../components/GroupOthers";
import { authorName, forgetGroupLocal, groupPath, groupReadAt, groupStatusText, groupUnreadAt, markGroupRead, formerName, memberName, memberPhoto, sameNamed } from "../lib/groups";
import { NowPlayingChat, stopPlayingFrom } from "../lib/nowPlaying";
import { clearChatNotification } from "../lib/notifications";
import { closeWakeNotices } from "../lib/wakePush";
import { useWindowAway, windowAway } from "../lib/windowAway";
import { authorsMemo, type MessageAuthor } from "../lib/senderRuns";
import { rowDaysReader } from "../lib/chatDays";
import { MemberColorsProvider } from "../contexts/MemberColorsContext";
import { chatsByPeer } from "../lib/storage";
import { useContactFaces, withContactFaces } from "../components/identities/contactFace";
import type { ChatMessage } from "../lib/types";
import { useIsLocked } from "../contexts/LockScreenContext";
import { useSettings } from "../contexts/SettingsContext";
import { GroupAvatar } from "../components/GroupAvatar";
import { AvatarViewer } from "../components/AvatarViewer";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { useHandler } from "../hooks/useHandler";
import { useGroupTypingSender } from "../hooks/useTyping";
import { GroupTypingText, type GroupTyper } from "../components/TypingIndicator";
import { navOnly } from "../lib/navigation";
import { mentionViews, type MentionCandidate } from "../lib/parse/mentions";
import { COMMUNITY_LIMITS, GROUP_FILE_LIMITS, GROUP_LIMITS, isPlayableVideoType, mayPin, replySnippet, type GroupMention, type RoutineCard, type VoiceMeta } from "@ghostly/core";
import { servicesPlatform } from "../lib/platform";
import { useEngineValue } from "../lib/engineState";
import { formatFileSize } from "../lib/format";
import { videoMetaOf } from "../lib/videoPoster";
import { heldOriginal, messageSnippet, quoteFor, replyIndexer, replyTarget, type NameOf, type QuoteView } from "../lib/replies";
import { buttonsViews, compactPresses } from "../lib/buttons";
import { useForwarding } from "../hooks/useForwarding";
import { useChatSearch } from "../hooks/useChatSearch";
import { usePageShown } from "../hooks/usePageShown";
import { ChatSearchBar, SearchIcon } from "../components/chat/ChatSearch";
import { PinnedBar } from "../components/chat/PinnedBar";
import { OfflineBanner } from "../components/OfflineBanner";
import { MessageAnnouncer } from "../components/chat/MessageAnnouncer";
import { GROUP_MESSAGE_ID, canEditInGroup, canRemove } from "@ghostly/browser/shared/edits";
import { paymentWireId } from "@ghostly/browser/shared/paymentIds";
import { replyRef } from "@ghostly/browser/shared/replies";
import { problemLine, problemText, type Problem } from "../lib/problemText";
import { Notice } from "../components/ui/Notice";
import { working } from "../lib/focus";
import { setSaved, useSavedIn } from "../hooks/useSavedMessages";
import { Spinner } from "../components/wallet/ui";

/** This device's payments the page's bubbles are about, by id: what it reads of the engine's. */
type Payments = Partial<EngineState["payments"]>;

/** A roster's names as the history's rows read them: built once per roster, not once per message. */
interface RosterNames {
  /** Each member as a mention names them. */
  members: { key: string; me: boolean; name: string }[];
  /** Who wrote a message (`authorName`). */
  author: (key: string) => string;
}

/** `myName`: how a mention of me reads (my own name, as a member sees it); the others go by the roster's names. */
function rosterNames(group: Pick<GroupView, "profile" | "members" | "formerNames">, t: Translate, myName = ""): RosterNames {
  const byKey = new Map<string, string>();
  const same = sameNamed(group.members, myName);
  const members = group.members.map(m => {
    const name = memberName(m, t, same);
    if (!byKey.has(m.key)) byKey.set(m.key, name);
    return { key: m.key, me: m.me, name: m.me ? myName : name };
  });
  // A former member's name is told apart from the roster's in a community (`authorName`).
  return { members, author: key => byKey.get(key) ?? authorName(group, key, t) };
}

/** What the names are made of: the same text while no member's key or name (nor a former name) changed. */
const rosterNamesKey = (group: Pick<GroupView, "profile" | "members" | "formerNames"> | undefined) =>
  group ? JSON.stringify([group.profile, group.members.map(m => [m.key, m.me, m.nick]), group.formerNames]) : "";

function toChatMessage(message: StoredMessage, names: RosterNames): ChatMessage {
  const mentions = mentionViews(message.text, message.mentions, names.members, message.sender === "me");
  return { id: message.id, text: message.text, sender: message.sender, timestamp: message.timestamp, ...(message.sentAt !== undefined && { sentAt: message.sentAt }), paymentId: message.paymentId,
    nick: message.sender === "peer" && message.member ? names.author(message.member) : undefined,
    ...(mentions.length ? { mentions } : {}), ...(message.replyTo && { replyTo: message.replyTo }), ...(message.reactions && { reactions: message.reactions }),
    ...(message.edit && { edit: message.edit }), ...(message.forwarded && { forwarded: message.forwarded }), ...(message.card && { card: message.card }),
    // A file or voice message a member announced (WISP 503): its bubble, its bytes fetched from whoever holds them.
    ...(message.file && { file: message.file }) };
}

/** `toChatMessage` under one roster's names, once per row. */
function chatMessageMaker(names: RosterNames): (message: StoredMessage) => ChatMessage {
  const made = new WeakMap<StoredMessage, ChatMessage>();
  return message => {
    let chatMessage = made.get(message);
    if (!chatMessage) made.set(message, chatMessage = toChatMessage(message, names));
    return chatMessage;
  };
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
function noteIdOf(payments: Payments, paymentId: string): string {
  const payment = payments[paymentId];
  return paymentWireId(payment?.kind === "payment" && payment.requestId ? payment.requestId : paymentId);
}

/**
 * The note that captions a payment bubble: the one about that bubble's own payment, which the member who started it
 * says (the payee of a request, the payer of a payment), never a note of another member that reuses its id.
 */
function captionOf(payments: Payments, notes: ReadonlyMap<string, GroupPayNote>, message: StoredMessage, myKey: string | undefined): GroupPayNote | undefined {
  const payment = payments[message.paymentId!];
  // Said once, under the request (or the payment) itself: not again under a payment that answers it.
  if (payment?.kind === "payment" && payment.requestId) return undefined;
  const note = notes.get(noteIdOf(payments, message.paymentId!));
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
 * A name as a stored line has it. A member that never said a name is written "Member 46ishssi" (`Member` and the start
 * of its key, engine/groups.ts and engine/community.ts): said in the interface's words, as that member's messages are.
 */
const UNNAMED_MEMBER = /^Member ([a-z0-9]{8})$/;
function writtenName(name: string, t: Translate): string {
  const key = UNNAMED_MEMBER.exec(name)?.[1];
  return key ? t("group.member.unnamed", { key }) : name;
}

/**
 * A line the engine wrote as "<name> <what happened>", said in the interface's language with the name it was written
 * with (`nameOf`: that name as the line says it).
 */
function writtenEvent(event: StoredMessage["event"], text: string, t: Translate, nameOf: (name: string) => string): string | undefined {
  const named = (ending: string) => text.endsWith(ending) && text.length > ending.length ? nameOf(text.slice(0, -ending.length)) : undefined;
  if (event === "joined") { const name = named(" joined"); return name && t("group.event.joined", { name }); }
  if (event === "admin") { const name = named(" is now the admin"); return name && t("group.event.admin", { name }); }
  if (event === "picture") {
    const changed = named(" changed the group's picture"), removed = named(" removed the group's picture");
    return changed ? t("group.event.pictureChanged", { name: changed }) : removed ? t("group.event.pictureRemoved", { name: removed }) : undefined;
  }
  const marker = " renamed the group to “", at = event === "renamed" ? text.indexOf(marker) : -1;
  return at > 0 && text.endsWith("”") ? t("group.event.renamed", { name: nameOf(text.slice(0, at)), group: text.slice(at + marker.length, -1) }) : undefined;
}

/** A name or picture change the engine wrote crediting nobody (a new admin signed again what the last one set), said in the interface's language. */
function namelessEvent(event: StoredMessage["event"], text: string, t: Translate): string | undefined {
  const renamed = "The group is now called “";
  if (event === "renamed" && text.startsWith(renamed) && text.endsWith("”")) return t("group.event.renamedNoName", { group: text.slice(renamed.length, -1) });
  if (event === "picture" && text === "The group's picture was changed") return t("group.event.pictureChangedNoName");
  if (event === "picture" && text === "The group's picture was removed") return t("group.event.pictureRemovedNoName");
  return undefined;
}

/**
 * A membership line, naming its member as the roster knows them now; what was stored, when they are gone. The engine
 * stores it in English: the line is said again in the interface's language from its kind, where the stored text has
 * the shape the engine writes. Any other text (a reason the core gave) is shown as it is.
 */
function eventText(message: StoredMessage, group: GroupView, t: Translate, nameSlot?: string): string {
  const member = message.member ? group.members.find(m => m.key === message.member) : undefined;
  const text = message.text;
  // My own key is me whatever the roster says: once removed, it no longer lists me, and my lines still read "You …".
  const me = !!member?.me || (!!message.member && message.member === group.myKey);
  // A private group's removal names the admin who signed it (`by`), as the roster or the group's former names know
  // them now; my own removal of someone in my words. Mine, the line of a member back in the group, stays "You were removed".
  if (message.event === "gone" && message.member && message.by && !me) {
    const name = authorName(group, message.member, t);
    const byMe = message.by === group.myKey || !!group.members.find(m => m.key === message.by)?.me;
    return byMe ? t("group.event.goneByYou", { name }) : t("group.event.goneBy", { by: authorName(group, message.by, t), name });
  }
  // A member who has left since: the group still knows the name they had (`formerNames`), so their lines are said in
  // the interface's language too. A community knows only the names it heard: for anyone else its stored line stays.
  const former = !member && !!message.member && FORMER_EVENTS.has(message.event) && (me || group.profile !== "community" || !!group.formerNames?.[message.member]);
  if (!member && !former) {
    if (message.event === "created" && text.startsWith("Group created. ")) return t("group.event.withNote", { event: t("group.event.created"), note: readNote(group, t) });
    if (message.event === "joined" && !message.member && text.startsWith("You joined. ")) return t("group.event.withNote", { event: t("group.event.youJoined"), note: readNote(group, t) });
    if (message.event === "joined" && !message.member && text === "You joined again") return t("group.event.youJoinedAgain");
    // The name stored, in a community told apart from a member's of the same name by the end of its key (`formerName`).
    const nameOf = (stored: string) => message.member && !me ? formerName(group, message.member, writtenName(stored, t)) : writtenName(stored, t);
    const gone = " is no longer a member";
    if (message.event === "gone" && text.endsWith(gone)) return t("group.event.gone", { name: nameOf(text.slice(0, -gone.length)) });
    const left = " left";
    if (message.event === "left" && text.endsWith(left)) return t("group.event.left", { name: nameOf(text.slice(0, -left.length)) });
    // A community's line about a member who has left since: no roster or former name says who it was, but the stored
    // line does, in the shape the engine writes. Said again in the interface's language with that name; a change that
    // credits nobody, without one.
    const written = message.member ? writtenEvent(message.event, text, t, nameOf) : namelessEvent(message.event, text, t);
    if (written) return written;
    // My own removal or fork: the core's reason ("Member … holds a different membership history for epoch 4. …") is
    // English, and its detail is the notice's (behind its ⓘ). The line says what happened, from its kind.
    if (!message.member && message.event === "removed") return t("group.event.removed");
    if (!message.member && message.event === "forked") return t("group.event.forked");
    const fixed = (FIXED_EVENTS as Map<string, string>).get(text);
    return fixed === "rotated" ? t("group.event.rotated") : fixed === "removed" ? t("group.event.removed") : fixed === "forked" ? t("group.event.forked") : text;
  }
  const name = nameSlot ?? (member ? memberName(member, t, sameNamed(group.members)) : authorName(group, message.member!, t));
  if (message.event === "joined") return t("group.event.joined", { name });
  // A member back in the group (invited again): the line of their earlier removal or leave is theirs too. Mine says
  // what happened to me in its own words.
  if (message.event === "gone") return me ? t("group.event.removed") : t("group.event.gone", { name });
  if (message.event === "left" && !me) return t("group.event.left", { name });
  if (message.event === "admin") return me ? t("group.event.adminYou") : t("group.event.admin", { name });
  if (message.event === "picture") {
    const removed = text.endsWith("removed the group's picture");
    if (me) return removed ? t("group.event.pictureRemovedYou") : t("group.event.pictureChangedYou");
    return removed ? t("group.event.pictureRemoved", { name }) : t("group.event.pictureChanged", { name });
  }
  const marker = " renamed the group to “";
  const renamed = message.event === "renamed" ? text.indexOf(marker) : -1;
  if (renamed >= 0 && text.endsWith("”")) {
    const group = text.slice(renamed + marker.length, -1);
    return me ? t("group.event.renamedYou", { group }) : t("group.event.renamed", { name, group });
  }
  return text;
}

/** What `eventLine` writes in place of the admin's name (a private-use character), to put the name and its mark there. */
const NAME_SLOT = "";

/**
 * A membership line (`eventText`), the admin's name in it with the admin's mark, which no name a member picks can be.
 * Not the line that makes them the admin: it says so in its own words, and the mark would only repeat "admin".
 */
function eventLine(message: StoredMessage, group: GroupView, t: Translate): ReactNode {
  const member = message.member ? group.members.find(m => m.key === message.member) : undefined;
  if (!member || member.me || member.role !== "admin" || message.event === "admin") return eventText(message, group, t);
  const [before, after, ...more] = eventText(message, group, t, NAME_SLOT).split(NAME_SLOT);
  if (after === undefined || more.length) return eventText(message, group, t);
  return <>{before}<bdi>{memberName(member, t, sameNamed(group.members))}</bdi> <AdminMark testId="group-event-admin" />{after}</>;
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
 * nobody, and nothing tells the joiner so: WISP 902), or every app that could answer is closed. The joiner is told both.
 */
const LONG_KNOCK_MS = 2 * 60_000;
/**
 * Let into a community this long and still no welcome: it was lost, and if the link was replaced before the next knock,
 * no member reads the old link's knocks to say it again. The joiner keeps knocking, but is told to ask for the current link.
 */
const LONG_ADMITTED_MS = 5 * 60_000;
const NO_MESSAGES: StoredMessage[] = [];
const NO_ROWS: readonly ChatMessage[] = [];

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
/** A step at a stage: done once reached, current while it is the next one, else still to come. Full or blocked: the knock is there. */
function joinStepState(at: GroupJoinStage, step: JoinStep): "done" | "current" | "todo" {
  const stage = at === "full" || at === "blocked" ? "knocked" : at;
  if (JOIN_ORDER.indexOf(stage) >= JOIN_ORDER.indexOf(step)) return "done";
  return JOIN_ORDER[JOIN_ORDER.indexOf(step) - 1] === stage ? "current" : "todo";
}

function joiningText(stage: GroupJoinStage, name: string, community: boolean, t: Translate, full?: { n: number; max: number }, admittedLong = false, othersKnocked = false): { title: string; body: string } {
  const waiting = t("group.join.waiting");
  if (stage === "replaced") return { title: t("group.join.replaced"), body: t("group.join.replacedBody") };
  // A member's app answered that there is no room yet (`group-full`): the link works, and asking for a new one won't help.
  if (stage === "full" && full) return { title: t("group.join.full"), body: t("group.join.fullBody", { n: full.n, max: full.max }) };
  // Or that it grows only once every member's app is updated: the same, until they are.
  if (stage === "blocked") return { title: t("group.join.blocked"), body: t("group.join.blockedBody") };
  if (stage === "admitted") return { title: name ? t("group.join.joiningName", { name }) : t("group.join.joiningGroup"),
    body: !community ? t("group.join.admitted") : admittedLong ? t("group.join.admittedStuck") : t("group.join.admittedCommunity") };
  if (stage === "answered") return { title: community ? t("group.join.answeredTitleCommunity") : waiting,
    body: community ? t("group.join.answeredCommunity") : t("group.join.answered") };
  // Others knocked just before: the admin's app may be letting them in, not closed.
  if (stage === "knocked") return { title: waiting, body: community ? t("group.join.knockedCommunity") : othersKnocked ? t("group.join.knockedBusy") : t("group.join.knocked") };
  return { title: waiting, body: community ? t("group.join.knockingCommunity") : t("group.join.knocking") };
}

/**
 * A message row, drawn again only when what it shows changes (as a 1:1 chat's, Chat.tsx): the page is drawn again for
 * much that changes no row (a member coming online or going away, a message arriving), and each of the 100 to 150 rows
 * it draws was drawn with it. Its callbacks count only by whether they are there: the page's own are one function each
 * for its life (`useHandler`), and the rest close over the row's message and setters.
 */
const MessageRow = memo(MessageBubble, sameMessageRow);

/** The group as the page draws it: who is typing is read by the header's line alone (`GroupTypingLine`). */
function withoutTyping(group: GroupView | undefined): GroupView | undefined {
  if (!group?.typing) return group;
  const { typing: _typing, ...rest } = group;
  return rest;
}

/**
 * Who is typing in the open group while it lasts, in place of `children` (the member count), as a 1:1 chat's header
 * does. Read here, not by the page: each start and stop draws this line, not the page with its rows.
 */
function GroupTypingLine({ group, children }: { group: GroupView; children: ReactNode }) {
  const { t } = useI18n();
  const typing = useEngineValue(state => state?.groups.find(g => g.id === group.id)?.typing);
  const typers = useMemo(() => (typing ?? []).map(({ key, kind, status }): GroupTyper => {
    const member = group.members.find(m => m.key === key);
    return { key, name: member ? memberName(member, t, sameNamed(group.members)) : t("group.member.unnamed", { key: key.slice(0, 8) }), ...(kind ? { kind } : {}), ...(status ? { status } : {}) };
  }), [typing, group, t]);
  return <>
    {/* Only who is typing is said by a screen reader: the count, inside the live region, was read again each time they stopped. */}
    <span role="status" aria-live="polite">{typers.length > 0 && <GroupTypingText testId="group-typing" typers={typers} />}</span>
    {!typers.length && children}
  </>;
}

/** One private group: its members and roles behind the header, its history, and the composer. */
export function GroupChat() {
  const { groupId = "" } = useParams();
  const navigate = useNavigate();
  const nav = useAppNavigation();
  const { t } = useI18n();
  // What the page shows of the engine's state, each compared by content (lib/engineState): the whole state drew the
  // open group, its header and its rows' authors on every change, up to 20 a second while a file moves.
  const started = useEngineValue(state => !!state);
  // Who is typing changes all the time, and only the header's line shows it: that line reads it (`GroupTypingLine`).
  const rosterGroup = useEngineValue(state => withoutTyping(state?.groups.find(g => g.id === groupId)));
  // Of the 1:1 chats, what names and pictures members who are contacts: not each link's whole state.
  const links = useEngineValue(state => state?.links.map(({ id, peerPubKeyZ32, peerAvatar }) => ({ id, peerPubKeyZ32, peerAvatar })));
  // Members who are contacts go by the identity they are shown as, if one was chosen (identities/contactFace.ts).
  const faceOf = useContactFaces();
  // A member's nickname from that contact's chat, read only when a member is a contact and parsed again only when the
  // chat changed: every engine state comes through here, and a read of every chat each time grew with the chat list.
  // One look through the stored chats for the whole roster, not one per member: each walks every key of the page's
  // storage, and this runs again at each message in the group.
  const group = useMemo(() => {
    if (!rosterGroup) return undefined;
    let chats: ReturnType<typeof chatsByPeer> | undefined;
    return withContactFaces(rosterGroup, links, faceOf, peerKey => (chats ??= chatsByPeer()).get(peerKey)?.label);
  }, [rosterGroup, links, faceOf]);
  // The history of this group only: the page stays mounted from one group to the next, and for the render that changes
  // groups the last one's messages would still be here (the timeline would open on them, and never find where this
  // group was left). Until this group's own list comes, what the engine last sent for it.
  const [loaded, setLoaded] = useState<{ groupId: string; list: StoredMessage[] }>({ groupId: "", list: NO_MESSAGES });
  const messages = loaded.groupId === groupId ? loaded.list : engine.messages.get(`group:${groupId}`) ?? NO_MESSAGES;
  // A group with a history whose rows have not come yet (shown at start, the engine still starting): it says it is
  // loading, not an empty group.
  const reading = loaded.groupId !== groupId && !engine.messages.has(`group:${groupId}`) && (group?.lastMessageAt ?? 0) > 0;
  const [readReplies] = useState(() => replyIndexer(true));
  const quoteIndex = useMemo(() => readReplies(messages), [messages, readReplies]);
  /**
   * The message the composer answers (WISP 902 § Replies), read as the group has it now (as a 1:1 chat's, Chat.tsx): an
   * edit shows in the bar, and a message deleted (for everyone, by its author or an admin) lets the bar go.
   */
  const [chosenReply, setReplyingTo] = useState<StoredMessage | null>(null);
  const replyingTo = useMemo(() => (chosenReply && heldOriginal(chosenReply, quoteIndex, true)) ?? null, [chosenReply, quoteIndex]);
  useEffect(() => { if (chosenReply && !replyingTo) setReplyingTo(null); }, [chosenReply, replyingTo]);
  /**
   * The reply as it is when a message goes, not as a render's closure saw it: the composer sends what was queued one
   * after the other, and only the first of them after Reply carries it.
   */
  const replyingRef = useRef(replyingTo);
  replyingRef.current = replyingTo;
  /**
   * The message of mine the composer edits (WISP 902 § Edits). Only while the group has it: deleted meanwhile, the edit
   * ends, its words with it, and the draft set aside comes back.
   */
  const [chosenEdit, setEditing] = useState<StoredMessage | null>(null);
  const editing = chosenEdit && heldOriginal(chosenEdit, quoteIndex, true) ? chosenEdit : null;
  useEffect(() => { if (chosenEdit && !editing) setEditing(null); }, [chosenEdit, editing]);
  useEffect(() => { setReplyingTo(null); setEditing(null); }, [groupId]);
  // The group no longer takes my messages (removed, left on another device): the composer under the bars is off, and
  // they go. Not while it is off for a moment in a group still active (a join or removal past 16 members).
  const closed = !!rosterGroup && !rosterGroup.canSend && rosterGroup.status !== "active";
  useEffect(() => { if (closed) { setReplyingTo(null); setEditing(null); } }, [closed]);
  // A bot's buttons (WISP 406 · Message Buttons): which one was chosen, and whether I may still press, from my replies.
  const [pickButtonRow] = useState(() => rowPicker<StoredMessage, StoredMessage>(m => m.card?.kind === "buttons" || m.replyTo ? m : undefined));
  const buttonRows = useMemo(() => pickButtonRow(messages), [pickButtonRow, messages]);
  const buttonsOf = useMemo(() => buttonsViews(buttonRows, m => replyRef(m, true)), [buttonRows]);
  const presses = useMemo(() => compactPresses(buttonRows, m => replyRef(m, true)), [buttonRows]);
  const [showMembers, setShowMembers] = useState(false);
  /** The member whose name or picture above a message opened the members, marked there. */
  const [focusMember, setFocusMember] = useState<string>();
  /** The group's picture, large (AvatarViewer.tsx), and the header's avatar that opened it. */
  const [viewingPicture, setViewingPicture] = useState(false);
  const avatarButton = useRef<HTMLButtonElement>(null);
  if (viewingPicture && !group?.picture) setViewingPicture(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showMute, setShowMute] = useState(false);
  const [showTranslate, setShowTranslate] = useState(false);
  const [showFolders, setShowFolders] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  // A new group opens on its link (the sidebar says so in the navigation's state); the header's Share link opens it again.
  const location = useLocation();
  const [sharing, setSharing] = useState<"" | "created" | "share">("");
  /** The unanswered joiners' New link while it works: a reset seals a fresh key to every member, and a second press made another. */
  const [resetting, setResetting] = useState(false);
  /** Its "Make a new link?" question, asked as every other New link's is: the link shared so far stops letting anyone in. */
  const [askingReset, setAskingReset] = useState(false);
  // Its dialog waits for the link (a new group's, or one just turned on, comes with the state that follows), then stays
  // until it is closed: turned off in it, the link says so there, and one turned on again later opens nothing by itself.
  const [shareShown, setShareShown] = useState(false);
  if (sharing && rosterGroup?.entryLink && !shareShown) setShareShown(true);
  const closeShare = () => { setSharing(""); setShareShown(false); };
  useEffect(() => {
    if ((location.state as { share?: string } | null)?.share !== "created") return;
    setSharing("created");
    navigate(location.pathname, { replace: true, state: navOnly(location.state) });
  }, [location.state, location.pathname, navigate]);
  // What an action here refused, with the group it was about: the page is one for every group, and another group opened
  // shows that group's own notice, not this one's refusal (gone once it is left, as a reply is), nor one that comes after.
  const [refused, setRefused] = useState<{ groupId: string; problem: Problem } | null>(null);
  const error = refused?.groupId === groupId ? refused.problem : null;
  useEffect(() => setRefused(null), [groupId]);
  const openGroupId = useRef(groupId);
  openGroupId.current = groupId;
  const setError = (problem: Problem | null) => { if (openGroupId.current === groupId) setRefused(problem && { groupId, problem }); };
  const menuRef = useRef<HTMLDivElement>(null), optionsRef = useRef<HTMLButtonElement>(null), shareRef = useRef<HTMLButtonElement>(null);
  // Where the Share dialog gives the focus back: Share, or the ⋮ once the link went off and took Share with it.
  const shareBack = useMemo(() => ({ get current() { return shareRef.current ?? optionsRef.current; } }), []);
  const { settings } = useSettings();
  // Forward, and Select then Forward (WISP 400 § Forwards): a group's texts, to chats and other groups.
  // The group is a new object on every state of the engine (up to 20 a second): the names, and so the rows, are made
  // again only when the roster's own keys or names changed, not for a history's length times its roster each time.
  const namesKey = rosterNamesKey(group);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `namesKey` is all of the group the names read
  const names = useMemo(() => group && rosterNames(group, t, settings.defaultNickname), [namesKey, settings.defaultNickname, t]);
  // Each row made once per roster, and only the rows that changed read for the list (see Chat.tsx): a long group has thousands.
  const shownOf = useMemo(() => chatMessageMaker(names!), [names]);
  const pickShown = useMemo(() => rowPicker<StoredMessage, ChatMessage>(m => m.event || m.groupPay ? undefined : shownOf(m)), [shownOf]);
  const shown = useMemo(() => names ? pickShown(messages) : NO_ROWS, [names, pickShown, messages]);
  const forwarding = useForwarding(group ? `group:${groupId}` : undefined, shown);
  // Members learn my name on the edges, as a contact does on a chat: the engine must know it here too.
  const engineNick = useEngineValue(state => state?.settings.nick);
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
    // Its whole history as the engine keeps it on this page: asked for once (the listener below hears it), then kept
    // current with what changes in it. A group opened again reads nothing from the store, and its next message is a
    // change, not its whole history read again.
    const held = engine.history(linkId);
    if (held) show(held);
    else if (!engine.messages.has(linkId) && !leftScrolledUp(groupId)) {
      void engine.call("messagePage", { linkId }).then(page => { if (current && !whole) setLoaded({ groupId, list: page.messages }); }).catch(() => {});
    }
    const off = engine.onMessages((linkId, list) => { if (linkId === `group:${groupId}`) show(list); });
    // Its list stops following once this group is left: coming back, the engine's copy (with what came meanwhile) is shown.
    return () => { current = false; off(); setLoaded({ groupId: "", list: NO_MESSAGES }); };
  }, [groupId]);
  // Opened from the Tasks board: on the card's message, once it is here.
  useJumpTo(!!group, id => messages.some(m => m.id === id));
  // What the now-playing bar names, for a voice message from here that plays on elsewhere.
  const groupName = group ? group.name || t("group.chat.unnamed") : "";
  const playingChat = useMemo(() => ({ path: groupPath(groupId), name: groupName }), [groupId, groupName]);
  // Left or deleted here: what this device keeps of it goes, and so does what plays from it (no bar naming it after).
  const goneHere = () => { forgetGroupLocal(groupId); stopPlayingFrom(groupPath(groupId), true); };
  // Cancel joining on a first join's card: the group's row goes and home shows. The focus goes to the list's next row,
  // or New, as a Decline's does (on a phone, once the list shows); it was left on the page's body.
  const cancelJoin = () => {
    const next = rowAfter(groupId), pressed = document.activeElement;
    void engine.call("forgetGroup", { groupId }).then(() => forgetGroupLocal(groupId), () => {});
    nav.home();
    focusPastRow(next, pressed);
  };
  // A bot's routines in a row: one row, opened on a tap (WISP 405 · Status Cards), whichever of its rows are in the page.
  const [readStacks] = useState(() => routineStacksReader<StoredMessage, StoredMessage>(m => m));
  const stacks = useMemo(() => readStacks(messages), [readStacks, messages]);
  // The Tasks button's rows: those with a task or a routine, found in the rows that changed (see Chat.tsx).
  const [pickCardRow] = useState(() => rowPicker<StoredMessage, StoredMessage>(m => panelCard(m.card) ? m : undefined));
  const cardRows = useMemo(() => pickCardRow(messages), [pickCardRow, messages]);
  const stackHeads = useMemo(() => new Map([...stacks.values()].flatMap(run => run.slice(1).map(m => [m.id, run[0].id] as const))), [stacks]);
  // Who wrote each message, over the whole history: worked out again only when what it reads changes (`authorsMemo`).
  const [authorsFor] = useState(authorsMemo);
  // A long group has a window of its rows in the page, never the whole history (useRowWindow, see Chat.tsx).
  const [pickRowId] = useState(() => rowPicker<StoredMessage, string>(m => m.id));
  const rowIds = useMemo(() => pickRowId(messages), [pickRowId, messages]);
  const rowWindow = useRowWindow(rowIds, groupId ?? "", { opensOn: leftOn(groupId ?? ""), heads: stackHeads });
  // The day each row goes under, over the whole history (see Chat.tsx).
  const [readDays] = useState(() => rowDaysReader<StoredMessage>(m => m.timestamp));
  const days = useMemo(() => readDays(messages), [readDays, messages]);
  // At the bottom a new message keeps the view there; scrolled up, nothing moves it and the ↓ pill counts the members'.
  // Always every message, in the page or not; a new list when the window moves (see Chat.tsx).
  const [pickScrollRow] = useState(() => rowPicker<StoredMessage, ScrollRow>(m => m.event || m.groupPay ? undefined : { id: m.id, mine: m.sender === "me" }));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the window's edges: see above
  const scrollRows = useMemo(() => pickScrollRow(messages).slice(), [pickScrollRow, messages, rowWindow.from, rowWindow.to]);
  // The rows a page's every draw looks at, found in the rows that changed: the payments' notes, this device's own
  // payment bubbles, and my own "You joined" lines.
  const [pickNote] = useState(() => rowPicker<StoredMessage, GroupPayNote>(m => m.groupPay));
  const noteRows = useMemo(() => pickNote(messages), [pickNote, messages]);
  const notes = useMemo(() => new Map(noteRows.map(note => [note.id, note])), [noteRows]);
  const [pickPaymentRow] = useState(() => rowPicker<StoredMessage, StoredMessage>(m => m.paymentId && !m.groupPay ? m : undefined));
  const paymentRows = useMemo(() => pickPaymentRow(messages), [pickPaymentRow, messages]);
  // Their payments, and the contact each went to or came from (over a member's edge): not every payment of the device.
  const payments = useEngineValue(state => Object.fromEntries(paymentRows.map(m => [m.paymentId!, state?.payments[m.paymentId!]]))) as Payments;
  const paymentPeers = useEngineValue(state => Object.fromEntries(paymentRows.map(m => {
    const linkId = state?.payments[m.paymentId!]?.linkId;
    return [m.paymentId!, state?.edges?.find(l => l.id === linkId)?.peerPubKeyZ32 ?? ""];
  })));
  // Getting in takes a group link: an app with no transport for one (no WebRTC, no native transport) is never let in,
  // so it says so rather than "you are in in a moment" (as the group's connection does, GroupConnection).
  const noLinks = useEngineValue(state => state?.transport.groupLinks === false);
  const [pickMyJoin] = useState(() => rowPicker<StoredMessage, number>(m => m.event === "joined" && !m.member ? m.timestamp : undefined));
  const myJoins = useMemo(() => pickMyJoin(messages), [pickMyJoin, messages]);
  const jump = useChatScroll({ rows: scrollRows, chat: groupId, window: rowWindow });
  const search = useChatSearch({ messages: shown, chat: groupId, active: !!group && !(group.invitation && (!group.invitation.viaLink || !group.status)), t, returnFocus: optionsRef });
  // Read while the page shows; in a hidden window what comes stays unread (usePageShown), and under the lock screen too
  // (the app stays mounted there): read once unlocked, as a chat's is.
  // Written only when something new was read, as a chat's is: every write wakes the other pages of the app (`storage`).
  const pageShown = usePageShown();
  const locked = useIsLocked();
  // Up to the newest of what the list calls unread: after a restart a message written before the mark but handed over
  // later has lastMessageAt at its writing, lastPeerMessageAt and lastMentionAt at its arrival.
  const readGroupId = group?.id;
  const readUpTo = group && Math.max(group.lastMessageAt, groupUnreadAt(group), group.lastMentionAt ?? 0);
  useEffect(() => {
    if (!readGroupId || readUpTo === undefined || !pageShown || locked || groupReadAt(readGroupId) >= readUpTo) return;
    markGroupRead(readGroupId, Math.max(readUpTo, Date.now()));
  }, [readGroupId, readUpTo, pageShown, locked]);
  // Its notification goes once the window has the focus too, and not under the lock, as a chat's does (Chat.tsx).
  const away = useWindowAway();
  useEffect(() => {
    if (!group || locked || windowAway()) return;
    clearChatNotification(`group:${group.id}`);
    closeWakeNotices(groupPath(group.id));
  }, [group?.id, group?.lastMessageAt, group, away, locked]);

  /** `extra.translated`: a translation from the composer's preview, whose original is kept beside it on this device. */
  const send = useCallback(async (text: string, mentions?: GroupMention[], extra?: { translated?: SentTranslation }): Promise<string | null> => {
    const answering = replyingRef.current;
    try {
      const { error, messageId } = await engine.call("sendGroupMessage", { groupId, text, ...(mentions?.length && { mentions }), ...(answering && { replyTo: answering.id }) });
      if (!error && messageId && extra?.translated) keepSentOriginal(`group:${groupId}`, messageId, extra.translated);
      if (!error && answering) {
        if (replyingRef.current?.id === answering.id) replyingRef.current = null;
        setReplyingTo(current => current?.id === answering.id ? null : current);
      }
      // The engine says why in English: said here in the app's language (lib/errorText.ts).
      return error && problemLine(error, t);
    }
    catch (e) { return e instanceof Error ? problemLine(e, t) : t("group.chat.sendFailed"); }
  }, [groupId, t]);
  const { translation: composerTranslation, question: translateQuestion } = useComposerTranslation(`group:${groupId}`);

  // Files and voice messages (WISP 503): the 1:1 composer's, within the group's limit. The first thing sent after
  // Reply carries it, as a text does.
  const platform = servicesPlatform;
  const sendFile = useCallback(async (source: File, voice?: VoiceMeta): Promise<string | null> => {
    if (!platform?.sendGroupFile) return null;
    if (source.size > GROUP_FILE_LIMITS.maxBytes) return t("chat.fileTooLarge", { size: formatFileSize(GROUP_FILE_LIMITS.maxBytes, t) });
    const answering = replyingRef.current;
    try {
      // A video goes with its length, size and first frame, so members see it before they fetch it.
      const video = !voice && isPlayableVideoType(source.type) ? await videoMetaOf(source).catch(() => undefined) : undefined;
      await platform.sendGroupFile(groupId, source, { ...(voice && { voice }), ...(video && { video }), ...(answering && { replyTo: answering.id }) });
      if (answering) {
        if (replyingRef.current?.id === answering.id) replyingRef.current = null;
        setReplyingTo(current => current?.id === answering.id ? null : current);
      }
      return null;
    } catch (e) { return problemLine(e, t); }
  }, [platform, groupId, t]);

  // Typing (WISP 902 · Group Mesh § Typing): private groups only; a community does not carry it yet.
  const onTyping = useGroupTypingSender(rosterGroup?.profile === "mesh" && rosterGroup.status === "active" ? groupId : undefined);

  // "@everyone": a private group's admin only; a community has no everyone (WISP 902 § Mentions).
  const mentions = useMemo(() => group ? { candidates: mentionCandidates(group, t), everyone: group.profile === "mesh" && group.isAdmin } : undefined, [group, t]);

  // Still knocking through a link after a while: the link may have been replaced (said under the steps).
  const knock = rosterGroup?.invitation?.viaLink ? rosterGroup.invitation.stage ?? (rosterGroup.invitation.admin ? "admitted" : "knocked") : undefined;
  // Timed from the knock: a group kept here, knocking to get back in, was created long before it.
  const knockedLong = usePast(knock === "knocked" ? rosterGroup!.invitation!.since ?? rosterGroup!.createdAt : undefined, LONG_KNOCK_MS);
  // Let into a community and still no keys a while on: the welcome was lost, and maybe the link replaced since.
  const admittedLong = usePast(knock === "admitted" ? rosterGroup!.invitation!.admittedAt : undefined, LONG_ADMITTED_MS);
  // Saved messages: kept on this device, never sent; the Saved view lists them. A hook: before the returns below.
  const savedHere = useSavedIn(`group:${groupId}`);
  /*
   * A message row's actions: one function each for the page's life, doing what the group says when pressed (as a 1:1
   * chat's, Chat.tsx). A row is drawn again only when what it shows changes (`MessageRow`), so it holds them from an
   * earlier draw. Each reads the message as the group has it now.
   */
  const rowNow = (m: StoredMessage) => messages.find(x => x.id === m.id) ?? m;
  const replyRow = useHandler((m: StoredMessage) => { setEditing(null); setReplyingTo(rowNow(m)); });
  const editRow = useHandler((m: StoredMessage) => { setReplyingTo(null); setEditing(rowNow(m)); });
  // Mine, taken off every member's device: a refusal (limited mode) rejects, and the bubble says it under the message.
  const removeRow = useHandler((m: StoredMessage) => engine.call("removeMessage", { linkId: `group:${groupId}`, messageId: m.id })
    .then(result => { if (result.error) throw new Error(result.error); forgetSentOriginal(groupChat(groupId), m.id); }));
  // Reactions (WISP 902 § Reactions): one per member per message, named by the roster.
  const react = useHandler((messageId: string, emoji: string) => { void engine.call("react", { linkId: `group:${groupId}`, messageId, emoji }).catch(() => {}); });
  // One function while the roster's names stay (a row draws the names it answers): not one per draw of the page.
  const reactionName = useMemo(() => {
    const nameOf = group && replyNames(group, t("chat.reply.you"), t);
    return (by: string) => nameOf?.("peer", by) ?? by.slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `namesKey` is all of the group the names read
  }, [namesKey, t]);
  // The pinned message (WISP 400 § Pinned message): any member of a private group pins, only the admin of a community.
  const pinMessage = useHandler((messageId: string | undefined, remove: boolean = false) => {
    void engine.call("pinMessage", { linkId: `group:${groupId}`, messageId, remove }).catch(() => {});
  });
  const pinRow = useHandler((m: StoredMessage) => pinMessage(m.id, replyTarget(rowNow(m), true) === group?.pin?.id));
  const saveRow = useHandler((messageId: string) => void setSaved(`group:${groupId}`, messageId, savedHere.has(messageId)).catch(() => {}));
  // The composer turned off under the focus (removed, left on another device, the group forked): the field goes disabled
  // and the browser drops the focus to the page. It goes to the line that says why, or to the ⋮ when there is none.
  // Off for a moment on a group still active (a join, leave or removal past 16 members): nothing says why, and the
  // composer gives the focus back itself once it is on again (`MessageInput`). Moved to ⋮, it stayed there and the next
  // keys opened its menu (agents#1739).
  const noticeRef = useRef<HTMLDivElement>(null);
  const canSend = !!group?.canSend, active = group?.status === "active";
  const couldSend = useRef(canSend);
  useLayoutEffect(() => {
    const could = couldSend.current;
    couldSend.current = canSend;
    if (!could || canSend || active) return;
    const at = document.activeElement;
    if (at && at !== document.body && !at.closest("[data-composer]")) return;
    (noticeRef.current ?? optionsRef.current)?.focus();
  }, [canSend, active]);
  // On a touch screen the focus goes to the group's name as it opens, not to the page (hooks/useOpenedHeading.ts): once
  // its header is drawn (the engine's state, then the group).
  const headingRef = useRef<HTMLHeadingElement>(null);
  useOpenedHeading(headingRef, started && group ? groupId : null);
  if (!started) return null;
  const back = <button onClick={nav.up} className="md:hidden w-11 h-11 flex items-center justify-center text-text-secondary rounded-full active:bg-surface-hover cursor-pointer shrink-0" title={t("common.back")} aria-label={t("common.back")} data-testid="chat-back">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="rtl:-scale-x-100"><path d="M15 19l-7-7 7-7" /></svg>
  </button>;
  // Deleted on another device, or an address kept from before: the header keeps its way back (the group page hides the tabs).
  if (!group) return <div className="flex-1 flex flex-col h-full bg-chat-bg" data-testid="group-gone">
    <div className="h-14 header-safe flex items-center px-4 max-md:pl-1 max-md:pr-1 bg-panel-header border-b border-border shrink-0">{back}</div>
    <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-text-muted">{t("group.chat.gone")}</div>
  </div>;
  const nameOf = replyNames(group, t("chat.reply.you"), t);
  const quoteOf = (m: StoredMessage): QuoteView | undefined => m.replyTo && quoteFor(m.replyTo, quoteIndex, nameOf, t);
  const canPin = group.canSend && !!group.myKey && mayPin(group.profile, group.myKey, group.members.find(m => m.role === "admin")?.key);

  const others = group.members.filter(m => !m.me);
  const reachable = others.filter(m => m.online).length;
  // Payments: this device's own bubbles (from the desk, over an edge) and the notes the group shares about them.
  // A note is left out of the timeline only when one of these bubbles is about it: its own caption, or a payment answering it.
  const ownNotes = new Set(paymentRows.filter(m => captionOf(payments, notes, m, group.myKey) || payments[m.paymentId!]?.requestId)
    .map(m => noteIdOf(payments, m.paymentId!)));
  // Who wrote each member's message (their colour, their picture once per run): see `authorsOf`.
  // A bot's routines folded into one row count as one message of the run (the rest are under it, drawn when it opens).
  const authors = authorsFor(messages, stackHeads, group, ownNotes, key => memberPhoto(group, { key, me: false }, links, faceOf));
  /** A member's face in the Tasks panel, as their messages show it (`authorsOf`); none for my own cards ("me"). */
  const memberFace = (key: string): MemberFaceOf | undefined => key === "me" ? undefined : {
    key, name: group.members.find(x => x.key === key)?.nick || group.formerNames?.[key] || "",
    picture: memberPhoto(group, { key, me: false }, links, faceOf),
  };
  /** `inStack`: a message inside a folded row, as that row's writer, its picture beside the stack's last one. */
  const authorProps = (m: StoredMessage, inStack?: MessageAuthor) => {
    const author = inStack ?? authors.get(m.id);
    if (!author) return {};
    const inRoster = group.members.some(x => x.key === author.key);
    return { author, ...(inRoster && { onOpenAuthor: () => { setFocusMember(author.key); setShowMembers(true); } }) };
  };
  /** The contact who wrote a member's message, when they are one: told when an invoice in it is paid from its card. */
  const payeeOf = (m: StoredMessage) => {
    const linkId = m.member ? Object.keys(group.memberLinks).find(id => group.memberLinks[id] === m.member) : undefined;
    return linkId ? links?.find(l => l.id === linkId)?.peerPubKeyZ32 : undefined;
  };
  const peerOf = (paymentId: string) => paymentPeers[paymentId] ?? "";
  // A row of the timeline: an event, a payment's note, or a message.
  const row = (m: StoredMessage, inStack?: MessageAuthor) => m.event
    ? <div key={m.id} data-testid="group-event" className="flex justify-center mb-3.5 px-6"><span className="rounded-lg bg-surface-alt/90 px-3 py-1.5 text-center text-[11px] text-text-muted">{eventLine(m, group, t)}</span></div>
    // A note about a payment this device is part of is shown under its own bubble instead.
    : m.groupPay ? (ownNotes.has(m.groupPay.id) ? null : <GroupPaymentNote key={m.id} note={m.groupPay} group={group} />)
    : m.paymentId ? <div key={m.id} data-testid="group-payment">
      <MessageRow message={shownOf(m)} peerAck={Number.MAX_SAFE_INTEGER} peerPubKey={peerOf(m.paymentId)} linkId={`group:${groupId}`} {...forwarding.rowProps(shownOf(m))} {...authorProps(m, inStack)} />
      {(() => { const note = captionOf(payments, notes, m, group.myKey); return note && <GroupPaymentCaption note={note} group={group} />; })()}
    </div>
    // No `peerAck`: a group has no receipts (WISP 902), so a message of mine is sent, one tick, never "Delivered".
    : <MessageRow key={m.id} message={shownOf(m)} linkId={`group:${groupId}`} {...forwarding.rowProps(shownOf(m))} highlight={search.highlight(m.id)} {...authorProps(m, inStack)} payee={payeeOf(m)}
      onReply={replyTarget(m, true) && group.canSend ? () => replyRow(m) : undefined} quote={quoteOf(m)}
      buttons={group.canSend ? buttonsOf.get(m.id) : undefined} compactPress={presses.has(m.id)}
      onEdit={canEditInGroup(m) && !m.card && group.canSend ? () => editRow(m) : undefined}
      // Mine, as the group carried it (a text, a card, a file): taken off every member's device (WISP 400 § Delete for everyone).
      onDeleteForEveryone={m.sender === "me" && GROUP_MESSAGE_ID.test(m.id) && canRemove(m) && group.canSend ? () => removeRow(m) : undefined}
      onReact={replyTarget(m, true) && group.canSend ? emoji => react(m.id, emoji) : undefined} reactionName={reactionName}
      onPin={canPin && replyTarget(m, true) ? () => pinRow(m) : undefined} pinned={!!group.pin && replyTarget(m, true) === group.pin.id}
      onSave={m.event ? undefined : () => saveRow(m.id)} saved={savedHere.has(m.id)} />;
  // A first join through a link has the page to itself (the card). Someone removed from a community who opened its link
  // again still has the group as it was kept here: its history stays in the page, and the wait is a line above it.
  const joiningByLink = !!group.invitation?.viaLink && !group.status;
  // A contact's invitation, not answered yet (or on its way): its page says who invited and to what, with Accept and
  // Decline, and has nothing a member has (a field, Search, a folder). Over the history kept for a member invited back.
  const invited = !!group.invitation && !group.invitation.viaLink;
  // A member invited back keeps what was said while they were in (the engine gives such a group no status).
  const invitedFresh = invited && !group.status && messages.length === 0;
  const noTimeline = joiningByLink || invitedFresh;
  const knockingAgain = !!group.invitation?.viaLink && !!group.status;
  const waitingWith = group.invitation?.waiting ?? 0;
  const stage: GroupJoinStage = group.invitation?.stage ?? (group.invitation?.admin ? "admitted" : "knocked");
  // Nobody answered the link for an hour: the app stopped knocking, and Try again knocks again.
  const linkUnanswered = !!group.invitation?.viaLink && !!group.invitation.unanswered;
  // The link was replaced since it was shared: nothing more happens here, only the current link gets in.
  const linkReplaced = stage === "replaced";
  const joining = noLinks ? { title: t("group.connection.noWebrtc"), body: t("group.connection.noWebrtcHint") }
    : linkUnanswered ? { title: t("group.join.unanswered"), body: t("group.join.unansweredBody") }
    : joiningText(stage, group.name, group.profile === "community", t, group.invitation?.full, admittedLong, !!group.invitation?.othersKnocked);
  // The joining card's one live line: what changed, not the card. The five-minute line when let in and still no keys,
  // the two-minute hint while it shows; else at a dead
  // end (no transport, unanswered, replaced) its title; else the last step reached, or the title before the first.
  // Others waiting too (a community's queue, a private group's fresh knocks): the group is busy, not the link dead.
  const staleText = waitingWith > 0 || group.invitation?.othersKnocked ? t("group.join.staleBusy") : t("group.join.stale");
  const lastReached = joinSteps(group.profile === "community", t).filter(step => joinStepState(stage, step.stage) === "done").pop();
  const joinAnnouncement = noLinks || linkUnanswered || linkReplaced || stage === "full" || stage === "blocked" ? joining.title
    : admittedLong ? joining.body : knockedLong ? staleText : lastReached?.label ?? joining.title;
  // Just in (my own "You joined" line is recent), and no member reached yet: the edges are being set up.
  const justJoined = myJoins.some(at => Date.now() - at < JUST_JOINED_MS);
  const connecting = group.status === "active" && others.length > 0 && reachable === 0 && justJoined;
  const community = group.profile === "community" ? group.community : undefined;
  // Why I am out of it (removed, left, forked, lost), as the engine says it, in the app's language; else its status in a word.
  const outOfIt = group.status && group.status !== "active" ? (group.statusReason ? problemLine(group.statusReason, t) : groupStatusText(group.status, t)) : undefined;
  const count = group.members.length === 1 ? t("group.chat.memberOne") : t("group.chat.memberCount", { count: group.members.length });
  const subtitle = joiningByLink ? (group.invitation!.admin ? t("group.chat.joining") : t("group.chat.joiningByLink"))
    // A community with nobody else in it, as a private group: not "connecting…" (to nobody) nor relaying for others.
    : community && group.status === "active" ? (others.length === 0 ? count : community.hub ? t("group.chat.communityHub", { members: count })
      : community.connected ? t("group.chat.communityConnected", { members: count }) : t("group.chat.communityConnecting", { members: count }))
    : group.invitation?.takenBack ? t("sidebar.group.takenBack")
    : group.invitation && !knockingAgain ? (group.invitation.contact ? t("group.chat.invitation", { contact: group.invitation.contact }) : t("group.chat.invitationUnknown"))
    // Nobody else in it (just created, or everyone left): there is no one to reach, so only the count.
    : group.status === "active" ? (others.length === 0 ? count : t("group.chat.reachable", { members: count, reachable, total: others.length }))
    : outOfIt;
  // In a community every member can let people in, so every member hands the link out; in a private group, the admin.
  const canShare = group.status === "active" && (group.isAdmin || (group.profile === "community" && !!group.entryLink));
  const openShare = async () => {
    setError(null);
    // The link may be off: sharing it turns it on. On or not, the engine hears it is being handed out
    // (whoever gets it opens it soon, so this app looks for knocks faster a while).
    try { await engine.call("enableGroupLink", { groupId }); }
    catch (e) { if (!group.entryLink) { setError(e instanceof Error ? problemText(e, t) : { tone: "error", title: t("group.link.enableFailed") }); return; } }
    setSharing("share");
  };
  const act = async (action: () => Promise<unknown>) => {
    setMenuOpen(false); setError(null);
    try { await action(); } catch (e) { setError(e instanceof Error ? problemText(e, t) : { tone: "error", title: t("group.error.generic") }); }
  };

  return (
    <CueChat.Provider value={groupChat(groupId)}>
    <NowPlayingChat.Provider value={playingChat}>
    {/* Each member's colour, given out over the roster: the same on every member's device (lib/memberColors.ts). */}
    <MemberColorsProvider keys={group.members.map(m => m.key)}>
    {/* A file dropped anywhere on the group goes to the composer (`data-file-drop`), as in a chat. */}
    <div data-file-drop className="flex-1 flex flex-col h-full bg-chat-bg" data-testid="group-chat" data-status={group.status ?? "invitation"}>
      {/* A member's message that comes while the group is open, read out once to a screen reader. */}
      <MessageAnnouncer chat={groupId} messages={messages} nameOf={m => m.member ? authorName(group, m.member, t) : group.name || t("group.chat.unnamed")} />
      <div className="h-14 header-safe flex items-center justify-between px-4 max-md:pl-1 max-md:pr-1 bg-panel-header border-b border-border shrink-0">
        <div className="flex items-center gap-3 max-md:gap-1.5 min-w-0">
          {back}
          {/* With a picture, the avatar opens it large; without one, the members, as the line under the name does. A contact's
              invitation has no member yet (the engine knows only the count the card says): its avatar and line open nothing. */}
          {invited ? <GroupAvatar picture={group.picture} size={40} glyph={20} testId="group-avatar" className="bg-accent/15" />
          : <button ref={avatarButton} onClick={() => (group.picture ? setViewingPicture(true) : setShowMembers(true))} data-testid="group-avatar-open"
            className={`relative rounded-full shrink-0 max-md:p-0.5 ${group.picture ? "cursor-zoom-in" : ""}`}
            {...(group.picture ? { "aria-label": t("common.viewPhoto", { name: group.name || t("group.chat.unnamed") }) } : { title: t("group.chat.membersButton"), "aria-label": t("group.chat.membersButton") })}>
            <GroupAvatar picture={group.picture} size={40} glyph={20} testId="group-avatar" className="bg-accent/15" />
          </button>}
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              {/* In its own direction: a Latin name in Arabic is cut at its end, as in English, not at its start. The
                  screen's heading, as a menu page's title is (layout/Page.tsx), focusable by the page alone, never by Tab. */}
              <h1 ref={headingRef} tabIndex={-1} dir="auto" className="text-[15px] font-normal m-0 leading-tight truncate text-text-primary outline-none" data-testid="group-name">{group.name || t("group.chat.unnamed")}</h1>
            </div>
            {invited ? <p data-testid="group-members" className="m-0 max-w-full text-xs text-text-muted truncate">{subtitle}</p>
            // On a phone where a tap lands reaches up over the name: the line alone is 24px tall, under a thumb's 44px. The
            // cut with … is inside it, so it does not clip that taller area.
            : <button onClick={() => setShowMembers(true)} data-testid="group-members" className="relative block max-w-full text-start text-xs text-text-muted hover:text-accent cursor-pointer max-md:min-h-6 max-md:min-w-11 max-md:before:absolute max-md:before:inset-x-0 max-md:before:bottom-0 max-md:before:-top-5 max-md:before:content-['']">
              <span className="block truncate">
              <GroupTypingLine group={group}>{subtitle}</GroupTypingLine>
              </span>
            </button>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {group.status === "active" && <GroupConnection group={group} />}
          {/* Only while a bot's card is here (WISP 405 · Status Cards). */}
          <TasksButton rows={cardRows} nameOf={author => nameOf("peer", author) ?? `…${author.slice(-6)}`} faceOf={memberFace} />
          {canShare && <button ref={shareRef} onClick={() => void openShare()} data-testid="group-share" title={t("group.chat.shareHint")} aria-label={t("group.chat.shareLink")}
            className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-full bg-accent/15 px-3 text-sm font-semibold text-accent hover:bg-accent/25 max-md:min-h-11 max-md:min-w-11 max-md:px-2.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
            <span className="max-[480px]:hidden">{t("group.chat.shareLink")}</span>
          </button>}
          <div className="relative" ref={menuRef}>
            <button ref={optionsRef} onClick={() => setMenuOpen(!menuOpen)} onKeyDown={openOnArrow(() => setMenuOpen(true))} className="flex items-center justify-center p-2 max-md:h-11 max-md:w-11 max-md:p-0 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer" title={t("chat.options")} aria-haspopup="true" aria-expanded={menuOpen} data-testid="group-options">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" /></svg>
            </button>
            <Menu testId="group-options-menu" open={menuOpen} onClose={closeMenu} anchorRef={menuRef} focusFirst>
              {/* Not on a group not joined: it has no member list yet, and nothing comes from it to mute. */}
              {!invited && <MenuItem onClick={() => { setShowMembers(true); closeMenu(); }}>{t("group.menu.members")}</MenuItem>}
              {!invited && <MuteMenuItem chat={groupChat(group.id)} onChoose={() => { closeMenu(); setShowMute(true); }} onDone={closeMenu} />}
              {!invited && <TranslateMenuItem chat={groupChat(group.id)} onChoose={() => { closeMenu(); setShowTranslate(true); }} />}
              {!invited && <FolderMenuItem chat={groupChat(group.id)} onChoose={() => { closeMenu(); setShowFolders(true); }} />}
              {!noTimeline && !invited && <MenuItem testId="chat-search-open" onClick={() => { closeMenu(); search.show(); }} icon={<SearchIcon />}>{t("chat.search.open")}</MenuItem>}
              {group.isAdmin && <MenuItem testId="group-rotate" onClick={() => void act(() => engine.call("rotateGroup", { groupId }))}>{t("group.menu.rotate")}</MenuItem>}
              {!invited && <MenuSeparator />}
              {group.status === "active" && <MenuItem danger testId="group-leave" onClick={() => { closeMenu(); setConfirmLeave(true); }}>{t("group.menu.leave")}</MenuItem>}
              <MenuItem danger testId="group-forget" onClick={() => { closeMenu(); setConfirmForget(true); }}>{t("group.menu.forget")}</MenuItem>
            </Menu>
            <MuteMenu chat={groupChat(group.id)} open={showMute} onClose={() => setShowMute(false)} anchorRef={menuRef} mentions />
            <TranslateMenu chat={groupChat(group.id)} open={showTranslate} onClose={() => setShowTranslate(false)} anchorRef={menuRef} />
            <ChatFolderMenu chat={groupChat(group.id)} open={showFolders} onClose={() => setShowFolders(false)} anchorRef={menuRef} returnFocus={optionsRef} />
          </div>
        </div>
      </div>

      {/* On a phone the chat list's offline notice is on another screen: what is written here waits too. */}
      <OfflineBanner inChat />
      {!noTimeline && <ChatSearchBar search={search} />}
      {!noTimeline && <PinnedBar pin={group.pin} index={quoteIndex} onUnpin={canPin ? () => pinMessage(undefined, true) : undefined} returnFocus={optionsRef} />}

      {connecting && !error &&<div role="status" data-testid="group-connecting" className="px-4 py-2 text-xs bg-surface-alt text-text-secondary border-b border-border">
        {community ? t("group.chat.connectingCommunity") : t("group.chat.connectingMembers")}
      </div>}
      {group.adminOff && group.status === "active" && (group.isAdmin || group.profile === "community") && <ManageHere groupId={group.id} />}
      {group.entryJammed && group.isAdmin && group.status === "active" && <LinkJammed groupId={group.id} onReplaced={() => setSharing("share")} />}
      {/* Joiners the door let in whose side never came up, many lately: real ones may not get in. A new link, asked as
          every other New link is, and its share sheet opens on the new one. */}
      {group.isAdmin && group.status === "active" && !!community?.unansweredKnocks && <div role="status" data-testid="group-knocks-unanswered" className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs bg-surface-alt text-text-secondary border-b border-border">
        <span className="min-w-0 flex-1">{t("group.link.unanswered")}</span>
        <button type="button" data-testid="group-knocks-reset" {...working(resetting)} onClick={() => { if (!resetting) setAskingReset(true); }}
          className="rounded px-2 py-1 font-semibold text-accent hover:bg-accent/10 cursor-pointer data-[loading]:opacity-40 max-md:min-h-11 max-md:px-3">{t("group.link.reset")}</button>
        {askingReset && <GroupLinkAskDialog kind="reset" onClose={() => setAskingReset(false)} onConfirm={() => {
          setAskingReset(false);
          if (resetting) return;
          setResetting(true);
          void act(async () => { await engine.call("enableGroupLink", { groupId, reset: true }); setSharing("share"); }).finally(() => setResetting(false));
        }} />}
      </div>}
      {(error || (group.status && group.status !== "active")) && <div ref={noticeRef} tabIndex={-1} role="status" data-testid="group-notice" className="px-4 py-2 text-xs bg-surface-alt text-text-secondary border-b border-border">
        {error && <Notice problem={error} className="text-xs" />}
        {/* Knocking again: how far the knock got, and a way to stop asking that keeps the group here (a decline, not a delete). */}
        {knockingAgain ? <div className={`flex items-center justify-between gap-3${error ? " mt-2" : ""}`}>
          <p className="min-w-0"><span className="block font-medium text-text-primary">{joining.title}</span>{joining.body}
            {knockedLong && !linkUnanswered && <span data-testid="group-joining-stale" className="mt-1 block">{staleText}</span>}</p>
          {linkUnanswered && <button data-testid="group-link-retry" onClick={() => void act(() => engine.call("acceptGroupInvitation", { groupId }))}
            className="min-h-11 shrink-0 rounded-lg bg-accent px-3 text-xs font-semibold text-panel-header hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent">{t("group.join.tryAgain")}</button>}
          {/* The line goes with the knock it ends: the focus goes to the group's ⋮, which stays. */}
          <button data-testid="group-rejoin-cancel" onClick={() => void act(async () => { await engine.call("declineGroupInvitation", { groupId }); optionsRef.current?.focus(); })}
            className="min-h-11 shrink-0 rounded-lg px-3 text-xs text-text-secondary hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">{t("group.join.cancel")}</button>
        </div>
        : !error && (group.profile === "community" && group.status === "removed" ? t("group.chat.removedCommunity") : outOfIt)}
      </div>}
      <GroupOthers group={group} act={act} focusAfter={headingRef} />


      {invited && !invitedFresh && <GroupInvitationCard group={group} compact returnFocus={optionsRef} />}
      {invitedFresh ? <GroupInvitationCard group={group} returnFocus={optionsRef} />
      : joiningByLink ? <div className="flex flex-1 items-center justify-center overflow-y-auto chat-wallpaper px-4">
        {/* Not a live region as a whole: it re-read every step and Cancel joining at each change. The one short line
            under the steps says what changed, and each step says its own state (as the pairing scene's do). */}
        <div data-testid="group-joining" className="w-full max-w-sm rounded-2xl border border-border bg-sidebar-bg/95 p-6 text-center shadow-xl">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-accent/15 text-accent">
            <svg className={noLinks || linkUnanswered || linkReplaced ? undefined : "animate-spin"} width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.22-8.56" /></svg>
          </div>
          <h2 className="mt-4 text-base font-semibold text-text-primary">{joining.title}</h2>
          <p className="mt-2 text-sm leading-relaxed text-text-muted">{joining.body}</p>
          {!linkReplaced && <ol data-testid="group-joining-steps" data-stage={stage} className="mx-auto mt-4 w-fit space-y-1.5 text-start text-xs">
            {joinSteps(group.profile === "community", t).map(step => {
              const state = joinStepState(stage, step.stage);
              const done = state === "done", current = state === "current";
              return <li key={step.stage} data-state={state} aria-current={current ? "step" : undefined} className={`flex items-center gap-2 ${done ? "text-text-primary" : current ? "text-accent" : "text-text-muted"}`}>
                <span aria-hidden="true" className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${done ? "bg-accent text-on-accent" : current ? "border border-accent" : "border border-border"}`}>{done ? "✓" : ""}</span>
                {step.label}
                {done && <span className="sr-only"> ({t("pairing.done")})</span>}
              </li>;
            })}
          </ol>}
          {/* Said once per change, politely: the step just reached (the title before any, or at a dead end), or the
              two-minute hint. Hidden: the same words are on the card, and only this line changes. */}
          <p role="status" data-testid="group-joining-live" className="sr-only">{joinAnnouncement}</p>
          {/* Others knocking too: a wait behind them, said as soon as it is known (a community lets people in a few at a time). */}
          {waitingWith > 0 && (stage === "knocking" || stage === "knocked") && <p data-testid="group-joining-queue" className="mt-4 text-xs leading-relaxed text-text-muted">
            {waitingWith === 1 ? t("group.join.queueOne") : t("group.join.queueCount", { count: waitingWith })}</p>}
          {knockedLong && !linkUnanswered && <p data-testid="group-joining-stale" className="mt-4 text-xs leading-relaxed text-text-muted">{staleText}</p>}
          {linkUnanswered && <button data-testid="group-link-retry" onClick={() => void act(() => engine.call("acceptGroupInvitation", { groupId }))}
            className="mt-4 block w-full min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-panel-header hover:bg-accent-hover">{t("group.join.tryAgain")}</button>}
          <button onClick={cancelJoin} data-testid="group-joining-cancel"
            className="mt-4 rounded px-2 py-1 text-xs text-text-muted hover:bg-danger/10 hover:text-danger max-md:min-h-11 max-md:px-3">{t("group.join.cancel")}</button>
        </div>
      </div> : <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={jump.listRef} data-message-list aria-busy={reading || undefined} className="flex-1 overflow-y-auto [overflow-anchor:none] chat-wallpaper">
        {/* A bubble arriving slides in from its side: clipped here, it never makes the list scroll sideways (a scrollbar, and a jump). */}
        <div ref={jump.columnRef} className="max-w-3xl mx-auto py-3 overflow-x-clip">
          {reading && <div data-testid="group-reading" className="flex justify-center py-6 text-text-muted"><Spinner size={20} /></div>}
          {(() => {
            const drawn = messages.slice(rowWindow.from, rowWindow.to);
            return <DaySections rows={drawn} days={days} from={rowWindow.from} draw={m => {
              if (stackHeads.has(m.id)) return null;
              const run = stacks.get(m.id);
              if (!run) return row(m);
              // The folded row is one message of its sender's run: their colour, and their picture when it ends the run.
              return <RoutineStack key={`stack:${m.id}`} name={m.sender === "me" || authors.get(m.id)?.first === false ? undefined : nameOf("peer", m.member) ?? undefined} mine={m.sender === "me"}
                cards={run.map(r => r.card as RoutineCard)} {...authorProps(m)}>
                {run.map((r, i) => { const head = authors.get(m.id); return row(r, head && { ...head, first: false, last: i === run.length - 1 }); })}
              </RoutineStack>;
            }} />;
          })()}
        </div>
      </div>
      <JumpToLatest count={jump.count} far={jump.far} onJump={jump.toNew} />
      </div>}

      {!noTimeline && forwarding.bar}
      {forwarding.dialog}
      {!joiningByLink && !invited && !forwarding.selecting && <MessageInput draftId={`group:${groupId}`} key={groupId} onSend={send} disabled={!group.canSend} maxLength={16_384} textBytes={16_384} recipient={group.name} mentions={mentions}
        translation={composerTranslation}
        onTyping={group.profile === "mesh" ? onTyping : undefined}
        reply={replyingTo ? { key: replyingTo.id, name: nameOf(replyingTo.sender === "me" ? "me" : "peer", replyingTo.member), snippet: messageSnippet(replyingTo, t),
          mine: replyingTo.sender === "me", ...(replyingTo.sender === "peer" && replyingTo.member && { member: replyingTo.member }), onCancel: () => setReplyingTo(null) } : undefined}
        // Editing one of mine (WISP 902 § Edits): the new text shows here at once and goes to the members; @ names more.
        edit={editing ? { key: editing.id, text: editing.text, snippet: replySnippet(editing.text), onClose: () => setEditing(null),
          onSave: async (text, extra) => (await engine.call("editMessage", { linkId: `group:${groupId}`, messageId: editing.id, text, ...(extra?.mentions?.length && { mentions: extra.mentions }) })
            .then(result => ({ error: result.error && problemLine(result.error, t) }), (e: unknown) => ({ error: e instanceof Error ? problemLine(e, t) : t("group.chat.editFailed") }))).error } : undefined}
        onEditLast={group.canSend ? () => {
          const last = [...messages].reverse().find(m => canEditInGroup(m) && !m.card);
          if (last) { setReplyingTo(null); setEditing(last); }
        } : undefined}
        onSendFile={platform?.sendGroupFile ? sendFile : undefined}
        paymentsUnavailable={others.length === 0 ? t("group.chat.nobodyElse") : undefined}
        paymentComposer={close => <GroupPaymentComposer group={group} onClose={close} />} />}
      {/* Translate's question for a model that is not here yet. */}
      {translateQuestion}

      {showMembers && <GroupMembersDialog group={group} focusKey={focusMember} returnFocus={optionsRef} onClose={() => { setShowMembers(false); setFocusMember(undefined); }} />}
      {viewingPicture && group.picture && <AvatarViewer src={group.picture} name={group.name || t("group.chat.unnamed")} returnFocus={avatarButton} onClose={() => setViewingPicture(false)} />}
      {sharing && (group.entryLink || shareShown) && <GroupShareDialog group={group} created={sharing === "created"} returnFocus={shareBack} onClose={closeShare} />}
      {confirmLeave && <LeaveGroupDialog group={group} returnFocus={optionsRef} onClose={() => setConfirmLeave(false)}
        onConfirm={async () => { await engine.call("leaveGroup", { groupId }); goneHere(); setConfirmLeave(false); nav.home(); }} />}
      {/* Deleting an active group, private or community, leaves it: said so, and refused as Leave is while nobody could
          become admin or take the leave. */}
      {confirmForget && group.status === "active" ? <LeaveGroupDialog forget group={group} returnFocus={optionsRef} onClose={() => setConfirmForget(false)}
        onConfirm={async () => { await engine.call("forgetGroup", { groupId }); goneHere(); setConfirmForget(false); nav.home(); }} />
      : confirmForget && <DeleteChatDialog name={group.name} onClose={() => setConfirmForget(false)}
        title={group.name ? t("group.leave.forgetTitle", { name: group.name }) : t("group.leave.forgetTitleUnnamed")} confirm={t("group.menu.forget")}
        // What goes: an invitation (declined, and its sender told; one taken back tells nobody), with the history kept
        // here from before when there is one (Decline keeps it, Delete does not), a first knock through the link, or a
        // group kept with its history.
        body={joiningByLink ? t("group.forget.joining") : group.invitation?.takenBack ? t("group.forget.takenBack") : group.invitation && !knockingAgain
          ? (messages.length > 0
            ? (group.invitation.contact ? t("group.forget.invitationKept", { contact: group.invitation.contact }) : t("group.forget.invitationKeptUnknown"))
            : (group.invitation.contact ? t("group.forget.invitation", { contact: group.invitation.contact }) : t("group.forget.invitationUnknown")))
          : t("group.forget.kept")}
        // A group I am no longer in (removed, left, an invitation): nothing to leave, only its history here goes.
        onConfirm={() => { setConfirmForget(false); void act(async () => { await engine.call("forgetGroup", { groupId }); goneHere(); nav.home(); }); }} />}
    </div>
    </MemberColorsProvider>
    </NowPlayingChat.Provider>
    </CueChat.Provider>
  );
}

/**
 * The group's link lets nobody in: its knocks keep coming from apps that never connect, and they take the places a
 * joiner is answered in (`GroupView.entryJammed`). A new link, asked as the link panel's is, reaches none of them; the
 * new link is shown to share again.
 */
function LinkJammed({ groupId, onReplaced }: { groupId: string; onReplaced(): void }) {
  const { t } = useI18n();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const confirm = () => {
    setAsking(false);
    if (busy) return;
    setBusy(true); setProblem(null);
    void engine.call("enableGroupLink", { groupId, reset: true }).then(onReplaced, e => setProblem(problemText(e, t))).finally(() => setBusy(false));
  };
  return (
    <div role="status" data-testid="group-link-jammed" className="px-4 py-2 text-xs bg-surface-alt text-text-secondary border-b border-border space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-warn-ink">{t("group.link.jammed")}</span>
        <button type="button" data-testid="group-link-jammed-reset" {...working(busy)} onClick={() => { if (!busy) setAsking(true); }}
          className="rounded px-2 py-1 font-semibold text-accent hover:bg-accent/10 cursor-pointer data-[loading]:opacity-40 max-md:min-h-11 max-md:px-3">{t("group.link.reset")}</button>
      </div>
      {asking && <GroupLinkAskDialog kind="reset" onClose={() => setAsking(false)} onConfirm={confirm} />}
      {problem && <Notice problem={problem} className="text-xs" />}
    </div>
  );
}

/**
 * "Manage groups from this device" (WISP 06 § Forced takeover): after a forced takeover or a restore this device signs no
 * commit and takes no door duty in the group until the person turns it on here, having read what that risks.
 */
function ManageHere({ groupId }: { groupId: string }) {
  const { t } = useI18n();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  // Turn on and Cancel each take the other's place: the focus they had goes across, not to the page.
  const turnOn = useRef<HTMLButtonElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const pressed = useRef(false);
  useEffect(() => {
    if (!pressed.current) return;
    pressed.current = false;
    (asking ? cancel : turnOn).current?.focus({ preventScroll: true });
  }, [asking]);
  const ask = (on: boolean) => { pressed.current = true; setProblem(null); setAsking(on); };
  const confirm = () => {
    if (busy) return;
    setBusy(true); setProblem(null);
    void engine.call("setGroupManage", { groupId, on: true }).catch(e => setProblem(problemText(e, t))).finally(() => setBusy(false));
  };
  return (
    <div role="status" data-testid="group-manage-off" className="px-4 py-2 text-xs bg-surface-alt text-text-secondary border-b border-border space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">{t("devices.manage.off")}</span>
        {!asking && <button ref={turnOn} type="button" data-testid="group-manage-open" onClick={() => ask(true)} className="rounded px-2 py-1 font-semibold text-accent hover:bg-accent/10 cursor-pointer max-md:min-h-11 max-md:px-3">{t("devices.manage.turnOn")}</button>}
      </div>
      {asking && (
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="group-manage-warning" className="min-w-0 flex-1 text-danger-ink">{t("devices.manage.warning")}</span>
          <button type="button" data-testid="group-manage-confirm" {...working(busy)} onClick={confirm}
            className="rounded px-2 py-1 font-semibold text-accent hover:bg-accent/10 cursor-pointer data-[loading]:opacity-40 max-md:min-h-11 max-md:px-3">{t("devices.manage.confirm")}</button>
          <button ref={cancel} type="button" data-testid="group-manage-cancel" onClick={() => ask(false)} className="rounded px-2 py-1 hover:bg-surface-hover cursor-pointer max-md:min-h-11 max-md:px-3">{t("common.cancel")}</button>
        </div>
      )}
      {problem && <Notice problem={problem} testId="group-manage-problem" className="text-xs" />}
    </div>
  );
}
