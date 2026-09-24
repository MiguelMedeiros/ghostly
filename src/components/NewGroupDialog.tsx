import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { COMMUNITY_LIMITS } from "@ghostly/core";
import { useBackdropDismiss } from "../hooks/useDismiss";
import { engine } from "@ghostly/browser/platform/engine";

type Kind = "community" | "mesh";
const KINDS: { kind: Kind; title: string; body: string }[] = [
  { kind: "community", title: "Community", body: `A link anyone can open, even while you are away: any member lets people in. Up to ${COMMUNITY_LIMITS.members} members.` },
  { kind: "mesh", title: "Private", body: "Up to eight people, from your contacts or your link, which works while your app is open. Everyone connects to everyone." },
];

/** Names a new group and says which kind. It opens on its link, the way people come in. */
export function NewGroupDialog({ onClose, onCreated }: { onClose(): void; onCreated(groupId: string): void }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("community");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const backdrop = useBackdropDismiss(onClose);
  useEffect(() => {
    const element = dialog.current!; element.showModal(); input.current?.focus();
    return () => element.close();
  }, []);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const { groupId } = await engine.call("createGroup", { name: name.trim(), profile: kind });
      // The link is what a group is for: it is on from the start, and the group opens on it.
      await engine.call("enableGroupLink", { groupId }).catch(() => {});
      onCreated(groupId);
    }
    catch (e) { setError(e instanceof Error ? e.message : "Could not create the group"); setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} {...backdrop} onCancel={e => { e.preventDefault(); onClose(); }} aria-labelledby={`${id}-title`} data-testid="new-group-dialog"
    className="m-auto w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <h2 id={`${id}-title`} className="text-base font-semibold">New group</h2>
    <p className="mt-1 text-sm text-text-muted">You get a link to share: whoever opens it joins. Everyone in the group reads everything sent while they are in it.</p>
    <form className="mt-4" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <input ref={input} value={name} onChange={e => setName(e.target.value)} maxLength={48} placeholder="Group name" aria-label="Group name" data-testid="new-group-name"
        className="w-full rounded-lg bg-input-bg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent" />
      <div role="radiogroup" aria-label="Kind of group" className="mt-3 grid gap-2">
        {KINDS.map(k => <label key={k.kind} data-testid={`new-group-kind-${k.kind}`}
          className={`flex cursor-pointer gap-3 rounded-lg border px-3 py-2.5 transition-colors ${kind === k.kind ? "border-accent bg-accent/10" : "border-border hover:bg-surface-hover"}`}>
          <input type="radio" name={`${id}-kind`} value={k.kind} checked={kind === k.kind} onChange={() => setKind(k.kind)} className="mt-1 accent-accent" />
          <span><span className="block text-sm font-semibold">{k.title}</span><span className="block text-xs text-text-muted">{k.body}</span></span>
        </label>)}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">Cancel</button>
        <button type="submit" disabled={!name.trim() || busy} data-testid="new-group-create"
          className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-panel-header hover:bg-accent-hover disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent">Create</button>
      </div>
    </form>
  </dialog>, document.body);
}
