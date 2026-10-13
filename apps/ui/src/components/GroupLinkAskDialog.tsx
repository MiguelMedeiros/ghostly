import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss, useQuestionDialog } from "../hooks/useDismiss";
import { useI18n } from "../contexts/I18nContext";

/**
 * A new link (`reset`) or turning the link off (`disable`), asked before it happens: either ends the link shared so
 * far for good, wherever it was posted, and nothing brings it back. The two buttons sit beside Share, Copy and Show QR.
 * It opens over the members list or the share dialog, inside it in React's tree: its Escape stops here and leaves that open.
 * Closed, it gives the focus back to the button that opened it.
 */
export function GroupLinkAskDialog({ kind, onClose, onConfirm }: { kind: "reset" | "disable"; onClose(): void; onConfirm(): void }) {
  const { t } = useI18n();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const backdrop = useBackdropDismiss(onClose);
  useQuestionDialog(dialog, cancel);
  return createPortal(<dialog ref={dialog} {...backdrop} onCancel={e => { e.preventDefault(); e.stopPropagation(); onClose(); }} aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`}
    data-testid="group-link-ask-dialog" data-kind={kind} className="m-auto w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <h2 id={`${id}-title`} className="text-base font-semibold">{t(kind === "reset" ? "group.link.resetTitle" : "group.link.disableTitle")}</h2>
    <p id={`${id}-body`} className="mt-2 text-sm text-text-muted">{t(kind === "reset" ? "group.link.resetBody" : "group.link.disableBody")}</p>
    <div className="mt-5 flex justify-end gap-2">
      <button ref={cancel} onClick={onClose} className="min-h-11 rounded-lg px-4 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">{t("common.cancel")}</button>
      <button onClick={onConfirm} data-testid="group-link-ask-confirm"
        className={`min-h-11 rounded-lg px-4 text-sm focus-visible:ring-2 ${kind === "reset" ? "bg-accent font-semibold text-panel-header hover:bg-accent-hover focus-visible:ring-accent" : "bg-danger/15 text-danger hover:bg-danger/25 focus-visible:ring-danger"}`}>{t(kind === "reset" ? "group.link.reset" : "group.link.disable")}</button>
    </div>
  </dialog>, document.body);
}
