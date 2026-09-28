import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CueChat } from "../lib/cues";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { engine } from "@ghostly/browser/platform/engine";
import type { EngineState, GroupJoinStage, GroupPayNote, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../components/MessageBubble";
import { MessageInput } from "../components/MessageInput";
import { JumpToLatest } from "../components/chat/JumpToLatest";
import { useChatScroll } from "../hooks/useChatScroll";
import { GroupMembersDialog } from "../components/GroupMembersDialog";
import { DeleteChatDialog } from "../components/DeleteChatDialog";
import { LeaveGroupDialog } from "../components/LeaveGroupDialog";
import { GroupShareDialog } from "../components/GroupLinkPanel";
import { GroupConnection } from "../components/GroupConnection";
import { GroupPaymentComposer } from "../components/GroupPaymentComposer";
import { GroupPaymentCaption, GroupPaymentNote } from "../components/GroupPaymentNote";
import { Menu, MenuItem, MenuSeparator } from "../components/Menu";
import { MuteMenu, MuteMenuItem } from "../components/ChatMute";
import { forgetChatMute, groupChat } from "../lib/chatMute";
import { useI18n } from "../contexts/I18nContext";
import { markGroupRead, memberName } from "../lib/groups";
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
import { replySnippet, type GroupMention } from "@ghostly/core";
import { quoteFor, replyIndex, replyTarget, type NameOf, type QuoteView } from "../lib/replies";
import { useForwarding } from "../hooks/useForwarding";
import { canEditInGroup } from "@ghostly/browser/shared/edits";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;

/** `myName`: how a mention of me reads (my own name, as a member sees it); the others go by the roster's names. */
function toChatMessage(message: StoredMessage, group: GroupView, myName = ""): ChatMessage {
  const member = message.member ? group.members.find(m => m.key === message.member) : undefined;
  const names = group.members.map(m => ({ key: m.key, me: m.me, name: m.me ? myName : memberName(m) }));
  const mentions = mentionViews(message.text, message.mentions, names, message.sender === "me");
  return { id: message.id, text: message.text, sender: message.sender, timestamp: message.timestamp, paymentId: message.paymentId,
    nick: message.sender === "peer" && message.member ? (member ? memberName(member) : `Member ${message.member.slice(0, 8)}`) : undefined,
    ...(mentions.length ? { mentions } : {}), ...(message.replyTo && { replyTo: message.replyTo }), ...(message.reactions && { reactions: message.reactions }),
    ...(message.edit && { edit: message.edit }), ...(message.forwarded && { forwarded: message.forwarded }) };
}

/** A member as a reply's quote names them: me, the roster's name, or the start of a key no longer in the roster. */
const replyNames = (group: GroupView, you: string): NameOf => (from, key) => {
  if (from === "me") return you;
  const member = key ? group.members.find(m => m.key === key) : undefined;
  return member ? (member.me ? you : memberName(member)) : key ? `Member ${key.slice(0, 8)}` : undefined;
};

/** Whom "@" offers in the composer: every other member, by name and the end of their key. */
function mentionCandidates(group: GroupView): MentionCandidate[] {
  return group.members.filter(m => !m.me).map(m => ({ key: m.key, name: memberName(m), tag: `…${m.key.slice(-6)}` }));
}

/** The group note a payment of this device is part of: a request's own, or the request a payment answers. */
function noteIdOf(state: EngineState, paymentId: string): string {
  const payment = state.payments[paymentId];
  return payment?.kind === "payment" && payment.requestId ? payment.requestId : paymentId;
}

/** A membership line, naming its member as the roster knows them now; what was stored, when they are gone. */
function eventText(message: StoredMessage, group: GroupView): string {
  const member = message.member ? group.members.find(m => m.key === message.member) : undefined;
  if (!member) return message.text;
  if (message.event === "joined") return `${memberName(member)} joined`;
  if (message.event === "admin") return `${memberName(member)} ${member.me ? "are" : "is"} now the admin`;
  if (message.event === "picture") return `${memberName(member)} ${message.text.endsWith("removed the group's picture") ? "removed" : "changed"} the group's picture`;
  const renamed = message.event === "renamed" ? message.text.indexOf(" renamed the group to “") : -1;
  if (renamed >= 0) return `${memberName(member)}${message.text.slice(renamed)}`;
  return message.text;
}

/**
 * A join through a link, step by step: what the joiner's app knows so far, never more. In a community
 * any member's app answers. The last step ("in", connecting to the members) starts once let in; this
 * screen gives way to the chat when it does, with a notice until someone is reached.
 */
type JoinStep = GroupJoinStage | "in";
const joinSteps = (community: boolean): { stage: JoinStep; label: string }[] => [
  { stage: "knocked", label: community ? "Knock sent to the group" : "Knock left for the admin's app" },
  { stage: "answered", label: community ? "A member's app is answering" : "The admin's app answered" },
  { stage: "admitted", label: "Let in: getting the group's keys" },
  { stage: "in", label: community ? "Connecting to the group" : "Connecting to the members" },
];
/** How long after joining a group with nobody reached yet says it is still connecting (later, they are simply away). */
const JUST_JOINED_MS = 5 * 60_000;
const NO_MESSAGES: StoredMessage[] = [];
const JOIN_ORDER: JoinStep[] = ["knocking", "knocked", "answered", "admitted", "in"];

function joiningText(stage: GroupJoinStage, name: string, community: boolean): { title: string; body: string } {
  const who = community ? "A member's app" : "The admin's app";
  if (stage === "admitted") return { title: `Joining ${name || "the group"}…`, body: `${who} answered: getting the group's keys. You are in in a moment.` };
  if (stage === "answered") return { title: community ? "A member is letting you in" : "Waiting to be let in", body: `${who} saw you knock and is connecting to you. You are in in a moment.` };
  if (stage === "knocked") return { title: "Waiting to be let in", body: community
    ? "Waiting for someone in the group to let you in. It happens on its own as soon as any member's app is open: you can leave this page and come back."
    : "Waiting for the admin's app to let you in. It happens on its own as soon as their app is open: you can leave this page and come back." };
  return { title: "Waiting to be let in", body: community ? "Leaving a knock where the group's apps look for one…" : "Leaving a knock where the admin's app looks for one…" };
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
  /** The message of mine the composer edits (WISP 9xx § Edits). */
  const [editing, setEditing] = useState<StoredMessage | null>(null);
  useEffect(() => { setReplyingTo(null); setEditing(null); }, [groupId]);
  const quoteIndex = useMemo(() => replyIndex(messages, true), [messages]);
  const [showMembers, setShowMembers] = useState(false);
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
  const shown = useMemo(() => group ? messages.filter(m => !m.event && !m.groupPay).map(m => toChatMessage(m, group, settings.defaultNickname)) : [],
    [messages, group, settings.defaultNickname]);
  const forwarding = useForwarding(group ? `group:${groupId}` : undefined, shown);
  // By id: a row looks its message up once per draw, and a long group has thousands of rows.
  const shownById = useMemo(() => new Map(shown.map(c => [c.id, c])), [shown]);
  const shownOf = (m: StoredMessage) => shownById.get(m.id) ?? toChatMessage(m, group!, settings.defaultNickname);
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
    const show = (list: StoredMessage[]) => { if (current) setLoaded({ groupId, list }); };
    void engine.call("groupMessages", { groupId }).then(show).catch(() => {});
    const off = engine.onMessages((linkId, list) => { if (linkId === `group:${groupId}`) show(list); });
    return () => { current = false; off(); };
  }, [groupId]);
  // At the bottom a new message keeps the view there; scrolled up, nothing moves it and the ↓ pill counts the members'.
  const scrollRows = useMemo(() => messages.filter(m => !m.event && !m.groupPay).map(m => ({ id: m.id, mine: m.sender === "me" })), [messages]);
  const jump = useChatScroll({ rows: scrollRows, chat: groupId });
  useEffect(() => { if (group) markGroupRead(group.id, Math.max(group.lastMessageAt, Date.now())); }, [group?.id, group?.lastMessageAt, group]);

  const send = useCallback(async (text: string, mentions?: GroupMention[]): Promise<string | null> => {
    const answering = replyingTo;
    try {
      const { error } = await engine.call("sendGroupMessage", { groupId, text, ...(mentions?.length && { mentions }), ...(answering && { replyTo: answering.id }) });
      if (!error && answering) setReplyingTo(current => current === answering ? null : current);
      return error;
    }
    catch (e) { return e instanceof Error ? e.message : "Could not send"; }
  }, [groupId, replyingTo]);

  // Typing (WISP 9xx · Group Mesh § Typing): private groups only; a community does not carry it yet.
  const onTyping = useGroupTypingSender(rosterGroup?.profile === "mesh" && rosterGroup.status === "active" ? groupId : undefined);
  const typers = useMemo(() => (group?.typing ?? []).map(({ key, kind, status }): GroupTyper => {
    const member = group!.members.find(m => m.key === key);
    return { name: member ? memberName(member) : `Member ${key.slice(0, 8)}`, ...(kind ? { kind } : {}), ...(status ? { status } : {}) };
  }), [group]);

  // "@everyone": a private group's admin only; a community has no everyone (WISP 9xx § Mentions).
  const mentions = useMemo(() => group ? { candidates: mentionCandidates(group), everyone: group.profile === "mesh" && group.isAdmin } : undefined, [group]);

  if (!state) return null;
  if (!group) return <div className="flex flex-1 items-center justify-center text-sm text-text-muted">This group is gone from this device.</div>;
  const nameOf = replyNames(group, t("chat.reply.you"));
  const quoteOf = (m: StoredMessage): QuoteView | undefined => m.replyTo && quoteFor(m.replyTo, quoteIndex, nameOf);
  // Reactions (WISP 9xx § Reactions): one per member per message, named by the roster.
  const react = (messageId: string, emoji: string) => { void engine.call("react", { linkId: `group:${groupId}`, messageId, emoji }).catch(() => {}); };
  const reactionName = (by: string) => nameOf("peer", by) ?? by.slice(0, 8);

  const others = group.members.filter(m => !m.me);
  const reachable = others.filter(m => m.online).length;
  // Payments: this device's own bubbles (from the desk, over an edge) and the notes the group shares about them.
  const notes = new Map<string, GroupPayNote>(messages.filter(m => m.groupPay).map(m => [m.groupPay!.id, m.groupPay!]));
  const ownNotes = new Set(messages.filter(m => m.paymentId && !m.groupPay).map(m => noteIdOf(state, m.paymentId!)));
  const peerOf = (paymentId: string) => { const linkId = state.payments[paymentId]?.linkId; return state.edges?.find(l => l.id === linkId)?.peerPubKeyZ32 ?? ""; };
  const joiningByLink = group.invitation?.viaLink;
  const stage: GroupJoinStage = group.invitation?.stage ?? (group.invitation?.admin ? "admitted" : "knocked");
  const joining = joiningText(stage, group.name, group.profile === "community");
  // Just in (my own "You joined" line is recent), and no member reached yet: the edges are being set up.
  const justJoined = messages.some(m => m.event === "joined" && !m.member && Date.now() - m.timestamp < JUST_JOINED_MS);
  const connecting = group.status === "active" && others.length > 0 && reachable === 0 && justJoined;
  const community = group.profile === "community" ? group.community : undefined;
  const count = `${group.members.length} member${group.members.length === 1 ? "" : "s"}`;
  const subtitle = joiningByLink ? (group.invitation!.admin ? "Joining…" : "Joining through a link")
    : community && group.status === "active" ? `${count} · ${community.hub ? "your app relays for others" : community.connected ? "connected" : "connecting…"}`
    : group.invitation ? `Invitation from ${group.invitation.contact || "a contact"}`
    : group.status === "active" ? `${count} · ${reachable} of ${others.length} reachable`
    : group.statusReason ?? group.status;
  // In a community every member can let people in, so every member hands the link out; in a private group, the admin.
  const canShare = group.status === "active" && (group.isAdmin || (group.profile === "community" && !!group.entryLink));
  const openShare = async () => {
    setError("");
    // The link may be off: sharing it turns it on. On or not, the engine hears it is being handed out
    // (whoever gets it opens it soon, so this app looks for knocks faster a while).
    try { await engine.call("enableGroupLink", { groupId }); }
    catch (e) { if (!group.entryLink) { setError(e instanceof Error ? e.message : "Could not turn the link on"); return; } }
    setSharing("share");
  };
  const act = async (action: () => Promise<unknown>) => {
    setMenuOpen(false); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "That did not work"); }
  };

  return (
    <CueChat.Provider value={groupChat(groupId)}>
    <div className="flex-1 flex flex-col h-full bg-chat-bg" data-testid="group-chat" data-status={group.status ?? "invitation"}>
      <div className="h-14 header-safe flex items-center justify-between px-4 max-md:pl-1 max-md:pr-1 bg-panel-header border-b border-border shrink-0">
        <div className="flex items-center gap-3 max-md:gap-1.5 min-w-0">
          <button onClick={nav.up} className="md:hidden w-11 h-11 flex items-center justify-center text-text-secondary rounded-full active:bg-surface-hover cursor-pointer shrink-0" title="Back" data-testid="chat-back">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 19l-7-7 7-7" /></svg>
          </button>
          {/* With a picture, the avatar opens it large; without one, the members, as the line under the name does. */}
          <button ref={avatarButton} onClick={() => (group.picture ? setViewingPicture(true) : setShowMembers(true))} data-testid="group-avatar-open"
            className={`relative rounded-full shrink-0 ${group.picture ? "cursor-zoom-in" : ""}`}
            {...(group.picture ? { "aria-label": t("common.viewPhoto", { name: group.name || "A group" }) } : { title: "Members", "aria-label": "Members" })}>
            <GroupAvatar picture={group.picture} size={40} glyph={20} testId="group-avatar" className="bg-accent/15" />
          </button>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="text-[15px] m-0 leading-tight truncate text-text-primary" data-testid="group-name">{group.name || "A group"}</p>
            </div>
            <button onClick={() => setShowMembers(true)} data-testid="group-members" className="block text-xs text-text-muted/80 truncate hover:text-accent cursor-pointer max-w-[60vw]">
              {/* Who is typing while it lasts, in place of the member count, as a 1:1 chat's header does. */}
              <span role="status" aria-live="polite">{typers.length ? <GroupTypingText testId="group-typing" typers={typers} /> : subtitle}</span>
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {group.status === "active" && <GroupConnection group={group} />}
          {canShare && <button onClick={() => void openShare()} data-testid="group-share" title="Share the group's link" aria-label="Share link"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-accent/15 px-3 text-sm font-semibold text-accent hover:bg-accent/25 max-md:min-h-11 max-md:px-2.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
            <span className="max-[480px]:hidden">Share link</span>
          </button>}
          <div className="relative" ref={menuRef}>
            <button onClick={() => setMenuOpen(!menuOpen)} className="p-2 max-md:p-2.5 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer" title={t("chat.options")} aria-haspopup="true" aria-expanded={menuOpen} data-testid="group-options">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" /></svg>
            </button>
            <Menu testId="group-options-menu" open={menuOpen} onClose={closeMenu} anchorRef={menuRef}>
              <MenuItem onClick={() => { setShowMembers(true); closeMenu(); }}>{t("group.menu.members")}</MenuItem>
              <MuteMenuItem chat={groupChat(group.id)} onChoose={() => { closeMenu(); setShowMute(true); }} onDone={closeMenu} />
              {group.isAdmin && <MenuItem testId="group-rotate" onClick={() => void act(() => engine.call("rotateGroup", { groupId }))}>{t("group.menu.rotate")}</MenuItem>}
              <MenuSeparator />
              {group.status === "active" && <MenuItem danger testId="group-leave" onClick={() => { closeMenu(); setConfirmLeave(true); }}>{t("group.menu.leave")}</MenuItem>}
              <MenuItem danger testId="group-forget" onClick={() => { closeMenu(); setConfirmForget(true); }}>{t("group.menu.forget")}</MenuItem>
            </Menu>
            <MuteMenu chat={groupChat(group.id)} open={showMute} onClose={() => setShowMute(false)} anchorRef={menuRef} mentions />
          </div>
        </div>
      </div>

      {connecting && !error && <div role="status" data-testid="group-connecting" className="px-4 py-2 text-xs bg-surface-alt text-text-secondary border-b border-border">
        {community ? "You are in. Connecting to the group: messages go out as soon as a member's app is reached." : "You are in. Connecting to the members: messages go out as soon as one of them is reached."}
      </div>}
      {(error || (group.status && group.status !== "active")) && <div role="status" data-testid="group-notice" className="px-4 py-2 text-xs bg-surface-alt text-text-secondary border-b border-border">
        {error || group.statusReason}
      </div>}


      {joiningByLink ? <div className="flex flex-1 items-center justify-center overflow-y-auto chat-wallpaper px-4">
        <div role="status" data-testid="group-joining" className="w-full max-w-sm rounded-2xl border border-border bg-sidebar-bg/95 p-6 text-center shadow-xl">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-accent/15 text-accent">
            <svg className="animate-spin" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.22-8.56" /></svg>
          </div>
          <h2 className="mt-4 text-base font-semibold text-text-primary">{joining.title}</h2>
          <p className="mt-2 text-sm leading-relaxed text-text-muted">{joining.body}</p>
          <ol data-testid="group-joining-steps" data-stage={stage} className="mx-auto mt-4 w-fit space-y-1.5 text-left text-xs">
            {joinSteps(group.profile === "community").map(step => {
              const done = JOIN_ORDER.indexOf(stage) >= JOIN_ORDER.indexOf(step.stage);
              const current = !done && JOIN_ORDER[JOIN_ORDER.indexOf(step.stage) - 1] === stage;
              return <li key={step.stage} data-state={done ? "done" : current ? "current" : "todo"} className={`flex items-center gap-2 ${done ? "text-text-primary" : current ? "text-accent" : "text-text-muted/60"}`}>
                <span aria-hidden="true" className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${done ? "bg-accent text-on-accent" : current ? "border border-accent" : "border border-border"}`}>{done ? "✓" : ""}</span>
                {step.label}
              </li>;
            })}
          </ol>
          <button onClick={() => { void engine.call("forgetGroup", { groupId }).catch(() => {}); nav.home(); }} data-testid="group-joining-cancel"
            className="mt-4 rounded px-2 py-1 text-xs text-text-muted hover:bg-danger/10 hover:text-danger">Cancel joining</button>
        </div>
      </div> : <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={jump.listRef} data-message-list className="flex-1 overflow-y-auto [overflow-anchor:none] chat-wallpaper">
        <div ref={jump.columnRef} className="max-w-3xl mx-auto py-3">
          {messages.map(m => m.event
            ? <div key={m.id} data-testid="group-event" className="flex justify-center mb-3.5 px-6"><span className="rounded-lg bg-surface-alt/90 px-3 py-1.5 text-center text-[11px] text-text-muted">{eventText(m, group)}</span></div>
            // A note about a payment this device is part of is shown under its own bubble instead.
            : m.groupPay ? (ownNotes.has(m.groupPay.id) ? null : <GroupPaymentNote key={m.id} note={m.groupPay} group={group} />)
            : m.paymentId ? <div key={m.id} data-testid="group-payment">
              <MessageBubble message={shownOf(m)} peerAck={Number.MAX_SAFE_INTEGER} peerPubKey={peerOf(m.paymentId)} linkId={`group:${groupId}`} {...forwarding.rowProps(shownOf(m))} />
              {/* Said once, under the request (or the payment) itself: not again under a payment that answers it. */}
              {noteIdOf(state, m.paymentId) === m.paymentId && notes.get(m.paymentId) && <GroupPaymentCaption note={notes.get(m.paymentId)!} group={group} />}
            </div>
            : <MessageBubble key={m.id} message={shownOf(m)} peerAck={Number.MAX_SAFE_INTEGER} linkId={`group:${groupId}`} {...forwarding.rowProps(shownOf(m))}
              onReply={replyTarget(m, true) ? () => { setEditing(null); setReplyingTo(m); } : undefined} quote={quoteOf(m)}
              onEdit={canEditInGroup(m) && group.canSend ? () => { setReplyingTo(null); setEditing(m); } : undefined}
              onReact={replyTarget(m, true) && group.canSend ? emoji => react(m.id, emoji) : undefined} reactionName={reactionName} />)}
        </div>
      </div>
      <JumpToLatest count={jump.count} far={jump.far} onJump={jump.toNew} />
      </div>}

      {!joiningByLink && forwarding.bar}
      {forwarding.dialog}
      {!joiningByLink && !forwarding.selecting && <MessageInput draftId={`group:${groupId}`} key={groupId} onSend={send} disabled={!group.canSend} maxLength={16_384} recipient={group.name} mentions={mentions}
        onTyping={group.profile === "mesh" ? onTyping : undefined}
        reply={replyingTo ? { key: replyingTo.id, name: nameOf(replyingTo.sender === "me" ? "me" : "peer", replyingTo.member), snippet: replySnippet(replyingTo.text),
          mine: replyingTo.sender === "me", onCancel: () => setReplyingTo(null) } : undefined}
        // Editing one of mine (WISP 9xx § Edits): the new text shows here at once and goes to the members; @ names more.
        edit={editing ? { key: editing.id, text: editing.text, snippet: replySnippet(editing.text), onClose: () => setEditing(null),
          onSave: async (text, extra) => (await engine.call("editMessage", { linkId: `group:${groupId}`, messageId: editing.id, text, ...(extra?.mentions?.length && { mentions: extra.mentions }) })
            .catch((e: unknown) => ({ error: e instanceof Error ? e.message : "Could not edit the message" }))).error } : undefined}
        onEditLast={group.canSend ? () => {
          const last = [...messages].reverse().find(canEditInGroup);
          if (last) { setReplyingTo(null); setEditing(last); }
        } : undefined}
        fileUnavailable="Files are not part of groups yet"
        paymentsUnavailable={others.length === 0 ? "Nobody else is in the group yet" : undefined}
        paymentComposer={close => <GroupPaymentComposer group={group} onClose={close} />} />}

      {showMembers && <GroupMembersDialog group={group} onClose={() => setShowMembers(false)} />}
      {viewingPicture && group.picture && <AvatarViewer src={group.picture} name={group.name || "A group"} returnFocus={avatarButton} onClose={() => setViewingPicture(false)} />}
      {sharing && group.entryLink && <GroupShareDialog group={group} created={sharing === "created"} onClose={() => setSharing("")} />}
      {confirmLeave && <LeaveGroupDialog group={group} onClose={() => setConfirmLeave(false)}
        onConfirm={async () => { await engine.call("leaveGroup", { groupId }); setConfirmLeave(false); nav.home(); }} />}
      {confirmForget && <DeleteChatDialog name={group.name} onClose={() => setConfirmForget(false)}
        onConfirm={() => { setConfirmForget(false); forgetChatMute(groupChat(groupId)); void engine.call("forgetGroup", { groupId }).catch(() => {}); nav.home(); }} />}
    </div>
    </CueChat.Provider>
  );
}
