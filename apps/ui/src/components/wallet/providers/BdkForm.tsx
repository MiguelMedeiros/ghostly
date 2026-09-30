import { useState } from "react";
import { newBdkPhrase } from "@ghostly/browser/engine/paymentAdapters/providers/bdkPhrase";
import { Notice, Segmented } from "../ui";
import type { ProviderFormProps } from "./forms";
import { useI18n } from "../../../contexts/I18nContext";
import { ProviderConfigForm } from "./SourcePicker";

/**
 * The BDK wallet's form: a new wallet, whose 12 words Ghostly makes and shows once to be written down, or
 * one restored from its words. Then the declared fields (network, Esplora server, address type).
 */
export function BdkForm(props: ProviderFormProps) {
  const { t } = useI18n();
  const [kind, setKind] = useState<"new" | "restore">("new");
  const [phrase] = useState(newBdkPhrase);
  const [written, setWritten] = useState(false);
  const [error, setError] = useState("");
  const fields = kind === "new" ? props.descriptor.fields.filter((f) => f.name !== "mnemonic") : props.descriptor.fields;
  const submit = (values: Record<string, string>) => {
    if (kind === "restore") return props.onSubmit(values);
    if (!written) { setError(t("wallet.source.bdk.writeFirst")); return; }
    props.onSubmit({ ...values, mnemonic: phrase });
  };
  return (
    <div className="space-y-3">
      <Segmented label={t("wallet.source.bdk.label")} value={kind} onChange={(next) => { setKind(next); setError(""); }} options={[{ value: "new", label: t("wallet.source.newWallet") }, { value: "restore", label: t("wallet.source.restore") }]} />
      {kind === "new" && (
        <div className="space-y-2">
          <ol className="grid grid-cols-3 gap-1.5 font-mono text-xs list-none p-0 m-0" data-testid="bdk-new-phrase">
            {phrase.split(" ").map((word, i) => <li key={i} className="bg-surface-alt rounded px-2 py-1"><span className="text-text-muted me-1">{i + 1}</span>{word}</li>)}
          </ol>
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input type="checkbox" checked={written} onChange={(e) => { setWritten(e.target.checked); setError(""); }} data-testid="bdk-written" />
            {t("wallet.source.bdk.written")}
          </label>
        </div>
      )}
      <ProviderConfigForm {...props} key={kind} descriptor={{ ...props.descriptor, fields }} onSubmit={submit} />
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
