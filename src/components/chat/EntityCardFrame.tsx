import type { ReactNode } from "react";

/** The cards' buttons, as the invoice card has them: one filled action, the rest quiet. */
export const cardButton =
  "px-3 py-1.5 max-md:min-h-11 bg-accent text-on-accent rounded-lg text-xs font-bold hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
export const cardQuiet =
  "px-3 py-1.5 max-md:min-h-11 bg-black/20 hover:bg-black/30 rounded-lg text-xs font-bold transition-colors cursor-pointer inline-flex items-center disabled:opacity-40 disabled:cursor-not-allowed";

/**
 * One card under a message's text: a mark, what it is, one line of who or what, and whatever the card shows and
 * does below. Drawn inside the bubble, so it reads on either bubble colour (see e2e/web/bubble-contrast.spec.ts).
 */
export function EntityCardFrame({ testId, mark, label, title, subtitle, children, data }: {
  testId: string; mark: ReactNode; label: string; title: ReactNode; subtitle?: ReactNode; children?: ReactNode;
  data?: Record<`data-${string}`, string | undefined>;
}) {
  return (
    <div data-testid={testId} data-entity-card {...data}
      className="mt-1.5 mb-0.5 w-[min(300px,72vw)] max-w-full rounded-lg border border-text-primary/10 bg-text-primary/5 p-2.5 text-start">
      <div className="flex items-start gap-2.5">
        <span className="shrink-0">{mark}</span>
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[11px] uppercase tracking-wider text-text-primary/65">{label}</p>
          <p className="m-0 text-[13.5px] font-semibold leading-snug text-text-primary [overflow-wrap:anywhere]">{title}</p>
          {subtitle && <p className="m-0 mt-0.5 text-xs leading-snug text-text-primary/65 [overflow-wrap:anywhere]">{subtitle}</p>}
        </div>
      </div>
      {children && <div className="mt-2 space-y-2 text-xs leading-snug text-text-primary/80">{children}</div>}
    </div>
  );
}

/** A round tile with a line icon, for the cards that have no provider mark (a chat, a group). */
export function CardIcon({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden="true" className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-accent/15 text-accent">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
    </span>
  );
}
