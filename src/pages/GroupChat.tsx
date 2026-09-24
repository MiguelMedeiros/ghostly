import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { engine } from "@ghostly/browser/platform/engine";
import type { GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../components/MessageBubble";
import { MessageInput } from "../components/MessageInput";
import { GroupMembersDialog } from "../components/GroupMembersDialog";
import { DeleteChatDialog } from "../components/DeleteChatDialog";
import { LeaveGroupDialog } from "../components/LeaveGroupDialog";
import { GroupShareDialog } from "../components/GroupLinkPanel";
import { useOutsideDismiss } from "../hooks/useDismiss";
import { markGroupRead, memberName } from "../lib/groups";
import type { ChatMessage } from "../lib/types";
import { useSettings } from "../contexts/SettingsContext";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;

function toChatMessage(message: StoredMessage, group: GroupView): ChatMessage {
  const member = message.member ? group.members.find(m => m.key === message.member) : undefined;
  return { id: message.id, text: message.text, sender: message.sender, timestamp: message.timestamp,
    nick: message.sender === "peer" && message.member ? (member ? memberName(member) : `Member ${message.member.slice(0, 8)}`) : undefined };
}

/** A membership line, naming its member as the roster knows them now; what was stored, when they are gone. */
function eventText(message: StoredMessage, group: GroupView): string {
  const member = message.member ? group.members.find(m => m.key === message.member) : undefined;
  if (!member) return message.text;
  if (message.event === "joined") return `${memberName(member)} joined`;
  if (message.event === "admin") return `${memberName(member)} ${member.me ? "are" : "is"} now the admin`;
  return message.text;
}

/** One private group: its members and roles behind the header, its history, and the composer. */
export function GroupChat() {
  const { groupId = "" } = useParams();
  const navigate = useNavigate();
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
    navigate(location.pathname, { replace: true, state: null });
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
  const joiningByLink = group.invitation?.viaLink;
  const subtitle = joiningByLink ? (group.invitation!.admin ? "Joining…" : "Joining through a link")
    : group.invitation ? `Invitation from ${group.invitation.contact || "a contact"}`
    : group.status === "active" ? `${group.members.length} member${group.members.length === 1 ? "" : "s"} · ${reachable} of ${others.length} reachable`
    : group.statusReason ?? group.status;
  const canShare = group.isAdmin && group.status === "active";
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
          <button onClick={() => navigate("/")} className="md:hidden w-11 h-11 flex items-center justify-center text-text-secondary rounded-full active:bg-surface-hover cursor-pointer shrink-0" title="Back" data-testid="chat-back">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 19l-7-7 7-7" /></svg>
          </button>
          <button onClick={() => setShowMembers(true)} className="relative w-10 h-10 rounded-full bg-accent/15 text-accent flex items-center justify-center shrink-0" title="Members" aria-label="Members">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
          </button>
          <div className="min-w-0">
            <p className="text-[15px] m-0 leading-tight truncate text-text-primary" data-testid="group-name">{group.name || "A group"}</p>
            <button onClick={() => setShowMembers(true)} data-testid="group-members" className="text-xs text-text-muted/80 truncate hover:text-accent cursor-pointer max-w-[60vw]">{subtitle}</button>
          </div>
        </div>
        <div className="flex items-center gap-1">
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

      {(error || (group.status && group.status !== "active")) && <div role="status" data-testid="group-notice" className="px-4 py-2 text-xs bg-surface-alt text-text-secondary border-b border-border">
        {error || group.statusReason}
      </div>}


      {joiningByLink ? <div className="flex flex-1 items-center justify-center overflow-y-auto chat-wallpaper px-4">
        <div role="status" data-testid="group-joining" className="w-full max-w-sm rounded-2xl border border-border bg-sidebar-bg/95 p-6 text-center shadow-xl">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-accent/15 text-accent">
            <svg className="animate-spin" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.22-8.56" /></svg>
          </div>
          <h2 className="mt-4 text-base font-semibold text-text-primary">{group.invitation!.admin ? `Joining ${group.name || "the group"}…` : "Waiting to be let in"}</h2>
          <p className="mt-2 text-sm leading-relaxed text-text-muted">{group.invitation!.admin
            ? "The admin's app answered: getting the group's keys. You are in in a moment."
            : "Waiting for the admin's app to let you in. It happens on its own as soon as their app is open: you can leave this page and come back."}</p>
          <button onClick={() => { void engine.call("forgetGroup", { groupId }).catch(() => {}); navigate("/"); }} data-testid="group-joining-cancel"
            className="mt-4 rounded px-2 py-1 text-xs text-text-muted hover:bg-danger/10 hover:text-danger">Cancel joining</button>
        </div>
      </div> : <div className="flex-1 overflow-y-auto chat-wallpaper">
        <div className="max-w-3xl mx-auto py-3">
          {messages.map(m => m.event
            ? <div key={m.id} data-testid="group-event" className="flex justify-center mb-3.5 px-6"><span className="rounded-lg bg-surface-alt/90 px-3 py-1.5 text-center text-[11px] text-text-muted">{eventText(m, group)}</span></div>
            : <MessageBubble key={m.id} message={toChatMessage(m, group)} peerAck={Number.MAX_SAFE_INTEGER} />)}
          <div ref={bottomRef} />
        </div>
      </div>}

      {!joiningByLink && <MessageInput draftId={`group:${groupId}`} key={groupId} onSend={send} disabled={!group.canSend} maxLength={16_384}
        fileUnavailable="Files are not part of groups yet" paymentsUnavailable="Payments are not part of groups yet" />}

      {showMembers && <GroupMembersDialog group={group} onClose={() => setShowMembers(false)} />}
      {sharing && group.entryLink && <GroupShareDialog group={group} created={sharing === "created"} onClose={() => setSharing("")} />}
      {confirmLeave && <LeaveGroupDialog group={group} onClose={() => setConfirmLeave(false)}
        onConfirm={async () => { await engine.call("leaveGroup", { groupId }); setConfirmLeave(false); navigate("/"); }} />}
      {confirmForget && <DeleteChatDialog name={group.name} onClose={() => setConfirmForget(false)}
        onConfirm={() => { setConfirmForget(false); void engine.call("forgetGroup", { groupId }).catch(() => {}); navigate("/"); }} />}
    </div>
  );
}
