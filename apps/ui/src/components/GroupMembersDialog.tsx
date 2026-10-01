import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { COMMUNITY_LIMITS, GROUP_LIMITS, MAX_GROUP_MEMBERS, MAX_GROUP_NAME_LENGTH, MAX_GROUP_PICTURE_LENGTH, MESH_HUBS } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import type { GroupMemberView, GroupView, LinkView } from "@ghostly/browser/shared/types";
import { useBackdropDismiss } from "../hooks/useDismiss";
import { contactTag, publicKeyLabel } from "../lib/publicKeyLabel";
import { edgeDot, edgeLabel, groupStatusText, memberName, memberPhoto } from "../lib/groups";
import { agoIn } from "../lib/relativeTime";
import { GroupLinkPanel } from "./GroupLinkPanel";
import { RemoveMemberDialog } from "./RemoveMemberDialog";
import { GroupAvatar } from "./GroupAvatar";
import { AvatarOpener } from "./AvatarViewer";
import { useContactFaces } from "./identities/contactFace";
import { avatarFromFile } from "../lib/avatarImage";
import { ContactMarks } from "./identities/ContactMarks";
import { Select } from "./ui/Select";
import { useI18n } from "../contexts/I18nContext";
import { errorText } from "../lib/errorText";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;

/** What the admin says about a member as a hub (WISP 9xx · Group Mesh § Hubs): up to their app, always, or never. */
const HUB_ROLES = ["auto", "pin", "exclude"] as const;


