import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "../hooks/useDismiss";
import { useI18n } from "../contexts/I18nContext";

/**
 * Handing the admin role over, asked before it happens: a group has one admin, so I stop being it, and only the member
 * who gets it can give it back. The button sits in a list, beside Remove, one tap from the next row's.
 * It opens over the members list, inside it in React's tree: its Escape stops here and leaves the list open.
 */
export function MakeAdminDialog({ name, onClose, onConfirm }: { name: string; onClose(): void; onConfirm(): void }) {
  const { t } = useI18n();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const backdrop = useBackdropDismiss(onClose);
  useEffect(() => {
    const element = dialog.current!; element.showModal(); cancel.current?.focus();
    return () => element.close();
  }, []);
  return createPortal(<dialog ref={dialog} {...backdrop} onCancel={e => { e.preventDefault(); e.stopPropagation(); onClose(); }} aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`}
    data-testid="group-make-admin-dialog" className="m-auto w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <h2 id={`${id}-title`} className="break-words text-base font-semibold">{t("group.makeAdmin.title", { name })}</h2>
    <p id={`${id}-body`} className="mt-2 text-sm text-text-muted">{t("group.makeAdmin.body", { name })}</p>
    <div className="mt-5 flex justify-end gap-2">
      <button ref={cancel} onClick={onClose} className="min-h-11 rounded-lg px-4 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">{t("common.cancel")}</button>
      <button onClick={onConfirm} data-testid="group-make-admin-confirm"
        className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-panel-header hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent">{t("group.members.makeAdmin")}</button>
    </div>
  </dialog>, document.body);
}
