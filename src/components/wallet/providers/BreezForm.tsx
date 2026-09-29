import { useState } from "react";
import { isRecoveryPhrase, newRecoveryPhrase } from "@ghostly/browser/engine/paymentAdapters/providers/recoveryPhrase";
import { Button, Notice, Segmented, input } from "../ui";
import type { ProviderFormProps } from "./forms";

/**
 * Breez's form: the wallet is Ghostly's to make, so a new one gets a recovery phrase made here, shown
 * once to be written down, and an existing one is restored from its phrase. The phrase and the API key
 * are the descriptor's secret fields: sealed on this device by the engine, never shown again.
 */
export function BreezForm({ descriptor, mode, busy, onSubmit }: ProviderFormProps) {
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
      <Segmented label="Breez wallet" value={kind} onChange={setKind} options={[{ value: "new", label: "New wallet" }, { value: "restore", label: "Restore" }]} />
      {kind === "new" ? (
        <div className="space-y-2">
          <ol className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1.5 bg-surface-alt rounded-lg p-2.5 font-mono text-xs text-text-primary select-all" data-testid="breez-new-phrase" aria-label="New recovery phrase">
            {fresh.split(" ").map((word, i) => <li key={i} className="flex gap-1.5"><span className="text-text-muted w-5 text-right">{i + 1}</span>{word}</li>)}
          </ol>
          <Notice tone="warning">Write these words down: they are the only way back to this wallet&apos;s sats. Ghostly seals them on this device and does not show them again.</Notice>
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input type="checkbox" checked={written} onChange={(e) => setWritten(e.target.checked)} data-testid="breez-phrase-written" />
            I wrote the recovery phrase down
          </label>
        </div>
      ) : (
        <label className="block space-y-1">
          <span className="text-xs text-text-secondary">Recovery phrase</span>
          <textarea aria-label="Recovery phrase" className={`${input} font-mono text-xs resize-none`} rows={3} spellCheck={false} placeholder="twelve or twenty-four words" value={restored} onChange={(e) => setRestored(e.target.value)} />
          {invalid && <span className="block text-[11px] text-danger" data-testid="breez-phrase-invalid">That is not a valid recovery phrase.</span>}
        </label>
      )}
      <label className="block space-y-1">
        <span className="text-xs text-text-secondary">Breez API key{!needsKey && <span className="text-text-muted"> (optional in Testnet)</span>}</span>
        <input aria-label="Breez API key" className={`${input} font-mono text-xs`} type="password" autoComplete="new-password" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        <span className="block text-[11px] text-text-muted">{needsKey ? "Mainnet needs one: Breez gives them for free." : "Regtest works without one."}</span>
      </label>
      <Button type="submit" variant="primary" className="w-full" disabled={busy || !ready || invalid} data-testid="provider-save">{busy ? "Connecting…" : `Use ${descriptor.label}`}</Button>
      <Notice>The recovery phrase and the API key are sealed on this device and never shown again.</Notice>
    </form>
  );
}
