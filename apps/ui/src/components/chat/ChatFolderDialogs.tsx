import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../contexts/I18nContext";
import { useBackdropDismiss } from "../../hooks/useDismiss";
import { FOLDER_NAME_MAX, folderName } from "../../lib/chatFolders";

const DIALOG = "m-auto w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60";
const QUIET = "min-h-11 rounded-lg px-4 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent";

/**
 * Shows a dialog as a modal one, and gives the focus back when it closes: to what had it, else to `returnFocus`, else
 * (a deleted folder takes its own buttons with it) to the list's New, as a deleted chat's dialog does.
 */
function useModal(returnFocus?: RefObject<HTMLElement | null>) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null, opener = returnFocus?.current;
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      const back = before && before !== document.body && before.isConnected ? before : opener?.isConnected ? opener : document.querySelector<HTMLElement>('[data-testid="sidebar-new-chat"]');
      back?.focus();
    };
  }, [returnFocus]);
  return dialog;
}

/** Names a folder: a new one (`name` empty) or one being renamed. `onSave` gets the name as it is kept, never empty. */
export function FolderNameDialog({ name = "", onClose, onSave, returnFocus }: { name?: string; onClose(): void; onSave(name: string): void; returnFocus?: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const id = useId();
  const dialog = useModal(returnFocus);
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(name);
  const backdrop = useBackdropDismiss(onClose);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const kept = folderName(value);
  return createPortal(<dialog ref={dialog} {...backdrop} onCancel={e => { e.preventDefault(); onClose(); }} aria-labelledby={`${id}-title`} data-testid="folder-name-dialog" className={DIALOG}>
    <h2 id={`${id}-title`} className="text-base font-semibold">{name ? t("sidebar.folder.rename") : t("sidebar.folder.newTitle")}</h2>
    <form className="mt-4" onSubmit={e => { e.preventDefault(); if (kept) onSave(kept); }}>
      <input ref={input} value={value} onChange={e => setValue(e.target.value)} maxLength={FOLDER_NAME_MAX} placeholder={t("sidebar.folder.nameLabel")} aria-label={t("sidebar.folder.nameLabel")} data-testid="folder-name"
        className="w-full rounded-lg bg-input-bg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent" />
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={QUIET}>{t("common.cancel")}</button>
        <button type="submit" disabled={!kept} data-testid="folder-name-save"
          className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-panel-header hover:bg-accent-hover disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent">{name ? t("common.save") : t("sidebar.folder.create")}</button>
      </div>
    </form>
  </dialog>, document.body);
}

/** Asks before a folder is deleted, and says what becomes of its chats. */
export function DeleteFolderDialog({ name, onClose, onConfirm, returnFocus }: { name: string; onClose(): void; onConfirm(): void; returnFocus?: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const id = useId();
  const dialog = useModal(returnFocus);
  const cancel = useRef<HTMLButtonElement>(null);
  const backdrop = useBackdropDismiss(onClose);
  useEffect(() => cancel.current?.focus(), []);
  return createPortal(<dialog ref={dialog} {...backdrop} onCancel={e => { e.preventDefault(); onClose(); }} aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} data-testid="folder-delete-dialog" className={DIALOG}>
    <h2 id={`${id}-title`} className="break-words text-base font-semibold">{t("sidebar.folder.deleteTitle", { name })}</h2>
    <p id={`${id}-body`} className="mt-2 text-sm text-text-muted">{t("sidebar.folder.deleteBody")}</p>
    <div className="mt-5 flex justify-end gap-2">
      <button ref={cancel} onClick={onClose} className={QUIET}>{t("common.cancel")}</button>
      <button onClick={onConfirm} data-testid="folder-delete-confirm" className="min-h-11 rounded-lg bg-danger/15 px-4 text-sm text-danger-ink hover:bg-danger/25 focus-visible:ring-2 focus-visible:ring-danger">{t("sidebar.folder.delete")}</button>
    </div>
  </dialog>, document.body);
}
