import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "../hooks/useDismiss";
import { useI18n } from "../contexts/I18nContext";

/**
 * Removing a member, asked before it happens: Remove sits in a list, beside Make admin, one tap from the next row's.
 * It opens over the members list, inside it in React's tree: its Escape stops here and leaves the list open.
 * `linkOn`: the group's link works, and whoever is removed still has it: they can join again until it is replaced.
 */
export function RemoveMemberDialog({ name, linkOn = false, onClose, onConfirm }: { name: string; linkOn?: boolean; onClose(): void; onConfirm(): void }) {
  const { t } = useI18n();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const backdrop = useBackdropDismiss(onClose);
  useEffect(() => {
    const element = dialog.current!; element.showModal(); cancel.current?.focus();
    return () => element.close();
  }, []);
  return createPortal(<dialog ref={dialog} {...backdrop} onCancel={e => { e.preventDefault(); e.stopPropagation(); onClose(); }} aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`}
    data-testid="group-remove-dialog" className="m-auto w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <h2 id={`${id}-title`} className="break-words text-base font-semibold">{t("group.remove.title", { name })}</h2>
    <p id={`${id}-body`} className="mt-2 text-sm text-text-muted">{t("group.remove.body")}{linkOn && <> {t("group.remove.linkHint")}</>}</p>
    <div className="mt-5 flex justify-end gap-2">
      <button ref={cancel} onClick={onClose} className="min-h-11 rounded-lg px-4 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">{t("common.cancel")}</button>
      <button onClick={onConfirm} data-testid="group-remove-confirm"
        className="min-h-11 rounded-lg bg-danger/15 px-4 text-sm text-danger hover:bg-danger/25 focus-visible:ring-2 focus-visible:ring-danger">{t("group.members.remove")}</button>
    </div>
  </dialog>, document.body);
}
