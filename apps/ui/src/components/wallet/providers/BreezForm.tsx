import { useState } from "react";
import { isRecoveryPhrase, newRecoveryPhrase } from "@ghostly/browser/engine/paymentAdapters/providers/recoveryPhrase";
import { Button, Notice, Segmented, input } from "../ui";
import type { ProviderFormProps } from "./forms";
import { useI18n } from "../../../contexts/I18nContext";

/**
 * Breez's form: the wallet is Ghostly's to make, so a new one gets a recovery phrase made here, shown
 * once to be written down, and an existing one is restored from its phrase. The phrase and the API key
 * are the descriptor's secret fields: sealed on this device by the engine, never shown again.
 */
export function BreezForm({ descriptor, mode, busy, onSubmit }: ProviderFormProps) {
  const { t } = useI18n();
  const [kind, setKind] = useState<"new" | "restore">("new");
  const [fresh] = useState(newRecoveryPhrase);
  const [written, setWritten] = useState(false);
  const [restored, setRestored] = useState("");
  const [apiKey, setApiKey] = useState("");
  const needsKey = mode === "mainnet";
  const phrase = kind === "new" ? fresh : restored;
  const invalid = kind === "restore" && restored.trim() !== "" && !isRecoveryPhrase(restored);
  const ready = (kind === "new" ? written : restored.trim() !== "") && (!needsKey || apiKey.trim() !== "");

  return (
    <form className="space-y-3" data-testid={`provider-form-${descriptor.id}`} autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (ready) onSubmit({ mnemonic: phrase, apiKey }); }}>
      <Segmented label={t("wallet.source.breez.label")} value={kind} onChange={setKind} options={[{ value: "new", label: t("wallet.source.newWallet") }, { value: "restore", label: t("wallet.source.restore") }]} />
      {kind === "new" ? (
        <div className="space-y-2">
          <ol className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1.5 bg-surface-alt rounded-lg p-2.5 font-mono text-xs text-text-primary select-all" data-testid="breez-new-phrase" aria-label={t("wallet.source.breez.newPhrase")}>
            {fresh.split(" ").map((word, i) => <li key={i} className="flex gap-1.5"><span className="text-text-muted w-5 text-end">{i + 1}</span>{word}</li>)}
          </ol>
          <Notice tone="warning">{t("wallet.source.breez.writeDown")}</Notice>
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input type="checkbox" checked={written} onChange={(e) => setWritten(e.target.checked)} data-testid="breez-phrase-written" />
            {t("wallet.source.breez.written")}
          </label>
        </div>
      ) : (
        <label className="block space-y-1">
          <span className="text-xs text-text-secondary">{t("wallet.source.breez.phrase")}</span>
          <textarea aria-label={t("wallet.source.breez.phrase")} className={`${input} font-mono text-xs resize-none`} rows={3} spellCheck={false} placeholder={t("wallet.source.breez.phrasePlaceholder")} value={restored} onChange={(e) => setRestored(e.target.value)} />
          {invalid && <span className="block text-[11px] text-danger" data-testid="breez-phrase-invalid">{t("wallet.source.breez.invalid")}</span>}
        </label>
      )}
      <label className="block space-y-1">
        <span className="text-xs text-text-secondary">{t("wallet.source.breez.apiKey")}{!needsKey && <span className="text-text-muted"> {t("wallet.source.breez.optionalTestnet")}</span>}</span>
        <input aria-label={t("wallet.source.breez.apiKey")} className={`${input} font-mono text-xs`} type="password" autoComplete="new-password" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        <span className="block text-[11px] text-text-muted">{needsKey ? t("wallet.source.breez.mainnetNeedsKey") : t("wallet.source.breez.regtestNoKey")}</span>
      </label>
      <Button type="submit" variant="primary" className="w-full" disabled={busy || !ready || invalid} data-testid="provider-save">{busy ? t("wallet.source.connecting") : t("wallet.source.use", { name: descriptor.label })}</Button>
      <Notice>{t("wallet.source.breez.sealed")}</Notice>
    </form>
  );
}
