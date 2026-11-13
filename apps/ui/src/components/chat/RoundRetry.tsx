import type { ReactNode } from "react";
import { useOptionalI18n } from "../../contexts/I18nContext";

const R = 16.5;
const AROUND = 2 * Math.PI * R;

/**
 * A media bubble's pill button (Accept, Download <size>, Pause, the speed) is drawn by its fill alone, and in forced
 * colors (Windows Contrast themes) every fill is the page's: there it keeps a ButtonText edge. Solid, since the pills'
 * `border-none` leaves the border style at none, under which a width alone draws nothing.
 */
export const FORCED_EDGE = "forced-colors:border forced-colors:border-solid forced-colors:border-[color:ButtonText]";

/**
 * A ring around a round 36 px control: how much of a file has gone (`fraction`), or a turning arc while an action
 * waits for its answer (`busy`). Drawn in the text's colour, which reads on both bubbles in every theme.
 */
export function ProgressRing({ fraction, busy = false, className = "text-text-primary/80", testId }: { fraction?: number; busy?: boolean; className?: string; testId?: string }) {
  const shown = busy ? 0.25 : Math.min(1, Math.max(0, fraction ?? 0));
  return (
    <svg viewBox="0 0 36 36" aria-hidden="true" data-testid={testId} data-busy={busy || undefined}
      className={`absolute inset-0 w-full h-full -rotate-90 pointer-events-none ${busy ? "animate-spin motion-reduce:animate-none" : ""} ${className}`}>
      <circle cx="18" cy="18" r={R} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <circle cx="18" cy="18" r={R} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={AROUND} strokeDashoffset={AROUND * (1 - shown)} className="transition-[stroke-dashoffset] duration-200" />
    </svg>
  );
}

const retryGlyph = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v5h-5" />
  </svg>
);

/**
 * The ↻ that takes the place of a voice message's play button or a file's icon when it did not go (`danger`: a
 * red ring) or stopped moving (a quiet one). While its action runs (`busy`) the ring turns, and a press does nothing;
 * it is not disabled, which would drop a keyboard's focus to the page (as the play button there keeps it). On a phone a
 * tap lands on 44 × 44 px around it (`.tap-target`), as on that play button.
 */
export function RoundRetry({ danger = false, busy = false, label, hint, testId, onClick }: {
  danger?: boolean;
  busy?: boolean;
  label: string;
  /** One line, on hover. */
  hint?: string;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button type="button" data-testid={testId} aria-label={label} title={hint ?? label} aria-busy={busy || undefined} aria-disabled={busy || undefined} onClick={() => { if (!busy) onClick(); }}
      data-tone={danger ? "danger" : "neutral"}
      className={`tap-target relative w-9 h-9 shrink-0 grid place-items-center rounded-full border-none bg-black/20 hover:bg-black/30 cursor-pointer aria-disabled:cursor-default transition-colors ${danger ? "text-danger-ink" : "text-text-primary/90"}`}>
      <ProgressRing fraction={1} busy={busy} className={danger ? "text-danger-ink" : "text-text-primary/65"} />
      {retryGlyph}
    </button>
  );
}

/**
 * ⓘ beside a short status: the longer reason (an error's own words) opens under it. `open` is the caller's, so the
 * reason can sit where the bubble has room.
 */
export function WhyButton({ open, onToggle, controls, testId, danger = false }: { open: boolean; onToggle: () => void; controls: string; testId: string; danger?: boolean }) {
  const more = useOptionalI18n()?.t("common.moreInfo") ?? "More info";
  return (
    <button type="button" data-testid={testId} aria-expanded={open} aria-controls={controls} aria-label={more} title={more} onClick={onToggle}
      className={`relative shrink-0 inline-grid place-items-center w-4 h-4 rounded-full border-none bg-transparent p-0 cursor-pointer before:absolute before:-inset-2 max-md:before:-inset-3.5 before:content-[''] ${danger ? "text-danger-ink" : "text-text-primary/65"} hover:opacity-80`}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5" /><path d="M12 11v5.5M12 7.5v.01" /></svg>
    </button>
  );
}

/** The reason under a status, once its ⓘ is open. `english`: an error's own words, laid out and read as English. */
export function WhyText({ id, testId, english = false, children }: { id: string; testId: string; english?: boolean; children: ReactNode }) {
  return <p id={id} data-testid={testId} {...(english && { dir: "ltr", lang: "en" })} className="m-0 mt-1 px-1 text-[11.5px] leading-snug text-text-primary/80 wrap-break-word">{children}</p>;
}

