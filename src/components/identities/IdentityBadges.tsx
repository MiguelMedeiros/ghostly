import { useEngineState, providerLabel, shortSubject, categoryLabel, currentStatus } from "../../lib/identities";
import { ProviderMark } from "./ProviderMark";

/** The contact's verified identities, as small marks beside its name: a click opens the chat's Identities. */
export function IdentityBadges({ peerKey, onOpen }: { peerKey: string; onOpen: () => void }) {
  const state = useEngineState();
  const verified = state?.links.find(l => l.peerPubKeyZ32 === peerKey)?.identities?.received.filter(r => currentStatus(r) === "verified") ?? [];
  if (!verified.length) return null;
  const label = verified.map(r => `${providerLabel(r.provider)} ${shortSubject(r.provider, r.subject)} (verified, ${categoryLabel(r.provider, r.verified.attester).toLowerCase()})`).join(", ");
  return (
    <button type="button" data-testid="chat-identity-badges" onClick={onOpen} title={label} aria-label={`Verified identities: ${label}`}
      className="inline-flex items-center gap-0.5 shrink-0 rounded-md p-0.5 hover:bg-surface-hover cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent">
      {verified.slice(0, 3).map(r => <ProviderMark key={r.id} provider={r.provider} small />)}
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" className="text-accent"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
  );
}
