import { useState } from "react";
import { DOH_RESOLVERS, chooseResolver, chosenResolver, type DohResolverId } from "@ghostly/browser/proofs/domain";
import { useI18n } from "../contexts/I18nContext";
import { Row, Section } from "./layout";
import { Select } from "./ui/Select";

/**
 * Which DNS-over-HTTPS resolver checks contacts' domain proofs. Stored per browser profile, where the
 * engine reads it (the web page, the extension's offscreen document and the desktop WebView share it).
 */
export function DomainProofSettings() {
  const { t } = useI18n();
  const [resolver, setResolver] = useState<DohResolverId>(() => chosenResolver().id);
  const current = DOH_RESOLVERS.find(r => r.id === resolver)!;
  return (
    <Section title={t("network.identityChecks")}>
      <Row label={<span id="doh-resolver-label">{t("network.domainLookups")}</span>} hint={t("network.domainLookupsHint")} info={t("network.domainLookupsInfo", { name: current.name })}>
        <Select
          fit
          id="doh-resolver"
          data-testid="doh-resolver"
          aria-labelledby="doh-resolver-label"
          value={resolver}
          onChange={id => { chooseResolver(id); setResolver(id); }}
          options={DOH_RESOLVERS.map(r => ({ value: r.id, label: r.name, description: new URL(r.url).host }))}
        />
      </Row>
    </Section>
  );
}
