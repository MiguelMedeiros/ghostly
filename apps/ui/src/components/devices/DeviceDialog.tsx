import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../contexts/I18nContext";
import { InfoButton } from "../layout/Section";

/**
 * The frame of the device dialogs (WISP 06): a modal card with a title and a close button, the width of a phone less its
 * gutters and at most 24rem, scrolling inside when it is taller than the window. Escape closes it and gives the focus
 * back to what opened it.
 */
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
        <h2 id={`${id}-title`} className="text-base font-semibold min-w-0 break-words">{title}</h2>
        <button type="button" onClick={onClose} aria-label={t("common.close")} className="h-10 w-10 shrink-0 cursor-pointer rounded-lg text-xl hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">×</button>
      </div>
      <div className="space-y-3 text-sm">{children}</div>
    </dialog>,
    document.body,
  );
}

export const primaryButton = "inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-on-accent hover:bg-accent-hover cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-not-allowed";
export const quietButton = "inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-border px-3 py-2.5 text-sm font-semibold text-text-secondary hover:bg-surface-hover cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40";
/** An action that cannot be undone from here (Remove): the danger color, never the accent. */
export const dangerButton = "inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-danger-fill px-3 py-2.5 text-sm font-semibold text-white hover:bg-danger-fill/80 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar-bg disabled:opacity-40 disabled:cursor-not-allowed";
export const field = "w-full min-w-0 px-3 py-2 min-h-11 bg-input-bg border border-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent";

/** The six digits as people read them: "482 913", large and spaced. */
export function Digits({ digits, testId }: { digits: string; testId: string }) {
  return <p data-testid={testId} data-digits={digits} className="text-center text-3xl font-semibold tracking-[0.2em] tabular-nums text-text-primary" dir="ltr">{`${digits.slice(0, 3)} ${digits.slice(3)}`}</p>;
}

/** The full-screen notices' buttons (standby, limited start): full width on a phone, side by side from a small tablet up, 44 px tall to touch. */
export const SCREEN_BUTTON = "inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold bg-accent text-on-accent hover:bg-accent-hover cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-chat-bg disabled:opacity-40 disabled:cursor-not-allowed max-sm:w-full";
export const SCREEN_QUIET = "inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-sm text-text-secondary border border-border hover:bg-surface-hover hover:text-text-primary cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-not-allowed max-sm:w-full";

/** A small spinner beside a status line: something is going on, and nothing is asked of the person yet. */
export function Spinner() {
  return <span aria-hidden="true" className="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-accent border-e-transparent motion-reduce:animate-none" />;
}

/**
 * Where an enrollment stands, in one line (WISP 06 § User experience): with a spinner while it waits on the network or
 * on the other device. Read out as it changes.
 */
export function Status({ children, spin = true, testId, step }: { children: ReactNode; spin?: boolean; testId?: string; step?: string }) {
  return (
    <p role="status" aria-live="polite" data-testid={testId} data-step={step} className="flex items-center gap-2 text-text-secondary">
      {spin && <Spinner />}<span className="min-w-0">{children}</span>
    </p>
  );
}

/** One line, with the rest of what there is to say behind an ⓘ (the app's copy rule: details behind ⓘ). */
export function InfoLine({ children, info, testId, className = "text-text-secondary" }: { children: ReactNode; info: ReactNode; testId?: string; className?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return <>
    <div className="flex items-start gap-2" data-testid={testId}>
      <p className={`flex-1 min-w-0 ${className}`}>{children}</p>
      <InfoButton open={open} onToggle={() => setOpen(!open)} controls={id} testId={testId ? `${testId}-info` : undefined} className="mt-0.5" />
    </div>
    {open && <p id={id} className="text-xs text-text-secondary leading-relaxed ps-3 border-s-2 border-border">{info}</p>}
  </>;
}
