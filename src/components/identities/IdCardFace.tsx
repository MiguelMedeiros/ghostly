import { useI18n } from "../../contexts/I18nContext";
import { providerIcon } from "./ProviderIcons";
import { ProviderMark } from "./ProviderMark";
import { machineLine, type IdCardContent } from "./idCard";
import "./id-deck.css";

const GHOST = <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z" /><circle cx="9" cy="9" r="1.5" fill="var(--seal-eye)" /><circle cx="15" cy="9" r="1.5" fill="var(--seal-eye)" /></svg>;

const CHECK = <svg viewBox="0 0 16 16" fill="none"><path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;

function StatusIcon({ status }: { status: IdCardContent["status"] }) {
  // The Ghostly card's "Default" (and a contact's Verified / Not verified): a small ghost, the card's own mark.
  if (status === "default") return <svg aria-hidden="true" width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a4.5 4.5 0 0 0-4.5 4.5V13c0 .5.4.7.7.4L5.75 12l1.5 1.4c.2.2.5.2.75 0L8 13l.75.4c.25.2.55.2.75 0l1.5-1.4 1.55 1.4c.3.3.7.1.7-.4V6.5A4.5 4.5 0 0 0 8 2z" /></svg>;
  const d = status === "verified" ? "m3 8 3 3 7-7" : status === "expiring" ? "M8 4v4.5l3 2" : status === "revoking" || status === "withdrawn" ? "M4 8h8" : status === "revoked" ? "M4 12 12 4" : "M8 4v5M8 11.5v.5";
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
 * The profile's own Ghostly identity is one of these too (idCard.ts `ghostlyCard`): the profile's picture, or the
 * name's initial, in the photo slot, and "Default" for a status.
 */
export function IdCardFace({ card, after, shared }: { card: IdCardContent; after?: boolean; shared?: boolean }) {
  return (
    <span className="id-card-face" data-deck="face" data-after={after || undefined} data-status={card.status} data-shared={shared || undefined}>
      <span className="id-card-band">
        <span className="id-card-issuer">Ghostly<span className="id-card-issuer-kind"> · Identity</span></span>
        <span className="id-card-status" data-testid={card.status === "expiring" ? "identity-proof-expiring" : undefined}><StatusIcon status={card.status} /><span className="id-card-status-text">{card.statusLabel}</span></span>
        <span className="id-card-mark-end" aria-hidden="true">{shared && <span className="id-card-check id-card-check-small">{CHECK}</span>}<ProviderMark provider={card.provider} subject={card.bound} small /></span>
      </span>
      <span className="id-card-photo" aria-hidden="true">
        {card.photo ? <><img src={card.photo} alt="" /><span className="id-card-photo-badge"><ProviderMark provider={card.provider} subject={card.bound} small /></span></>
          : card.monogram ? <><span className="id-card-monogram" data-testid="id-card-monogram">{card.monogram}</span><span className="id-card-photo-badge"><ProviderMark provider={card.provider} subject={card.bound} small /></span></>
            : <ProviderMark provider={card.provider} subject={card.bound} />}
        {/* Shared in this chat: a check seal on the photo's corner, which shows on every card of a stack. */}
        {shared && <span className="id-card-check" data-testid="id-card-shared" title="Shared">{CHECK}</span>}
      </span>
      <span className="id-card-fields">
        <span className="id-card-provider">{card.label}</span>
        {card.name && <span className="id-card-name" data-testid="id-card-name">{card.name}</span>}
        <span className="id-card-subject" data-testid="identity-proof-subject" title={card.subject}>{card.short}</span>
        <span className="id-card-field id-card-field-category">{card.category}</span>
        <span className="id-card-field id-card-field-validity">{card.validity}</span>
        <span className="id-card-field id-card-field-shared">{card.shared}</span>
      </span>
      <span className="id-card-mrz" aria-hidden="true">{card.mrz ?? machineLine(card.label, card.subject)}</span>
      <span className="id-card-seal" data-deck="ghost" aria-hidden="true">{GHOST}</span>
      <span className="id-card-sheen" data-deck="sheen" aria-hidden="true" />
    </span>
  );
}

/**
 * The last card of the deck: a blank ID waiting for an identity, the kinds it can add as a row of marks. It comes
 * after the profile's Ghostly card, so it is never alone: "Add an identity" while it is the only other card, then
 * "Add another identity".
 */
export function AddIdCardFace({ first, providers = [] }: { first: boolean; providers?: string[] }) {
  const { t } = useI18n();
  return (
    <span className="id-card-face id-card-blank" data-deck="face">
      <span className="id-card-band"><span className="id-card-issuer">Ghostly<span className="id-card-issuer-kind"> · Identity</span></span></span>
      <span className="id-card-photo" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg></span>
      <span className="id-card-fields">
        <span className="id-card-provider">{first ? t("identities.ghostly.addOne") : t("identities.ghostly.addAnother")}</span>
        {providers.length > 0 && <span className="id-card-providers" aria-hidden="true" data-testid="id-card-providers">{providers.map(p => <IdCardMark key={p} provider={p} />)}</span>}
        <span className="id-card-field id-card-field-shared">{t("identities.ghostly.chosenChats")}</span>
      </span>
      <span className="id-card-mrz" aria-hidden="true">{"ID<GHOSTLY<<".padEnd(44, "<")}</span>
      <span className="id-card-seal" data-deck="ghost" aria-hidden="true">{GHOST}</span>
      <span className="id-card-sheen" data-deck="sheen" aria-hidden="true" />
    </span>
  );
}
