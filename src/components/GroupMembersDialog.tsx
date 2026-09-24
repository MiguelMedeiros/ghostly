import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { GROUP_READ_NOTE, GROUP_READ_NOTE_COMMUNITY, MAX_GROUP_PICTURE_LENGTH } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import type { GroupView, LinkView } from "@ghostly/browser/shared/types";
import { useBackdropDismiss } from "../hooks/useDismiss";
import { contactTag, publicKeyLabel } from "../lib/publicKeyLabel";
import { edgeDot, edgeLabel, memberName } from "../lib/groups";
import { GroupLinkPanel } from "./GroupLinkPanel";
import { GroupAvatar } from "./GroupAvatar";
import { avatarFromFile } from "../lib/avatarImage";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;

const contactName = (link: LinkView) => link.label || link.peerNick || `Contact · ${contactTag(link.peerPubKeyZ32)}`;

/** Who is in a group, with what role; what the admin can do about it; whom to invite; and who can read what. */
export function GroupMembersDialog({ group, onClose }: { group: GroupView; onClose(): void }) {
  const id = useId();
  const state = useSyncExternalStore(subscribe, snapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const backdrop = useBackdropDismiss(onClose);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  const live = state?.groups.find(g => g.id === group.id) ?? group;
  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "That did not work"); } finally { setBusy(null); }
  };
  // Contacts: paired chats, minus members and pending invitations. Those without groups are shown, and say why.
  const contacts = (state?.links ?? []).filter(l => l.profile && !live.memberLinks[l.id]);
  const invited = new Set(live.invited);
  return createPortal(<dialog ref={dialog} {...backdrop} onCancel={e => { e.preventDefault(); onClose(); }} aria-labelledby={`${id}-title`} data-testid="group-members-dialog"
    className="m-auto w-[calc(100%_-_2rem)] max-w-md max-h-[90dvh] overflow-y-auto rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <GroupAvatar picture={live.picture} size={56} testId="group-members-avatar" className="bg-accent/15" />
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="truncate text-base font-semibold">{live.name}</h2>
          <p className="text-xs text-text-muted">{live.members.length} member{live.members.length === 1 ? "" : "s"}{live.epoch !== undefined && <> · epoch {live.epoch}</>}{live.status && live.status !== "active" && <> · {live.status}</>}</p>
          {/* Only the admin changes the picture: cropped square and redrawn small here, before anything leaves the app. */}
          {live.isAdmin && live.status === "active" && <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            <label className={`cursor-pointer text-xs font-medium text-accent hover:underline ${busy !== null ? "pointer-events-none opacity-40" : ""}`}>
              {live.picture ? "Change picture" : "Add a picture"}
              <input data-testid="group-picture-input" type="file" accept="image/*" className="sr-only" disabled={busy !== null}
                onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void run("picture", async () => engine.call("setGroupPicture", { groupId: live.id, picture: await avatarFromFile(file, MAX_GROUP_PICTURE_LENGTH) })); }} />
            </label>
            {live.picture && <button type="button" data-testid="group-picture-remove" disabled={busy !== null} onClick={() => void run("picture", () => engine.call("setGroupPicture", { groupId: live.id, picture: null }))}
              className="text-xs text-text-muted hover:text-danger disabled:opacity-40">Remove picture</button>}
          </div>}
        </div>
      </div>
      <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-text-muted hover:bg-surface-hover hover:text-text-primary">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>
    {live.status === "active" && (live.isAdmin || (live.profile === "community" && live.entryLink)) && <GroupLinkPanel group={live} />}
    <ul className="mt-3 max-h-56 space-y-1 overflow-y-auto" data-testid="group-member-list">
      {live.members.map(m => <li key={m.key} data-testid="group-member" data-key={m.key} data-role={m.role} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-hover">
        <span role="img" aria-label={m.online ? "reachable" : "not reachable"} className={`h-2 w-2 shrink-0 rounded-full ${m.edge || m.me ? edgeDot(m) : m.online ? "bg-accent" : "bg-text-muted"}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{memberName(m)}<span className="ml-1.5 font-mono text-[10px] text-text-muted/60">{publicKeyLabel(m.key)}</span></span>
          {!m.me && <span className="block truncate text-[11px] text-text-muted" data-testid="group-member-status">{edgeLabel(m)}</span>}
        </span>
        {m.role === "admin" && <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent">admin</span>}
        {m.missing > 0 && <span title="Messages of this epoch that nobody could recover" className="text-[10px] text-amber-500">{m.missing} missing</span>}
        {live.isAdmin && !m.me && <>
          <button disabled={busy !== null} onClick={() => void run(m.key, () => engine.call("makeGroupAdmin", { groupId: live.id, key: m.key }))} data-testid="group-make-admin"
            className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-surface-alt hover:text-text-primary disabled:opacity-40">Make admin</button>
          <button disabled={busy !== null} onClick={() => void run(m.key, () => engine.call("removeGroupMember", { groupId: live.id, key: m.key }))} data-testid="group-remove-member"
            className="rounded px-2 py-1 text-xs text-danger hover:bg-danger/10 disabled:opacity-40">Remove</button>
        </>}
      </li>)}
    </ul>
    {live.isAdmin && live.status === "active" && live.profile !== "community" && <div className="mt-4">
      <h3 className="text-xs font-bold uppercase tracking-wider text-accent">Invite a contact</h3>
      {contacts.length === 0 && <p className="mt-1 text-sm text-text-muted">Every paired contact is already in, or you have none yet.</p>}
      <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto" data-testid="group-invite-list">
        {contacts.map(link => {
          const pending = invited.has(link.id), can = !!link.groups && !pending && live.members.length + live.invited.length < 8;
          return <li key={link.id} data-testid="group-invite-contact" data-link={link.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate text-sm">{contactName(link)}</span>
            {pending ? <span className="text-xs text-text-muted">Invited…</span>
              : !link.groups ? <span className="text-xs text-text-muted" title="Groups need both apps connected and updated">{link.dataLink === "open" ? "Needs an updated Ghostly" : "Not connected"}</span>
              : <button disabled={!can || busy !== null} onClick={() => void run(link.id, () => engine.call("inviteToGroup", { groupId: live.id, linkId: link.id }))} data-testid="group-invite"
                className="rounded bg-accent px-2.5 py-1 text-xs font-semibold text-panel-header hover:bg-accent-hover disabled:opacity-40">Invite</button>}
          </li>;
        })}
      </ul>
    </div>}
    {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    <p data-testid="group-read-note" className="mt-4 rounded-lg bg-surface-alt/80 p-3 text-xs leading-relaxed text-text-secondary">{live.profile === "community" ? GROUP_READ_NOTE_COMMUNITY : GROUP_READ_NOTE}</p>
  </dialog>, document.body);
}
