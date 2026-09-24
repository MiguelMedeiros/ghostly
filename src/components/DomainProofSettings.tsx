import { useState } from "react";
import { DOH_RESOLVERS, chooseResolver, chosenResolver, type DohResolverId } from "@ghostly/browser/proofs/domain";
import { Block, Section } from "./layout";
import { Select } from "./ui/Select";

/**
 * Which DNS-over-HTTPS resolver checks contacts' domain proofs. Stored per browser profile, where the
 * engine reads it (the web page, the extension's offscreen document and the desktop WebView share it).
 */
export function DomainProofSettings() {
  const [resolver, setResolver] = useState<DohResolverId>(() => chosenResolver().id);
  const current = DOH_RESOLVERS.find(r => r.id === resolver)!;
  return (
    <Section title="Identity checks">
      <Block>
        <div>
          <label id="doh-resolver-label" htmlFor="doh-resolver" className="text-text-primary text-sm block">Domain lookups</label>
          <p className="text-text-muted text-xs mt-0.5">
            When a contact shares a domain proof, this app looks up its record through a DNS-over-HTTPS resolver.
            {" "}<strong className="font-medium text-text-primary">{current.name}</strong> learns which domain was looked up and when;
            it does not see your chats. Proofs published as a file on a website are downloaded from that website, which sees your IP address.
          </p>
        </div>
        <Select
          id="doh-resolver"
          data-testid="doh-resolver"
          aria-labelledby="doh-resolver-label"
          value={resolver}
          onChange={id => { chooseResolver(id); setResolver(id); }}
          options={DOH_RESOLVERS.map(r => ({ value: r.id, label: r.name, description: new URL(r.url).host }))}
        />
      </Block>
    </Section>
  );
}
