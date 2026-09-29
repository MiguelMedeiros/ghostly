import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GroupView } from "@ghostly/browser/shared/types";
import { useBackdropDismiss } from "../hooks/useDismiss";
import { memberName } from "../lib/groups";

/**
 * Leaving a group, said before it happens: it goes from this device with its history, and an admin
 * hands the role to a member who is online (the engine picks the first reachable one, as here).
 */
export function LeaveGroupDialog({ group, onClose, onConfirm }: { group: GroupView; onClose(): void; onConfirm(): Promise<void> }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const backdrop = useBackdropDismiss(onClose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current!; element.showModal(); cancel.current?.focus();
    return () => element.close();
  }, []);
  const others = group.members.filter(m => !m.me);
  // A community hands the role to a member it is connected to, or to anyone: the commit travels through the hubs.
  const community = group.profile === "community";
  const successor = group.isAdmin ? others.find(m => m.online) ?? (community ? others[0] : undefined) : undefined;
  const blocked = others.length > 0 && (community ? !group.community?.connected : group.isAdmin && !successor);
  const leave = async () => {
    setBusy(true); setError("");
    try { await onConfirm(); } catch (e) { setError(e instanceof Error ? e.message : "That did not work"); setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} {...backdrop} onCancel={e => { e.preventDefault(); onClose(); }} aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`}
    data-testid="group-leave-dialog" className="m-auto w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <h2 id={`${id}-title`} className="text-base font-semibold">Leave {group.name || "this group"}?</h2>
    <div id={`${id}-body`} className="mt-2 space-y-2 text-sm text-text-muted">
      <p>The group and its history go from this device. You will not read what is said after, and to come back someone has to let you in again.</p>
      {successor && others.length > 0 && <p data-testid="group-leave-successor">You are the admin: <span className="font-medium text-text-primary">{memberName(successor)}</span> becomes the admin when you leave.</p>}
      {blocked && <p className="text-danger">{community ? "Nobody in the group is connected right now to take your leave. Try again in a moment."
        : "You are the admin and nobody else in the group is online to take over. Try again when a member is, or make someone the admin first."}</p>}
    </div>
    {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    <div className="mt-5 flex justify-end gap-2">
      <button ref={cancel} onClick={onClose} className="min-h-11 rounded-lg px-4 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">Cancel</button>
      <button disabled={busy || blocked} onClick={() => void leave()} data-testid="group-leave-confirm"
        className="min-h-11 rounded-lg bg-danger/15 px-4 text-sm text-danger hover:bg-danger/25 focus-visible:ring-2 focus-visible:ring-danger disabled:opacity-40">Leave group</button>
    </div>
  </dialog>, document.body);
}
