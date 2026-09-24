import type { HTMLAttributes, ReactNode, Ref } from "react";
import "./composer-sheet.css";

/**
 * The box a chat's composer opens over the message input to choose among cards: the payment picker
 * (PaymentComposer.tsx: the wallet's cards) and the identity picker (identities/ComposerIdentities.tsx: ID cards).
 * On a phone it is a bottom sheet over a backdrop (index.css's `.sheet`). Both pickers share this shell, its head, the
 * hint under the deck and the primary action, so they look and fit alike.
 */
export function ComposerSheet({ ref, className = "", children, ...props }: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) {
  return (<>
    <div className="sheet-backdrop" />
    <div ref={ref} {...props}
      className={`composer-sheet sheet sheet-padded absolute bottom-full left-0 mb-2 z-50 animate-fade-in w-[400px] max-w-[calc(100vw-1.5rem)] bg-panel-header border border-border rounded-2xl shadow-2xl p-3 ${className}`}>
      {children}
    </div>
  </>);
}

/** The sheet's title and whom the chat is with; `before` is a button that goes back a step. */
export function ComposerSheetHead({ title, who, titleId, before }: { title: ReactNode; who: ReactNode; titleId?: string; before?: ReactNode }) {
  return (
    <div className="composer-sheet-head">
      {before}
      <span id={titleId} className="composer-sheet-title">{title}</span>
      <span className="composer-sheet-who">{who}</span>
    </div>
  );
}

/** The arrow of an action that goes on to the chosen card. */
export const ForwardArrow = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
