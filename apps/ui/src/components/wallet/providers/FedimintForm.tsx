import { useState } from "react";
import { useServicesPlatform } from "../../../hooks/useServicesPlatform";
import { Button, Notice } from "../ui";
import { Select } from "../../ui/Select";
import type { ProviderFormProps } from "./forms";
import { useI18n } from "../../../contexts/I18nContext";
import { formatAmount } from "../../../lib/amount";

/**
 * The Fedimint source's form: one of the federations joined on the Fedimint card (with a gateway module), not an
 * id to type. Joining happens there, with the federation's details shown first.
 */
export function FedimintForm({ descriptor, busy, onSubmit }: ProviderFormProps) {
  const { t } = useI18n();
  const state = useServicesPlatform()?.wallet?.getState();
  const federations = (state?.fedimint?.federations ?? []).filter((f) => f.lightning);
  const [chosen, setChosen] = useState<string>("");
  const federation = chosen || federations[0]?.id || "";
  if (!federations.length) return <Notice testId={`provider-form-${descriptor.id}`}>{t("wallet.source.fedimint.joinFirst")}</Notice>;
  return (
    <form className="space-y-3" data-testid={`provider-form-${descriptor.id}`} onSubmit={(e) => { e.preventDefault(); if (federation) onSubmit({ federation }); }}>
      <Select aria-label={t("wallet.source.fedimint.label")} value={federation} onChange={setChosen}
        options={federations.map((f) => ({ value: f.id, label: f.name ?? `${f.id.slice(0, 8)}…`, description: t("wallet.source.fedimint.description", { amount: formatAmount(f.balance, t.language), network: f.network ?? t("wallet.source.fedimint.unknownNetwork") }) }))} />
      <Button type="submit" variant="primary" disabled={busy || !federation}>{t("wallet.source.fedimint.use")}</Button>
    </form>
  );
}
