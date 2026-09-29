import { useState } from "react";
import type { WalletPlatform, WalletSetupView, WalletType } from "../../lib/platform";
import { useI18n } from "../../contexts/I18nContext";
import { Button, Notice } from "./ui";
import { walletLabel } from "./names";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A new profile's default Mainnet wallets, made in the background: while they are made, a line says so; a kind that
 * could not be made says why on its own row, with Try again (and Skip, so it is not tried at every start). Nothing
 * here is an error of the app's first screen: it only shows on the Wallet page.
 */
export function WalletSetupStatus({ wallet, setup, showProgress }: { wallet: WalletPlatform; setup: WalletSetupView; showProgress: boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<WalletType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (type: WalletType, work: () => Promise<void>) => {
    setBusy(type); setError(null);
    try { await work(); } catch (e) { setError(message(e)); } finally { setBusy(null); }
  };
  if (!setup.failed.length && !(showProgress && setup.running)) return null;
  return (
    <section className="space-y-3 rounded-2xl border border-border bg-panel-header p-4" data-testid="wallet-setup" aria-live="polite">
      {showProgress && setup.running && !setup.failed.length && <Notice testId="wallet-setup-progress">{t("wallet.setup.progress")}</Notice>}
      {setup.failed.length > 0 && <p className="text-sm font-medium text-text-primary">{t("wallet.setup.title")}</p>}
      {setup.failed.map((f) => (
        <div key={f.type} className="space-y-2" data-testid={`wallet-setup-failed-${f.type}`}>
          <Notice tone="error" testId={`wallet-setup-error-${f.type}`}>{f.reason}</Notice>
          <div className="flex flex-wrap gap-2">
            <Button data-testid={`wallet-setup-retry-${f.type}`} disabled={!!busy || setup.running} onClick={() => void act(f.type, () => wallet.setupRetry(f.type))}>
              {busy === f.type || setup.running ? t("wallet.first.creating") : t("wallet.setup.retry", { wallet: walletLabel(f.type, f.network) })}
            </Button>
            <Button data-testid={`wallet-setup-skip-${f.type}`} disabled={!!busy || setup.running} onClick={() => void act(f.type, () => wallet.setupDismiss(f.type))}>{t("wallet.setup.skip")}</Button>
          </div>
        </div>
      ))}
      {error && <Notice tone="error" testId="wallet-setup-action-error">{error}</Notice>}
    </section>
  );
}
