import { useState } from "react";
import { walletRemoval } from "@ghostly/browser/shared/walletRemoval";
import type { WalletPlatform, WalletState } from "../../lib/platform";
import { useI18n } from "../../contexts/I18nContext";
import { walletLabel } from "./names";
import { RemoveWalletDialog } from "./RemoveWallet";
import { removalWords } from "./removalWords";
import { useRun } from "./run";
import { Block, Button, Notice } from "./ui";

type Mint = WalletState["mints"][number];

/**
 * Removing one mint of the Cashu wallet, asked once below its row (Remove there opens it). A mint that still waits
 * for money (an invoice not paid yet, paid ecash not claimed) lists it, and goes only once the person agrees; the
 * engine checks it again. The last mint of a network is the wallet itself: the wallet's own removal opens, and says so.
 */
export function RemoveMintConfirm({ mint, wallet, state, onClose }: { mint: Mint; wallet: WalletPlatform; state: WalletState; onClose: () => void }) {
  const { t } = useI18n();
  const [understood, setUnderstood] = useState(false);
  const { busy, error, run } = useRun();
  const network = state.mode === "testnet" ? "testnet" : "mainnet";
  const words = removalWords(t);
  const awaiting = mint.awaiting ?? [];
  const question = t("wallet.cashu.removeMintQuestion", { name: mint.name });

  if (state.mints.length === 1) {
    const removal = walletRemoval("cashu", network, state, state.intents, undefined, words);
    return <RemoveWalletDialog removal={removal} wallet={wallet} lead={t("wallet.cashu.removeLastMint", { label: walletLabel("cashu", network) })} onClose={onClose} onRemoved={onClose} />;
  }
  return (
    <Block>
      <div className="space-y-2 text-sm" data-testid="mint-remove-confirm" role="group" aria-label={question}>
        <p className="font-semibold text-text-primary">{question}</p>
        {awaiting.length > 0 ? <>
          <p className="text-xs text-text-secondary">{t("wallet.cashu.removeMintAwaiting")}</p>
          <ul className="bg-surface rounded-xl divide-y divide-border" data-testid="mint-remove-awaiting">
            {awaiting.map((a, i) => <li key={`${a.kind}-${a.paymentId ?? i}`} className="px-3 py-2" data-kind={a.kind}>{words.item(a.kind, words.sats(a.amount, network))}</li>)}
          </ul>
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-danger)]" data-testid="mint-remove-understood" checked={understood} disabled={busy} onChange={(e) => setUnderstood(e.target.checked)} />
            <span>{t("wallet.cashu.removeMintConsent")}</span>
          </label>
        </> : <p className="text-xs text-text-secondary">{t("wallet.cashu.removeMintHint")}</p>}
        {error && <Notice tone="error" testId="mint-remove-error">{error}</Notice>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button data-testid="mint-remove-cancel" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="danger" data-testid="mint-remove-yes" disabled={busy || (awaiting.length > 0 && !understood)}
            onClick={() => void run(async () => { await wallet.removeMint(mint.url, awaiting.length > 0); onClose(); })}>{t("wallet.cashu.remove")}</Button>
        </div>
      </div>
    </Block>
  );
}
