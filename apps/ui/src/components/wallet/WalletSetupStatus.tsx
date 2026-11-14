import { useEffect, useRef, useState } from "react";
import type { WalletPlatform, WalletSetupView, WalletType } from "../../lib/platform";
import { useI18n } from "../../contexts/I18nContext";
import { Button, Notice } from "./ui";
import { failedBecause, walletLabel } from "./names";
import { problemText, type Problem } from "../../lib/problemText";
import { focusLost } from "../../lib/focus";

/**
 * Where the focus goes once the row of the pressed button went with it (skipped, or made): the next row's Try again,
 * else the page's New. Never away from something that took the focus in the meantime.
 */
function focusAfterRow() {
  if (!focusLost()) return;
  (document.querySelector<HTMLElement>("[data-testid^='wallet-setup-retry-']") ?? document.querySelector<HTMLElement>("[data-testid='wallet-add']"))?.focus({ preventScroll: true });
}

/**
 * A new profile's default Mainnet wallets, made in the background: while they are made, a line says so; a kind that
 * could not be made says why on its own row, with Try again (and Skip, so it is not tried at every start). Nothing
 * here is an error of the app's first screen: it only shows on the Wallet page.
 */
export function WalletSetupStatus({ wallet, setup, showProgress }: { wallet: WalletPlatform; setup: WalletSetupView; showProgress: boolean }) {
  const { t } = useI18n();
  // The button pressed works as `loading`, not disabled: that dropped a keyboard's focus to the page, and left it there
  // when the wallet could not be made again.
  const [busy, setBusy] = useState<{ type: WalletType; action: "retry" | "skip" } | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  // A press here: the row it was on may go (skipped, or made), with the focus on it. The row goes with the engine's next
  // view, which can come after the press's answer, so the focus moves on once it has gone, not when the answer comes.
  const pressedHere = useRef(false);
  const act = async (type: WalletType, action: "retry" | "skip", work: () => Promise<void>) => {
    pressedHere.current = true;
    setBusy({ type, action }); setError(null);
    try { await work(); } catch (e) { setError(problemText(e, t)); } finally { setBusy(null); }
  };
  const pressed = (type: WalletType, action: "retry" | "skip") => busy?.type === type && busy.action === action;
  const rows = setup.failed.map((f) => f.type).join(" ");
  const rowsBefore = useRef(rows);
  // Once nothing is at work any more: the next row's buttons are disabled until then, and take no focus.
  const landing = useRef(false);
  const working = !!busy || setup.running;
  useEffect(() => {
    const gone = rowsBefore.current.split(" ").some((type) => type && !rows.split(" ").includes(type));
    rowsBefore.current = rows;
    if (gone && pressedHere.current) { pressedHere.current = false; landing.current = true; }
    if (landing.current && !working) { landing.current = false; requestAnimationFrame(focusAfterRow); }
  }, [rows, working]);
  // The last row gone, the whole list goes from the page.
  useEffect(() => () => { if (pressedHere.current || landing.current) requestAnimationFrame(focusAfterRow); }, []);
  if (!setup.failed.length && !(showProgress && setup.running)) return null;
  return (
    <section className="space-y-3 rounded-2xl border border-border bg-panel-header p-4" data-testid="wallet-setup" aria-live="polite">
      {showProgress && setup.running && !setup.failed.length && <Notice testId="wallet-setup-progress">{t("wallet.setup.progress")}</Notice>}
      {setup.failed.length > 0 && <p className="text-sm font-medium text-text-primary">{t("wallet.setup.title")}</p>}
      {setup.failed.map((f) => (
        <div key={f.type} className="space-y-2" data-testid={`wallet-setup-failed-${f.type}`}>
          <Notice tone="error" testId={`wallet-setup-error-${f.type}`} details={problemText(f.reason, t).detail}>{t("wallet.setup.failed", { wallet: walletLabel(f.type, f.network), reason: failedBecause(f.reason, t) })}</Notice>
          <div className="flex flex-wrap gap-2">
            <Button data-testid={`wallet-setup-retry-${f.type}`} disabled={!!busy || setup.running} loading={pressed(f.type, "retry")} onClick={() => void act(f.type, "retry", () => wallet.setupRetry(f.type))}>
              {pressed(f.type, "retry") || setup.running ? t("wallet.first.creating") : t("wallet.setup.retry", { wallet: walletLabel(f.type, f.network) })}
            </Button>
            <Button data-testid={`wallet-setup-skip-${f.type}`} disabled={!!busy || setup.running} loading={pressed(f.type, "skip")} onClick={() => void act(f.type, "skip", () => wallet.setupDismiss(f.type))}>{t("wallet.setup.skip")}</Button>
          </div>
        </div>
      ))}
      {error && <Notice problem={error} testId="wallet-setup-action-error" />}
    </section>
  );
}
