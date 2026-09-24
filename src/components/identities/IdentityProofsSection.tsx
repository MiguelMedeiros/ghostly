import { useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { IdentityProofView } from "@ghostly/browser/shared/types";
import { Block, Button, Notice, Row, Section } from "../wallet/ui";
import { addableProviders, date, providerLabel, providerOf, shortSubject, useEngineState } from "../../lib/identities";
import { AddIdentityDialog } from "./AddIdentityDialog";
import { ProviderMark, StatusPill } from "./ProviderMark";

/**
 * Profile → Identities: proofs that this profile controls external identities. Made once here; each chat
 * then shares them with that contact only when the person chooses (the chat's Identities).
 */
export function IdentityProofsSection() {
  const state = useEngineState();
  const proofs = state?.identityProofs ?? [];
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const now = Math.floor(Date.now() / 1000);
  if (!state) return null;
  const canAdd = addableProviders().length > 0;
  return (<>
    <Section title="Identities" testId="profile-identities">
      {proofs.length === 0 && <Block><p className="text-xs text-text-muted">Prove that you hold a Nostr key or another identity, then show it to the contacts you choose, one chat at a time. Your Ghostly identity stays the default.</p></Block>}
      {proofs.map((p: IdentityProofView) => {
        const expired = p.expiresAt <= now;
        const attested = providerOf(p.provider)?.category === "provider-attested";
        return (
          <Row key={p.id} testId="identity-proof" leading={<ProviderMark provider={p.provider} subject={p.verified.subject} />}
            label={<span className="flex flex-wrap items-center gap-2"><span>{providerLabel(p.provider)}</span><StatusPill ok={!expired}>{expired ? "Expired" : attested ? `Attested by ${p.verified.attester}` : "Your key"}</StatusPill></span>}
            hint={<>
              <span className="font-mono break-all" data-testid="identity-proof-subject" title={p.verified.subject}>{shortSubject(p.provider, p.verified.subject)}</span>
              <span className="block">{expired ? `Expired ${date(p.expiresAt)}` : `Until ${date(p.expiresAt)}`} · {p.sharedWith === 0 ? "Not shared" : `Shared in ${p.sharedWith} ${p.sharedWith === 1 ? "chat" : "chats"}`}</span>
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
