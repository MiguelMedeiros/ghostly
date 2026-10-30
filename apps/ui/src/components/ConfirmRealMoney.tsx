import { useEffect, useRef, useState } from "react";
import { useI18n } from "../contexts/I18nContext";
import { fillNodes } from "../lib/fillNodes";
import { playCue } from "../lib/cues";
import { focusLost } from "../lib/focus";

/** What can take the keys: an enabled button, field or link. */
const CONTROL = "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]";
const button = "rounded-lg px-3 py-2 max-md:min-h-11 text-xs font-semibold bg-surface-hover text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40";

/**
 * The second step before real money leaves: what goes out, in words, and "Send real money". Every Mainnet spend goes
 * through it (a review, a request paid over Lightning, a pasted invoice, the Cashu card's Pay, a Lightning address),
 * and only its `onSend` passes `confirmedReal` to the engine, which refuses a Mainnet spend without it. Test money
 * never shows it. Back returns to the first step, the keys on the button that opened this; nothing was sent.
 */
export function ConfirmRealMoney({ what, busy, onSend, onBack }: { what: string; busy?: boolean; onSend(): void; onBack(): void }) {
  const { t } = useI18n();
  const back = useRef<HTMLButtonElement>(null);
  // The step replaces the button that opened it, so focus lands in it; on Back, never on Send: a second Enter
  // pressed on the first step must not be the confirmation.
  useEffect(() => back.current?.focus({ preventScroll: true }), []);
  // Back takes this step away with the button pressed, and nothing else takes the keys: they would fall to the page.
  // They go back to the button that opened it (still focused while this first draws), drawn again where it was, or
  // else to the first control there, once the step that returns is in.
  const [opener] = useState(() => (document.activeElement as HTMLElement | null)?.dataset?.testid);
  const group = useRef<HTMLDivElement>(null);
  const backed = useRef(false);
  useEffect(() => {
    const parent = group.current?.parentElement, before = group.current?.previousElementSibling;
    return () => {
      if (!backed.current || !parent?.isConnected || !focusLost()) return;
      const again = opener ? parent.querySelector(`[data-testid="${CSS.escape(opener)}"]:not(:disabled)`) : null;
      if (again instanceof HTMLElement) { again.focus({ preventScroll: true }); return; }
      for (let node = before?.parentElement === parent ? before.nextElementSibling : parent.firstElementChild; node; node = node.nextElementSibling) {
        const control = node.matches(CONTROL) ? node : node.querySelector(CONTROL);
        if (control instanceof HTMLElement) { control.focus({ preventScroll: true }); return; }
      }
    };
  }, [opener]);
  return (
    <div ref={group} className="rounded-lg border border-danger/50 p-2 space-y-2 basis-full" data-testid="review-mainnet-confirm" role="group" aria-label={t("payments.confirmReal.label")}>
      <p className="text-xs text-text-primary m-0">{fillNodes(t("payments.confirmReal.text"), { money: <strong>{t("payments.confirmReal.money")}</strong>, what })}</p>
      <div className="flex gap-2 flex-wrap">
        {/* Busy, not disabled, while it sends: a disabled button drops the keys to the page, and they stay there when the
            payment is refused. A press while busy does nothing. */}
        <button className={`${button} !bg-accent !text-on-accent data-[loading]:opacity-80 data-[loading]:cursor-progress`} data-testid="review-confirm-send"
          {...(busy ? { "aria-disabled": true, "aria-busy": true, "data-loading": true } : {})} onClick={() => { if (busy) return; playCue("realmoney"); onSend(); }}>{t("payments.confirmReal.send")}</button>
        <button ref={back} className={button} data-testid="review-confirm-back" disabled={busy} onClick={() => { backed.current = true; onBack(); }}>{t("common.back")}</button>
      </div>
    </div>
  );
}
