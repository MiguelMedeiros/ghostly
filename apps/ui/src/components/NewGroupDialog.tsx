import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { COMMUNITY_LIMITS } from "@ghostly/core";
import { useBackdropDismiss } from "../hooks/useDismiss";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n, type Translate } from "../contexts/I18nContext";
import { errorText } from "../lib/errorText";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;

type Kind = "community" | "mesh";
const kinds = (t: Translate): { kind: Kind; title: string; body: string }[] => [
  { kind: "community", title: t("group.create.community"), body: t("group.create.communityHint", { count: COMMUNITY_LIMITS.members }) },
  { kind: "mesh", title: t("group.create.private"), body: t("group.create.privateHint") },
];

/** Names a new group and says which kind. It opens on its link, the way people come in. */
export function NewGroupDialog({ onClose, onCreated }: { onClose(): void; onCreated(groupId: string): void }) {
  const { t } = useI18n();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("community");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const backdrop = useBackdropDismiss(onClose);
  // An app with no transport for a group's links (no WebRTC, no native transport) could make the group and show its
  // link, but never let anyone in, nor reach a member (GroupConnection says the same once in). It says so here instead.
  const noLinks = useSyncExternalStore(subscribe, snapshot)?.transport.groupLinks === false;
  useEffect(() => {
    const element = dialog.current!; element.showModal(); input.current?.focus();
    return () => element.close();
  }, []);
  const submit = async () => {
    if (!name.trim() || busy || noLinks) return;
    setBusy(true); setError("");
    try {
      const { groupId } = await engine.call("createGroup", { name: name.trim(), profile: kind });
      // The link is what a group is for: it is on from the start, and the group opens on it.
      await engine.call("enableGroupLink", { groupId }).catch(() => {});
      onCreated(groupId);
    }
    catch (e) { setError(e instanceof Error ? errorText(e, t) : t("group.create.failed")); setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} {...backdrop} onCancel={e => { e.preventDefault(); onClose(); }} aria-labelledby={`${id}-title`} data-testid="new-group-dialog"
    className="m-auto w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <h2 id={`${id}-title`} className="text-base font-semibold">{t("group.create.title")}</h2>
    <p className="mt-1 text-sm text-text-muted">{t("group.create.hint")}</p>
    <form className="mt-4" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <input ref={input} value={name} onChange={e => setName(e.target.value)} maxLength={48} placeholder={t("group.rename.label")} aria-label={t("group.rename.label")} data-testid="new-group-name"
        className="w-full rounded-lg bg-input-bg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent" />
      <div role="radiogroup" aria-label={t("group.create.kind")} className="mt-3 grid gap-2">
        {kinds(t).map(k => <label key={k.kind} data-testid={`new-group-kind-${k.kind}`}
          className={`flex cursor-pointer gap-3 rounded-lg border px-3 py-2.5 transition-colors ${kind === k.kind ? "border-accent bg-accent/10" : "border-border hover:bg-surface-hover"}`}>
          <input type="radio" name={`${id}-kind`} value={k.kind} checked={kind === k.kind} onChange={() => setKind(k.kind)} className="mt-1 accent-accent" />
          <span><span className="block text-sm font-semibold">{k.title}</span><span className="block text-xs text-text-muted">{k.body}</span></span>
        </label>)}
      </div>
      {noLinks && <p className="mt-3 rounded-lg border border-border px-3 py-2 text-xs text-text-muted" data-testid="new-group-no-webrtc">
        <span className="block text-sm font-semibold text-text-primary">{t("group.connection.noWebrtc")}</span>{t("group.connection.noWebrtcHint")}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">{t("common.cancel")}</button>
        <button type="submit" disabled={!name.trim() || busy || noLinks} data-testid="new-group-create"
          className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-panel-header hover:bg-accent-hover disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent">{t("group.create.create")}</button>
      </div>
    </form>
  </dialog>, document.body);
}
