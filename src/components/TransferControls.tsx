import type { ReactNode } from "react";
import type { TransferMove } from "../lib/fileStatus";

/**
 * A file or voice note that did not go shows it on the bubble itself, where its play button or file icon was: a round
 * button (↻ send again, ↓ ask for the rest), with the reason behind ⓘ. While it moves, a ring around that place fills.
 */

const SIZE = 36;
const RING = 2;

/** The round button in the icon's place. Failed: danger ink; stalled: the bubble's own ink. */
export function MoveButton({ move, onPress, testId, busy }: { move: TransferMove; onPress: () => void; testId: string; busy?: boolean }) {
  const failed = move.action === "retry";
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={move.label}
      title={move.hint}
      disabled={busy}
      onClick={onPress}
      className={`w-9 h-9 shrink-0 flex items-center justify-center rounded-full bg-transparent border-2 cursor-pointer disabled:opacity-60 disabled:cursor-default hover:bg-black/15 ${failed ? "border-danger-ink text-danger-ink" : "border-text-primary/70 text-text-primary/90"}`}
    >
      {move.action === "request" ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 4v12" /><path d="m6 11 6 6 6-6" /><path d="M5 20h14" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" />
        </svg>
      )}
    </button>
  );
}

/** A ring around the 36 px icon place, filled to `value` (0 to 1): the file on its way. */
export function ProgressRing({ value, children, testId }: { value: number; children: ReactNode; testId?: string }) {
  const radius = (SIZE - RING) / 2;
  const length = 2 * Math.PI * radius;
  const shown = Math.min(1, Math.max(0.03, value));
  return (
    <span className="relative inline-flex shrink-0 w-9 h-9" data-testid={testId} data-progress={Math.round(value * 100)}>
      {children}
      <svg className="absolute inset-0 pointer-events-none -rotate-90" width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <circle cx={SIZE / 2} cy={SIZE / 2} r={radius} fill="none" strokeWidth={RING} className="stroke-black/20" />
        <circle cx={SIZE / 2} cy={SIZE / 2} r={radius} fill="none" strokeWidth={RING} strokeLinecap="round"
          className="stroke-text-primary/85 transition-[stroke-dashoffset] duration-200" strokeDasharray={length} strokeDashoffset={length * (1 - shown)} />
      </svg>
    </span>
  );
}

/** ⓘ after the short status: opens the whole reason under the bubble's line. */
export function ReasonToggle({ open, onToggle, testId }: { open: boolean; onToggle: () => void; testId: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label="Why"
      aria-expanded={open}
      title="Why"
      onClick={onToggle}
      className="shrink-0 w-4 h-4 inline-flex items-center justify-center rounded-full bg-transparent border border-current p-0 text-[10px] leading-none font-semibold italic cursor-pointer opacity-80 hover:opacity-100"
    >
      i
    </button>
  );
}
