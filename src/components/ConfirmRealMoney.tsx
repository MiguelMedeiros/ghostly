import { useEffect, useRef } from "react";
import { MONEY_LABEL } from "./NetworkTag";

const button = "rounded-lg px-3 py-2 max-md:min-h-11 text-xs font-semibold bg-surface-hover text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40";

/**
 * The second step before real money leaves: what goes out, in words, and "Send real money". Every Mainnet spend goes
 * through it (a review, a request paid over Lightning, a pasted invoice, the Cashu card's Pay, a Lightning address),
 * and only its `onSend` passes `confirmedReal` to the engine, which refuses a Mainnet spend without it. Test money
 * never shows it. Back returns to the first step; nothing was sent.
 */
export function ConfirmRealMoney({ what, busy, onSend, onBack }: { what: string; busy?: boolean; onSend(): void; onBack(): void }) {
  const back = useRef<HTMLButtonElement>(null);
  // The step replaces the button that opened it, so focus lands in it; on Back, never on Send: a second Enter
  // pressed on the first step must not be the confirmation.
  useEffect(() => back.current?.focus({ preventScroll: true }), []);
  return (
    <div className="rounded-lg border border-danger/50 p-2 space-y-2 basis-full" data-testid="review-mainnet-confirm" role="group" aria-label="Confirm real money">
      <p className="text-xs text-text-primary m-0"><strong>{MONEY_LABEL.mainnet}.</strong> This sends {what} that cannot be taken back once it settles. Nothing has gone out yet.</p>
      <div className="flex gap-2 flex-wrap">
        <button className={`${button} !bg-accent !text-on-accent`} data-testid="review-confirm-send" disabled={busy} onClick={onSend}>Send real money</button>
        <button ref={back} className={button} data-testid="review-confirm-back" disabled={busy} onClick={onBack}>Back</button>
      </div>
    </div>
  );
}
