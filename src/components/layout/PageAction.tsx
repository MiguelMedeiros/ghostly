import type { ButtonHTMLAttributes } from "react";

/**
 * A page's primary action in its header (Page `trailing`): an accent button with a plus and a short label ("New").
 * It creates what the page lists, the way New on the chat list does; the label stays on a phone.
 */
export function PageAction({ label, testId, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; testId?: string }) {
  return (
    <button type="button" data-testid={testId} {...props}
      className={`inline-flex items-center justify-center gap-1.5 min-h-9 max-md:min-h-11 px-3 rounded-lg bg-accent text-on-accent text-sm font-semibold whitespace-nowrap hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel-header ${className}`}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
      <span>{label}</span>
    </button>
  );
}
