import { useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { IdentityProofView } from "@ghostly/browser/shared/types";
import { Block, Button, Notice, Row, Section } from "../wallet/ui";
import { addableProviders, chatsByPeer, contactName, date, daysLeft, expiringSoon, providerLabel, providerOf, shortSubject, useEngineState } from "../../lib/identities";
import { useI18n } from "../../contexts/I18nContext";
import { AddIdentityDialog } from "./AddIdentityDialog";
import { ProviderMark, StatusPill } from "./ProviderMark";

/**
 * Identities → Yours: proofs that this profile controls external identities, with what needs doing about
 * them (one expiring soon, one a contact could not verify). Made once here; each chat then shares them with
 * that contact only when the person chooses (the chat's Identities).
 */
export function IdentityProofsSection() {
  const state = useEngineState();
  const { t } = useI18n();
  const proofs = state?.identityProofs ?? [];
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const now = Math.floor(Date.now() / 1000);
  if (!state) return null;
  const canAdd = addableProviders().length > 0;
  /** Contacts whose app checked this proof and refused it. */
  const refusing = state.links.filter(l => l.identities?.shared.some(s => s.status === "rejected"));
  const chats = refusing.length ? chatsByPeer() : undefined;
  const refusedBy = (id: string) => refusing.filter(l => l.identities!.shared.some(s => s.id === id && s.status === "rejected")).map(l => contactName(chats?.get(l.peerPubKeyZ32)) ?? t("common.anonymous"));
  return (<>
    <Section title="Yours" testId="identities-mine">
      {proofs.length === 0 && <Block><p className="text-xs text-text-muted">Prove that you hold a Nostr key or another identity, then show it to the contacts you choose, one chat at a time. Your Ghostly identity stays the default.</p></Block>}
      {proofs.map((p: IdentityProofView) => {
        const expired = p.expiresAt <= now;
        const expiring = expiringSoon(p, now);
        const attested = providerOf(p.provider)?.category === "provider-attested";
        const refused = refusedBy(p.id);
        return (
          <Row key={p.id} testId="identity-proof" leading={<ProviderMark provider={p.provider} subject={p.verified.subject} />}
            label={<span className="flex flex-wrap items-center gap-2"><span>{providerLabel(p.provider)}</span>
              <StatusPill ok={!expired}>{expired ? "Expired" : attested ? `Attested by ${p.verified.attester}` : "Your key"}</StatusPill>
              {expiring && <StatusPill warn testId="identity-proof-expiring">{`Expires in ${daysLeft(p.expiresAt, now)} ${daysLeft(p.expiresAt, now) === 1 ? "day" : "days"}`}</StatusPill>}
            </span>}
            hint={<>
              <span className="font-mono break-all" data-testid="identity-proof-subject" title={p.verified.subject}>{shortSubject(p.provider, p.verified.subject)}</span>
              <span className="block">{expired ? `Expired ${date(p.expiresAt)}` : `Until ${date(p.expiresAt)}`} · {p.sharedWith === 0 ? "Not shared" : `Shared in ${p.sharedWith} ${p.sharedWith === 1 ? "chat" : "chats"}`}</span>
              {refused.length > 0 && <span className="block text-danger" data-testid="identity-proof-refused">Not verified by {refused.join(", ")}</span>}
              {(expired || expiring) && <span className="block">Add it again to renew it; then remove this one.</span>}
            </>}>
            {removing === p.id ? <>
              <Button variant="danger" data-testid="identity-proof-remove-confirm" onClick={() => void engine.call("removeIdentityProof", { id: p.id }).then(() => { setRemoving(null); setError(""); }, e => setError(e instanceof Error ? e.message : String(e)))}>Remove and stop sharing</Button>
              <Button onClick={() => setRemoving(null)}>Keep</Button>
            </> : <Button data-testid="identity-proof-remove" onClick={() => setRemoving(p.id)}>Remove</Button>}
          </Row>
        );
      })}
      {removing && <Block><Notice>Contacts you shared it with are told it is no longer shared, and a revocation is published so they can see it even if you never reconnect. A copy they kept cannot be erased.</Notice></Block>}
      {error && <Block><Notice tone="error">{error}</Notice></Block>}
      {canAdd && <button type="button" data-testid="identity-add" onClick={() => setAdding(true)} className="w-full px-4 py-3 min-h-12 text-left text-sm text-text-secondary hover:text-accent hover:bg-surface-alt transition-colors cursor-pointer last:rounded-b-xl">+ Add an identity</button>}
    </Section>
    {adding && <AddIdentityDialog onClose={() => setAdding(false)} />}
  </>);
}
