import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../contexts/I18nContext";

/** The frame of the device dialogs (WISP 06): a modal card with a title and a close button. Plain until part 10. */
export function DeviceDialog({ title, onClose, testId, children }: { title: string; onClose(): void; testId: string; children: ReactNode }) {
  const { t } = useI18n();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(
    <dialog ref={dialog} data-testid={testId} onCancel={(event) => { event.preventDefault(); onClose(); }} aria-labelledby={`${id}-title`}
      className="m-auto w-[calc(100%_-_2rem)] max-w-sm max-h-[85dvh] overflow-y-auto rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id={`${id}-title`} className="font-semibold min-w-0 break-words">{title}</h2>
        <button type="button" onClick={onClose} aria-label={t("common.close")} className="h-10 w-10 shrink-0 cursor-pointer rounded-lg text-xl hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">×</button>
      </div>
      <div className="space-y-3 text-sm">{children}</div>
    </dialog>,
    document.body,
  );
}

export const primaryButton = "inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-on-accent hover:bg-accent-hover cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-not-allowed";
export const quietButton = "inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-border px-3 py-2.5 text-sm font-semibold text-text-secondary hover:bg-surface-hover cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40";
export const field = "w-full min-w-0 px-3 py-2 min-h-11 bg-input-bg border border-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent";

/** The six digits as people read them: "482 913", large and spaced. */
export function Digits({ digits, testId }: { digits: string; testId: string }) {
  return <p data-testid={testId} data-digits={digits} className="text-center text-3xl font-semibold tracking-[0.2em] tabular-nums text-text-primary" dir="ltr">{`${digits.slice(0, 3)} ${digits.slice(3)}`}</p>;
}
