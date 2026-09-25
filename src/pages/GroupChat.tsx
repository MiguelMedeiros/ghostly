import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { engine } from "@ghostly/browser/platform/engine";
import type { EngineState, GroupJoinStage, GroupPayNote, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../components/MessageBubble";
import { MessageInput } from "../components/MessageInput";
import { GroupMembersDialog } from "../components/GroupMembersDialog";
import { DeleteChatDialog } from "../components/DeleteChatDialog";
import { LeaveGroupDialog } from "../components/LeaveGroupDialog";
import { GroupShareDialog } from "../components/GroupLinkPanel";
import { GroupConnection } from "../components/GroupConnection";
import { GroupPaymentComposer } from "../components/GroupPaymentComposer";
import { GroupPaymentCaption, GroupPaymentNote } from "../components/GroupPaymentNote";
import { useOutsideDismiss } from "../hooks/useDismiss";
import { markGroupRead, memberName } from "../lib/groups";
import type { ChatMessage } from "../lib/types";
import { useSettings } from "../contexts/SettingsContext";
import { GroupAvatar } from "../components/GroupAvatar";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { navOnly } from "../lib/navigation";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;

function toChatMessage(message: StoredMessage, group: GroupView): ChatMessage {
  const member = message.member ? group.members.find(m => m.key === message.member) : undefined;
  return { id: message.id, text: message.text, sender: message.sender, timestamp: message.timestamp, paymentId: message.paymentId,
    nick: message.sender === "peer" && message.member ? (member ? memberName(member) : `Member ${message.member.slice(0, 8)}`) : undefined };
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
  return message.text;
}

/** A join through a link, step by step: what the joiner's app knows so far, never more. In a community any member's app answers. */
const joinSteps = (community: boolean): { stage: GroupJoinStage; label: string }[] => [
  { stage: "knocked", label: community ? "Knock left for the group" : "Knock left for the admin's app" },
  { stage: "answered", label: community ? "A member's app answered" : "The admin's app answered" },
  { stage: "admitted", label: "Let in: getting the group's keys" },
];
/** How long after joining a group with nobody reached yet says it is still connecting (later, they are simply away). */
const JUST_JOINED_MS = 5 * 60_000;
const JOIN_ORDER: GroupJoinStage[] = ["knocking", "knocked", "answered", "admitted"];

function joiningText(stage: GroupJoinStage, name: string, community: boolean): { title: string; body: string } {
  const who = community ? "A member's app" : "The admin's app";
  if (stage === "admitted") return { title: `Joining ${name || "the group"}…`, body: `${who} answered: getting the group's keys. You are in in a moment.` };
  if (stage === "answered") return { title: "Waiting to be let in", body: `${who} saw you knock and is connecting to you. You are in in a moment.` };
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
  const state = useSyncExternalStore(subscribe, snapshot);
  const group = state?.groups.find(g => g.id === groupId);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [showMembers, setShowMembers] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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
  // Members learn my name on the edges, as a contact does on a chat: the engine must know it here too.
  const engineNick = state?.settings.nick;
  useEffect(() => {
    const nick = settings.defaultNickname;
    if (engineNick !== undefined && engineNick !== nick) void engine.call("updateSettings", { settings: { nick } }).catch(() => {});
  }, [settings.defaultNickname, engineNick]);
  const bottomRef = useRef<HTMLDivElement>(null);
  useOutsideDismiss(menuRef, menuOpen, () => setMenuOpen(false));

  useEffect(() => {
    if (!groupId) return;
    setMessages(engine.messages.get(`group:${groupId}`) ?? []);
    void engine.call("groupMessages", { groupId }).then(setMessages).catch(() => {});
    return engine.onMessages((linkId, list) => { if (linkId === `group:${groupId}`) setMessages(list); });
  }, [groupId]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => { if (group) markGroupRead(group.id, Math.max(group.lastMessageAt, Date.now())); }, [group?.id, group?.lastMessageAt, group]);

  const send = useCallback(async (text: string): Promise<string | null> => {
    try { return (await engine.call("sendGroupMessage", { groupId, text })).error; }
    catch (e) { return e instanceof Error ? e.message : "Could not send"; }
  }, [groupId]);

  if (!state) return null;
  if (!group) return <div className="flex flex-1 items-center justify-center text-sm text-text-muted">This group is gone from this device.</div>;

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
    // The link may be off: sharing it turns it on.
    if (!group.entryLink) { try { await engine.call("enableGroupLink", { groupId }); } catch (e) { setError(e instanceof Error ? e.message : "Could not turn the link on"); return; } }
    setSharing("share");
  };
  const act = async (action: () => Promise<unknown>) => {
    setMenuOpen(false); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "That did not work"); }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-chat-bg" data-testid="group-chat" data-status={group.status ?? "invitation"}>
      <div className="h-14 header-safe flex items-center justify-between px-4 max-md:pl-1 max-md:pr-1 bg-panel-header border-b border-border shrink-0">
        <div className="flex items-center gap-3 max-md:gap-1.5 min-w-0">
          <button onClick={nav.up} className="md:hidden w-11 h-11 flex items-center justify-center text-text-secondary rounded-full active:bg-surface-hover cursor-pointer shrink-0" title="Back" data-testid="chat-back">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 19l-7-7 7-7" /></svg>
          </button>
          <button onClick={() => setShowMembers(true)} className="relative rounded-full shrink-0" title="Members" aria-label="Members">
            <GroupAvatar picture={group.picture} size={40} glyph={20} testId="group-avatar" className="bg-accent/15" />
          </button>
          <div className="min-w-0">
            <p className="text-[15px] m-0 leading-tight truncate text-text-primary" data-testid="group-name">{group.name || "A group"}</p>
            <button onClick={() => setShowMembers(true)} data-testid="group-members" className="text-xs text-text-muted/80 truncate hover:text-accent cursor-pointer max-w-[60vw]">{subtitle}</button>
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
            <button onClick={() => setMenuOpen(!menuOpen)} className="p-2 max-md:p-2.5 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer" title="Options" data-testid="group-options">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" /></svg>
            </button>
            {menuOpen && <div data-testid="group-options-menu" className="absolute right-0 top-full mt-1 bg-surface-alt border border-border rounded-lg shadow-lg py-1 min-w-[180px] z-50 animate-fade-in">
              <button onClick={() => { setShowMembers(true); setMenuOpen(false); }} className="w-full px-3 py-2 max-md:min-h-11 text-left text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary">Members…</button>
              {group.isAdmin && <button data-testid="group-rotate" onClick={() => void act(() => engine.call("rotateGroup", { groupId }))} className="w-full px-3 py-2 max-md:min-h-11 text-left text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary">Rotate keys</button>}
              <div className="border-t border-border my-1" />
              {group.status === "active" && <button data-testid="group-leave" onClick={() => { setMenuOpen(false); setConfirmLeave(true); }} className="w-full px-3 py-2 max-md:min-h-11 text-left text-sm text-danger hover:bg-surface-hover">Leave group</button>}
              <button data-testid="group-forget" onClick={() => { setMenuOpen(false); setConfirmForget(true); }} className="w-full px-3 py-2 max-md:min-h-11 text-left text-sm text-danger hover:bg-surface-hover">Delete from this device</button>
            </div>}
          </div>
        </div>
      </div>

      {connecting && !error && <div role="status" data-testid="group-connecting" className="px-4 py-2 text-xs bg-surface-alt text-text-secondary border-b border-border">
        You are in. Connecting to the members: messages go out as soon as one of them is reached.
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
                <span aria-hidden="true" className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${done ? "bg-accent text-white" : current ? "border border-accent" : "border border-border"}`}>{done ? "✓" : ""}</span>
                {step.label}
              </li>;
            })}
          </ol>
          <button onClick={() => { void engine.call("forgetGroup", { groupId }).catch(() => {}); nav.home(); }} data-testid="group-joining-cancel"
            className="mt-4 rounded px-2 py-1 text-xs text-text-muted hover:bg-danger/10 hover:text-danger">Cancel joining</button>
        </div>
      </div> : <div className="flex-1 overflow-y-auto chat-wallpaper">
        <div className="max-w-3xl mx-auto py-3">
          {messages.map(m => m.event
            ? <div key={m.id} data-testid="group-event" className="flex justify-center mb-3.5 px-6"><span className="rounded-lg bg-surface-alt/90 px-3 py-1.5 text-center text-[11px] text-text-muted">{eventText(m, group)}</span></div>
            // A note about a payment this device is part of is shown under its own bubble instead.
            : m.groupPay ? (ownNotes.has(m.groupPay.id) ? null : <GroupPaymentNote key={m.id} note={m.groupPay} group={group} />)
            : m.paymentId ? <div key={m.id} data-testid="group-payment">
              <MessageBubble message={toChatMessage(m, group)} peerAck={Number.MAX_SAFE_INTEGER} peerPubKey={peerOf(m.paymentId)} />
              {/* Said once, under the request (or the payment) itself: not again under a payment that answers it. */}
              {noteIdOf(state, m.paymentId) === m.paymentId && notes.get(m.paymentId) && <GroupPaymentCaption note={notes.get(m.paymentId)!} group={group} />}
            </div>
            : <MessageBubble key={m.id} message={toChatMessage(m, group)} peerAck={Number.MAX_SAFE_INTEGER} />)}
          <div ref={bottomRef} />
        </div>
      </div>}

      {!joiningByLink && <MessageInput draftId={`group:${groupId}`} key={groupId} onSend={send} disabled={!group.canSend} maxLength={16_384}
        fileUnavailable="Files are not part of groups yet"
        paymentsUnavailable={others.length === 0 ? "Nobody else is in the group yet" : undefined}
        paymentComposer={close => <GroupPaymentComposer group={group} onClose={close} />} />}

      {showMembers && <GroupMembersDialog group={group} onClose={() => setShowMembers(false)} />}
      {sharing && group.entryLink && <GroupShareDialog group={group} created={sharing === "created"} onClose={() => setSharing("")} />}
      {confirmLeave && <LeaveGroupDialog group={group} onClose={() => setConfirmLeave(false)}
        onConfirm={async () => { await engine.call("leaveGroup", { groupId }); setConfirmLeave(false); nav.home(); }} />}
      {confirmForget && <DeleteChatDialog name={group.name} onClose={() => setConfirmForget(false)}
        onConfirm={() => { setConfirmForget(false); void engine.call("forgetGroup", { groupId }).catch(() => {}); nav.home(); }} />}
    </div>
  );
}
