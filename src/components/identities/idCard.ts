import type { IdentityProofView, LinkView, ReceivedIdentityView } from "@ghostly/browser/shared/types";
import type { Translate } from "../../contexts/I18nContext";
import { providerIcon } from "./ProviderIcons";
import { date, daysLeft, expiringSoon, providerLabel, providerOf, RECEIVED_STATUS, shortSubject } from "../../lib/identities";
import { ago, badgeState } from "./contactBadges";

/**
 * What an identity's ID card says (IdCardFace.tsx), worked out once so the card, its panel and the tests agree.
 *
 * Its status, the worst first: `revoking` while its removal publishes the revocation (the card then leaves the
 * deck: a removed proof is not kept), `expired`, `failed` when a contact's app checked it and refused it,
 * `expiring` in its last days (lib/identities.ts's rule) and otherwise `verified`: it was checked, the way
 * contacts check it, when it was made. A contact's card (receivedIdCard) can also be `revoked` by its owner, or
 * `withdrawn`: no longer shared, or made with a key the contact has since replaced.
 */
export type IdCardStatus = "verified" | "expiring" | "expired" | "failed" | "revoking" | "revoked" | "withdrawn" | "default";

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
  /** Without a picture, the name's initial in the photo slot (the Ghostly card); else the provider's mark goes there. */
  monogram?: string;
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
  /** The machine-readable line, when it is not the provider and the subject (the Ghostly card's is the name). */
  mrz?: string;
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

/**
 * A contact's identity as an ID card: the same card as one's own, its status as this app last checked it
 * (contactBadges.ts's states), "Their own key" or who attests it, and when it was checked in the last field.
 */
export function receivedIdCard(r: ReceivedIdentityView, now = Date.now() / 1000): IdCardContent {
  const attested = providerOf(r.provider)?.category === "provider-attested";
  const badge = badgeState(r, now);
  const status: IdCardStatus = badge === "revoked" ? "revoked" : badge ?? "withdrawn";
  const statusLabel = {
    verified: "Verified",
    expiring: `Expires in ${plural(daysLeft(r.expiresAt, now), "day", "days")}`,
    failed: "Check failed",
    revoked: "Revoked",
    expired: "Expired",
    withdrawn: RECEIVED_STATUS[r.status],
    revoking: "",
  }[status];
  const avatar = r.display?.avatar ?? r.verified.display?.avatar;
  return {
    id: r.id,
    provider: r.provider,
    label: providerLabel(r.provider),
    subject: r.verified.subject,
    short: shortSubject(r.provider, r.verified.subject),
    bound: r.subject,
    name: r.display?.name ?? r.verified.display?.name,
    photo: avatar?.startsWith("data:image/") ? avatar : undefined,
    category: attested ? `Attested by ${r.verified.attester ?? "the provider"}` : "Their own key",
    attested,
    status,
    statusLabel,
    validity: `${r.expiresAt <= now ? "Expired" : "Valid until"} ${date(r.expiresAt)}`,
    issued: date(r.verifiedAt),
    shared: `Checked ${ago(r.checkedAt, now)}`,
    refusedBy: [],
  };
}

/** The ink an identity's card wears (id-deck.css): its provider's, or a key's/an attestation's for one without a mark. */
export const idCardTone = (card: { provider: string; subject: string; attested?: boolean }) =>
  `id-card-${(providerIcon(card.provider, card.subject)?.key ?? (card.attested ? "attested" : "key")).replace(":", "-")}`;

/** The machine-readable line along the bottom of an ID: the provider and the identity, in its alphabet. Decoration. */
export const machineLine = (label: string, subject: string) =>
  `ID<GHOSTLY<<${label}<<${subject}`.toUpperCase().replace(/[^A-Z0-9<]+/g, "<").padEnd(44, "<").slice(0, 44);

/** The id, provider and tone key of the Ghostly card: the profile's own identity, the first card of every deck. */
export const GHOSTLY = "ghostly";

