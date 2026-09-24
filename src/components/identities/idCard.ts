import type { IdentityProofView } from "@ghostly/browser/shared/types";
import { providerIcon } from "./ProviderIcons";
import { date, daysLeft, expiringSoon, providerLabel, providerOf, shortSubject } from "../../lib/identities";

/**
 * What an identity's ID card says (IdCardFace.tsx), worked out once so the card, its panel and the tests agree.
 *
 * Its status, the worst first: `revoking` while its removal publishes the revocation (the card then leaves the
 * deck: a removed proof is not kept), `expired`, `failed` when a contact's app checked it and refused it,
 * `expiring` in its last days (lib/identities.ts's rule) and otherwise `verified`: it was checked, the way
 * contacts check it, when it was made.
 */
export type IdCardStatus = "verified" | "expiring" | "expired" | "failed" | "revoking";

export interface IdCardContent {
  id: string;
  provider: string;
  /** The provider's name: "Nostr", "Domain", "Account at a provider". */
  label: string;
  /** The identity in full, and as short as the provider writes it (npub1ab…yz, a domain, a login). */
  subject: string;
  short: string;
  /** What the statement names, which picks the provider's mark: for an account, the provider it was made at. */
  bound: string;
  /** A name the evidence carried (a Nostr profile's), and its picture: a sanitized data URL, never a remote one. */
  name?: string;
  photo?: string;
  /** Who stands behind it: the key's holder, or the provider that attests it. */
  category: string;
  attested: boolean;
  status: IdCardStatus;
  /** The status in a few words, for the card's corner. */
  statusLabel: string;
  /** Until when it holds, or since when it no longer does. */
  validity: string;
  issued: string;
  /** In how many chats it is shared. */
  shared: string;
  /** Contacts whose apps refused it. */
  refusedBy: string[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function idCard(p: IdentityProofView, { now = Date.now() / 1000, refusedBy = [], revoking = false }: { now?: number; refusedBy?: string[]; revoking?: boolean } = {}): IdCardContent {
  const attested = providerOf(p.provider)?.category === "provider-attested";
  const expired = p.expiresAt <= now;
  const status: IdCardStatus = revoking ? "revoking" : expired ? "expired" : refusedBy.length ? "failed" : expiringSoon(p, now) ? "expiring" : "verified";
  const statusLabel = {
    revoking: "Revoking…",
    expired: "Expired",
    failed: "Check failed",
    expiring: `Expires in ${plural(daysLeft(p.expiresAt, now), "day", "days")}`,
    verified: "Verified",
  }[status];
  return {
    id: p.id,
    provider: p.provider,
    label: providerLabel(p.provider),
    subject: p.verified.subject,
    short: shortSubject(p.provider, p.verified.subject),
    bound: p.subject,
    name: p.verified.display?.name,
    photo: p.verified.display?.avatar?.startsWith("data:image/") ? p.verified.display.avatar : undefined,
    category: attested ? `Attested by ${p.verified.attester ?? "the provider"}` : "Your own key",
    attested,
    status,
    statusLabel,
    validity: `${expired ? "Expired" : "Valid until"} ${date(p.expiresAt)}`,
    issued: date(p.issuedAt),
    shared: p.sharedWith === 0 ? "Not shared" : `Shared in ${plural(p.sharedWith, "chat", "chats")}`,
    refusedBy,
  };
}

/** The ink an identity's card wears (id-deck.css): its provider's, or a key's/an attestation's for one without a mark. */
export const idCardTone = (card: { provider: string; subject: string; attested?: boolean }) =>
  `id-card-${(providerIcon(card.provider, card.subject)?.key ?? (card.attested ? "attested" : "key")).replace(":", "-")}`;

/** The machine-readable line along the bottom of an ID: the provider and the identity, in its alphabet. Decoration. */
export const machineLine = (label: string, subject: string) =>
  `ID<GHOSTLY<<${label}<<${subject}`.toUpperCase().replace(/[^A-Z0-9<]+/g, "<").padEnd(44, "<").slice(0, 44);