/** Who is in a group, with what role; what the admin can do about it; whom to invite; and who can read what. */
/** `focusKey`: the member the chat opened this for (their name or picture above a message), shown and marked in the list. */
export function GroupMembersDialog({ group, onClose, focusKey }: { group: GroupView; onClose(): void; focusKey?: string }) {
  const id = useId();
  const { t, language } = useI18n();
  const contactName = (link: LinkView) => link.label || link.peerNick || t("common.unnamedContact", { key: contactTag(link.peerPubKeyZ32) });
  const hubLabels = { auto: t("group.hubs.auto"), pin: t("group.hubs.pin"), exclude: t("group.hubs.exclude") };
  const hubRoles = HUB_ROLES.map(value => ({ value, label: hubLabels[value] }));
  const state = useSyncExternalStore(subscribe, snapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const backdrop = useBackdropDismiss(onClose);
  const faces = useContactFaces();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  /** The member whose Remove was pressed, asked about before anything happens. */
  const [removing, setRemoving] = useState<GroupMemberView | null>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  const live = state?.groups.find(g => g.id === group.id) ?? group;
  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? errorText(e, t) : t("group.error.generic")); } finally { setBusy(null); }
  };
  // The name being typed, while the admin renames the group; null otherwise. The engine cleans it and says what it refuses.
  const [naming, setNaming] = useState<string | null>(null);
  const rename = async () => {
    const name = naming ?? "";
    if (name.trim() === live.name) { setNaming(null); return; }
    await run("rename", async () => { await engine.call("renameGroup", { groupId: live.id, name }); setNaming(null); });
  };
  // Contacts: paired chats, minus members and pending invitations. Those without groups are shown, and say why.
  const contacts = (state?.links ?? []).filter(l => l.profile && !live.memberLinks[l.id]);
  const invited = new Set(live.invited);
  // A member who is also a contact: the identities they shared in that chat. Community members are not contacts.
  const contactOf = (key: string) => {
    const linkId = Object.keys(live.memberLinks).find(id => live.memberLinks[id] === key);
    return linkId ? state?.links.find(l => l.id === linkId) : undefined;
  };
  const contactKey = (key: string) => contactOf(key)?.peerPubKeyZ32;
  const photoOf = (m: GroupMemberView) => memberPhoto(live, m, state?.links, faces, state?.settings.avatar);
  // The member whose name or picture was tapped in the chat: their row, in sight and marked.
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (focusKey) list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [focusKey]);
  return createPortal(<dialog ref={dialog} {...backdrop} onCancel={e => { e.preventDefault(); onClose(); }} aria-labelledby={`${id}-title`} data-testid="group-members-dialog"
    className="m-auto w-[calc(100%_-_2rem)] max-w-md max-h-[90dvh] overflow-y-auto rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <AvatarOpener src={live.picture} name={live.name} testId="group-members-avatar-open" className="shrink-0 rounded-full">
          <GroupAvatar picture={live.picture} size={56} testId="group-members-avatar" className="bg-accent/15" />
        </AvatarOpener>
        <div className="min-w-0">
          {naming === null ? <h2 id={`${id}-title`} data-testid="group-members-name" className="truncate text-base font-semibold">{live.name}</h2>
            : <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); void rename(); }}>
              <h2 id={`${id}-title`} className="sr-only">{live.name}</h2>
              <input autoFocus data-testid="group-rename-input" aria-label={t("group.rename.label")} value={naming} maxLength={MAX_GROUP_NAME_LENGTH} disabled={busy !== null}
                onChange={e => setNaming(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setNaming(null); } }}
                className="min-w-0 flex-1 rounded-md border border-border bg-surface-alt px-2 py-1 text-sm focus:border-accent focus:outline-none" />
              <button type="submit" data-testid="group-rename-save" disabled={busy !== null || !naming.trim()}
                className="rounded bg-accent px-2.5 py-1 text-xs font-semibold text-panel-header hover:bg-accent-hover disabled:opacity-40">{t("group.rename.save")}</button>
              <button type="button" data-testid="group-rename-cancel" onClick={() => setNaming(null)} className="text-xs text-text-muted hover:text-text-primary">{t("group.rename.cancel")}</button>
            </form>}
          <p className="text-xs text-text-muted">{live.members.length === 1 ? t("group.chat.memberOne") : t("group.chat.memberCount", { count: live.members.length })}{live.epoch !== undefined && <> · {t("group.members.epoch", { epoch: live.epoch })}</>}{live.status && live.status !== "active" && <> · {groupStatusText(live.status, t)}</>}</p>
          {/* Only the admin changes the name and the picture: cropped square and redrawn small here, before anything leaves the app. */}
          {live.isAdmin && live.status === "active" && <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {naming === null && <button type="button" data-testid="group-rename" disabled={busy !== null} title={t("group.rename.hint")} onClick={() => setNaming(live.name)}
              className="text-xs font-medium text-accent hover:underline disabled:opacity-40">{t("group.rename.action")}</button>}
            <label className={`cursor-pointer text-xs font-medium text-accent hover:underline ${busy !== null ? "pointer-events-none opacity-40" : ""}`}>
              {live.picture ? t("group.members.changePicture") : t("group.members.addPicture")}
              <input data-testid="group-picture-input" type="file" accept="image/*" className="sr-only" disabled={busy !== null}
                onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void run("picture", async () => engine.call("setGroupPicture", { groupId: live.id, picture: await avatarFromFile(file, MAX_GROUP_PICTURE_LENGTH) })); }} />
            </label>
            {live.picture && <button type="button" data-testid="group-picture-remove" disabled={busy !== null} onClick={() => void run("picture", () => engine.call("setGroupPicture", { groupId: live.id, picture: null }))}
              className="text-xs text-text-muted hover:text-danger disabled:opacity-40">{t("group.members.removePicture")}</button>}
          </div>}
        </div>
      </div>
      <button onClick={onClose} aria-label={t("common.close")} className="rounded-full p-1.5 text-text-muted hover:bg-surface-hover hover:text-text-primary">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>
    {live.status === "active" && (live.isAdmin || (live.profile === "community" && live.entryLink)) && <GroupLinkPanel group={live} />}
    <ul ref={list} className="mt-3 max-h-56 space-y-1 overflow-y-auto" data-testid="group-member-list">
      {live.members.map(m => <li key={m.key} data-testid="group-member" data-key={m.key} data-role={m.role} data-focused={m.key === focusKey || undefined}
        className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 py-1.5 hover:bg-surface-hover ${m.key === focusKey ? "bg-surface-hover ring-1 ring-accent/60" : ""}`}>
        <span role="img" aria-label={m.online ? t("group.members.reachable") : t("group.members.notReachable")} className={`h-2 w-2 shrink-0 rounded-full ${m.edge || m.me ? edgeDot(m) : m.online ? "bg-accent" : "bg-text-muted"}`} />
        <MemberAvatar src={photoOf(m)} name={m.me ? state?.settings.nick || memberName(m, t) : memberName(m, t)} />
        {/* The name keeps room for about 16 characters: the badges and an admin's buttons go under it when the row is narrower (a phone, a long word in another language). */}
        <span className="contact-row min-w-[8.5rem] flex-1">
          <span className="flex min-w-0 items-center gap-1.5 text-sm"><span className="min-w-0 truncate">{memberName(m, t)}</span>{!m.me && <ContactMarks peerKey={contactKey(m.key)} testId="group-member-marks" />}{/* An unnamed member's name is its key already ("Member 3r69cg...d51a"): the key again was cut to one character on a phone. */}
            {(m.me || m.nick) && <span data-testid="group-member-key" className="min-w-0 shrink-[100] truncate font-mono text-[10px] text-text-muted">{publicKeyLabel(m.key)}</span>}</span>
          {!m.me && <span className="block truncate text-[11px] text-text-muted" data-testid="group-member-status">{edgeLabel(m, Date.now(), t, agoIn(language))}</span>}
        </span>
        {m.role === "admin" && <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent">{t("group.members.admin")}</span>}
        {m.hub && <span data-testid="group-member-hub" title={t("group.hubs.badgeHint")} className="rounded-full bg-surface-alt px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-text-secondary">{t("group.hubs.badge")}</span>}
        {m.missing > 0 && <span title={t("group.members.missingHint")} className="text-[10px] text-amber-500">{t("group.members.missing", { count: m.missing })}</span>}
        {live.isAdmin && !m.me && <span data-testid="group-member-actions" className="ms-auto flex shrink-0 items-center gap-1">
          {live.profile === "mesh" && live.members.length > MESH_HUBS.threshold && <Select size="sm" fit aria-label={t("group.hubs.choice")} data-testid="group-member-hub-role" disabled={busy !== null}
            value={m.hubRole ?? "auto"} options={hubRoles}
            onChange={role => void run(m.key, () => engine.call("setGroupHub", { groupId: live.id, key: m.key, role: role === "auto" ? null : role }))} />}
          <button disabled={busy !== null} onClick={() => void run(m.key, () => engine.call("makeGroupAdmin", { groupId: live.id, key: m.key }))} data-testid="group-make-admin"
            className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-surface-alt hover:text-text-primary disabled:opacity-40">{t("group.members.makeAdmin")}</button>
          <button disabled={busy !== null} onClick={() => setRemoving(m)} data-testid="group-remove-member"
            className="rounded px-2 py-1 text-xs text-danger hover:bg-danger/10 disabled:opacity-40">{t("group.members.remove")}</button>
        </span>}
      </li>)}
    </ul>
    {live.isAdmin && live.status === "active" && live.profile !== "community" && <div className="mt-4">
      <h3 className="text-xs font-bold uppercase tracking-wider text-accent">{t("group.members.invite")}</h3>
      {contacts.length === 0 && <p className="mt-1 text-sm text-text-muted">{t("group.members.noContacts")}</p>}
      <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto" data-testid="group-invite-list">
        {contacts.map(link => {
          const pending = invited.has(link.id), can = !!link.groups && !pending && live.members.length + live.invited.length < MAX_GROUP_MEMBERS;
          return <li key={link.id} data-testid="group-invite-contact" data-link={link.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate text-sm">{contactName(link)}</span>
            {pending ? <span className="text-xs text-text-muted">{t("group.members.invited")}</span>
              : !link.groups ? <span className="text-xs text-text-muted" title={t("group.members.needsBothHint")}>{link.dataLink === "open" ? t("group.members.needsUpdate") : t("group.members.notConnected")}</span>
              : <button disabled={!can || busy !== null} onClick={() => void run(link.id, () => engine.call("inviteToGroup", { groupId: live.id, linkId: link.id }))} data-testid="group-invite"
                className="rounded bg-accent px-2.5 py-1 text-xs font-semibold text-panel-header hover:bg-accent-hover disabled:opacity-40">{t("group.members.inviteAction")}</button>}
          </li>;
        })}
      </ul>
    </div>}
    {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    {removing && <RemoveMemberDialog name={memberName(removing, t)} linkOn={!!live.entryLink} onClose={() => setRemoving(null)}
      onConfirm={() => { const key = removing.key; setRemoving(null); void run(key, () => engine.call("removeGroupMember", { groupId: live.id, key })); }} />}
    <p data-testid="group-read-note" className="mt-4 rounded-lg bg-surface-alt/80 p-3 text-xs leading-relaxed text-text-secondary">{live.profile === "community" ? t("group.readNoteCommunity", { count: COMMUNITY_LIMITS.store }) : t("group.readNote", { count: GROUP_LIMITS.relay })}</p>
  </dialog>, document.body);
}

/** A member's avatar in the list: their picture, which opens large, or their initial (drawn by CSS, so it is not read out). */
function MemberAvatar({ src, name }: { src?: string; name: string }) {
  return (
    <AvatarOpener src={src} name={name} testId="group-member-avatar"
      className="relative flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-hover text-xs">
      {src
        ? <img src={src} alt="" draggable={false} className="h-full w-full object-cover" />
        : <span aria-hidden="true" data-initial={name.charAt(0).toUpperCase()} className="text-text-muted before:content-[attr(data-initial)]" />}
    </AvatarOpener>
  );
}