/** A chat's key as the card writes it: the first eight characters of the z32 key, a gap, the last four. */
export const shortKey = (key: string) => (key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-4)}` : key);

/** What the profile tells contacts (Settings: `nick`, `avatar`, `shareProfile`, absent meaning on). */
export interface GhostlyProfile { nick: string; avatar?: string; shareProfile: boolean }

/**
 * The profile's own Ghostly identity as an ID card: its name and picture as contacts get them (or that they are
 * hidden), "Default" for its status, since it is what a contact sees unless another identity is shared with them.
 * Ghostly makes a key pair for each chat, so no key ties chats together: in a chat (`chat`), the card shows this
 * chat's key; on the Identities page, that there is one per chat, and in how many chats it is used. `since` is
 * when the profile was made (milliseconds), when that is known.
 */
export function ghostlyCard(t: Translate, profile: GhostlyProfile, place: { chat?: { key: string; contact: string }; chats?: number; since?: number }): IdCardContent {
  const shown = profile.shareProfile;
  const nick = shown ? profile.nick.trim() : "";
  const name = shown ? nick || t("identities.ghostly.noName") : t("identities.ghostly.hidden");
  const photo = shown && profile.avatar?.startsWith("data:image/") ? profile.avatar : undefined;
  const subject = place.chat ? place.chat.key : t("identities.ghostly.keyPerChat");
  const since = place.since ? date(Math.floor(place.since / 1000)) : "";
  const chats = place.chats ?? 0;
  return {
    id: GHOSTLY,
    provider: GHOSTLY,
    label: t("identities.ghostly.provider"),
    subject,
    short: place.chat ? shortKey(place.chat.key) : subject,
    bound: GHOSTLY,
    name,
    photo,
    monogram: !photo && nick ? nick.charAt(0).toUpperCase() : undefined,
    category: place.chat ? t("identities.ghostly.keyInChat") : t("identities.ghostly.yourOwnKeys"),
    attested: false,
    status: "default",
    statusLabel: t("identities.ghostly.default"),
    validity: since ? t("identities.ghostly.since", { date: since }) : t("identities.ghostly.seenByDefault"),
    issued: since,
    shared: place.chat ? t("identities.ghostly.sharedWith", { contact: place.chat.contact })
      : chats === 0 ? t("identities.ghostly.noChats") : chats === 1 ? t("identities.ghostly.usedInOneChat") : t("identities.ghostly.usedInChats", { count: chats }),
    refusedBy: [],
    mrz: machineLine(t("identities.ghostly.provider"), nick || (place.chat ? shortKey(place.chat.key) : "")),
  };
}

/**
 * A contact's Ghostly identity as an ID card, the first of their cards in a chat: the name and picture they sent
 * (`fallback` names them when they sent none), their key in this chat, and whether it is verified: codes compared
 * in the chat's connection panel, and the key unchanged since (`LinkView.peerVerified`).
 */
export function contactGhostlyCard(t: Translate, link: Pick<LinkView, "peerNick" | "peerAvatar" | "peerPubKeyZ32" | "peerVerified" | "createdAt">, fallback: string): IdCardContent {
  const nick = link.peerNick?.trim() ?? "";
  const photo = link.peerAvatar?.startsWith("data:image/") ? link.peerAvatar : undefined;
  const since = link.createdAt ? date(Math.floor(link.createdAt / 1000)) : "";
  return {
    id: GHOSTLY,
    provider: GHOSTLY,
    label: t("identities.ghostly.provider"),
    subject: link.peerPubKeyZ32,
    short: shortKey(link.peerPubKeyZ32),
    bound: GHOSTLY,
    name: nick || fallback,
    photo,
    monogram: !photo && nick ? nick.charAt(0).toUpperCase() : undefined,
    category: t("identities.ghostly.theirKeyInChat"),
    attested: false,
    status: "default",
    statusLabel: link.peerVerified ? t("identities.ghostly.verified") : t("identities.ghostly.notVerified"),
    validity: since ? t("identities.ghostly.chatSince", { date: since }) : t("identities.ghostly.theirDefault"),
    issued: since,
    shared: t("identities.ghostly.theirDefault"),
    refusedBy: [],
    mrz: machineLine(t("identities.ghostly.provider"), nick || shortKey(link.peerPubKeyZ32)),
  };
}
