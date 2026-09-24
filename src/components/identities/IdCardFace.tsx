import { providerIcon } from "./ProviderIcons";
import { ProviderMark } from "./ProviderMark";
import { machineLine, type IdCardContent } from "./idCard";
import "./id-deck.css";

const GHOST = <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z" /><circle cx="9" cy="9" r="1.5" fill="var(--seal-eye)" /><circle cx="15" cy="9" r="1.5" fill="var(--seal-eye)" /></svg>;

const CHECK = <svg viewBox="0 0 16 16" fill="none"><path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;

function StatusIcon({ status }: { status: IdCardContent["status"] }) {
  const d = status === "verified" ? "m3 8 3 3 7-7" : status === "expiring" ? "M8 4v4.5l3 2" : status === "revoking" ? "M4 8h8" : "M8 4v5M8 11.5v.5";
  return <svg aria-hidden="true" width="10" height="10" viewBox="0 0 16 16" fill="none"><path d={d} stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/** A card's provider on a 14px tile, for the row of marks under a deck of ID cards; none for the blank one that adds. */
export function IdCardMark({ provider, subject }: { provider?: string; subject?: string }) {
  if (!provider) return <span className="id-deck-mark id-deck-mark-plain"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg></span>;
  const icon = providerIcon(provider, subject);
  if (!icon) return <span className="id-deck-mark id-deck-mark-plain"><svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="4" /></svg></span>;
  return <span className={`id-deck-mark forced-color-adjust-none ${icon.tile}`}>{icon.mark(10)}</span>;
}

/**
 * An identity as an ID card, in the family of the wallet's payment cards (same size, same deck, same motion) but
 * read like a document: a band with the issuer and the status, a photo slot (the identity's own picture, or its
 * provider's mark), the fields, a hologram seal with the ghost and the machine-readable line along the bottom.
 * In a stack, a card before the chosen one shows its leading edge (the photo and the provider); one after it, its
 * trailing edge, where the provider's mark comes up in the band beside the seal. In a chat's picker, a card shared
 * with that contact wears a check seal (`shared`): on the photo's corner, and beside the mark on the trailing edge.
 */
export function IdCardFace({ card, after, shared }: { card: IdCardContent; after?: boolean; shared?: boolean }) {
  return (
    <span className="id-card-face" data-deck="face" data-after={after || undefined} data-status={card.status} data-shared={shared || undefined}>
      <span className="id-card-band">
        <span className="id-card-issuer">Ghostly · Identity</span>
        <span className="id-card-status" data-testid={card.status === "expiring" ? "identity-proof-expiring" : undefined}><StatusIcon status={card.status} />{card.statusLabel}</span>
        <span className="id-card-mark-end" aria-hidden="true">{shared && <span className="id-card-check id-card-check-small">{CHECK}</span>}<ProviderMark provider={card.provider} subject={card.bound} small /></span>
      </span>
      <span className="id-card-photo" aria-hidden="true">
        {card.photo ? <><img src={card.photo} alt="" /><span className="id-card-photo-badge"><ProviderMark provider={card.provider} subject={card.bound} small /></span></>
          : <ProviderMark provider={card.provider} subject={card.bound} />}
        {/* Shared in this chat: a check seal on the photo's corner, which shows on every card of a stack. */}
        {shared && <span className="id-card-check" data-testid="id-card-shared" title="Shared">{CHECK}</span>}
      </span>
      <span className="id-card-fields">
        <span className="id-card-provider">{card.label}</span>
        {card.name && <span className="id-card-name">{card.name}</span>}
        <span className="id-card-subject" data-testid="identity-proof-subject" title={card.subject}>{card.short}</span>
        <span className="id-card-field">{card.category}</span>
        <span className="id-card-field">{card.validity}</span>
        <span className="id-card-field">{card.shared}</span>
      </span>
      <span className="id-card-mrz" aria-hidden="true">{machineLine(card.label, card.subject)}</span>
      <span className="id-card-seal" data-deck="ghost" aria-hidden="true">{GHOST}</span>
      <span className="id-card-sheen" data-deck="sheen" aria-hidden="true" />
    </span>
  );
}

/** The last card of the deck: a blank ID waiting for an identity. With none yet, it is the whole deck. */
export function AddIdCardFace({ first }: { first: boolean }) {
  return (
    <span className="id-card-face id-card-blank" data-deck="face">
      <span className="id-card-band"><span className="id-card-issuer">Ghostly · Identity</span></span>
      <span className="id-card-photo" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg></span>
      <span className="id-card-fields">
        <span className="id-card-provider">{first ? "Add your first identity" : "Add identity"}</span>
        <span className="id-card-field">A Nostr key, a domain, an account…</span>
        <span className="id-card-field">Shown only in the chats you choose</span>
      </span>
      <span className="id-card-mrz" aria-hidden="true">{"ID<GHOSTLY<<".padEnd(44, "<")}</span>
      <span className="id-card-seal" data-deck="ghost" aria-hidden="true">{GHOST}</span>
      <span className="id-card-sheen" data-deck="sheen" aria-hidden="true" />
    </span>
  );
}
