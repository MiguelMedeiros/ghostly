import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "../hooks/useDismiss";
import { engine } from "@ghostly/browser/platform/engine";

/** Names a new private group. Members come afterwards, from the contacts list. */
export function NewGroupDialog({ onClose, onCreated }: { onClose(): void; onCreated(groupId: string): void }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
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
    try { onCreated((await engine.call("createGroup", { name: name.trim() })).groupId); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not create the group"); setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} {...backdrop} onCancel={e => { e.preventDefault(); onClose(); }} aria-labelledby={`${id}-title`} data-testid="new-group-dialog"
    className="m-auto w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <h2 id={`${id}-title`} className="text-base font-semibold">New group</h2>
    <p className="mt-1 text-sm text-text-muted">Up to eight people. You invite them from your contacts; everyone in the group can read everything sent while they are in it.</p>
    <form className="mt-4" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <input ref={input} value={name} onChange={e => setName(e.target.value)} maxLength={48} placeholder="Group name" aria-label="Group name" data-testid="new-group-name"
        className="w-full rounded-lg bg-input-bg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent" />
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">Cancel</button>
        <button type="submit" disabled={!name.trim() || busy} data-testid="new-group-create"
          className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-panel-header hover:bg-accent-hover disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent">Create</button>
      </div>
    </form>
  </dialog>, document.body);
}
