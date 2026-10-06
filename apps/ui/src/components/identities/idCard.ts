import type { IdentityTimelineEntry } from "@ghostly/core";
import type { IdentityProofView, LinkView, PublicProfileView, ReceivedIdentityView } from "@ghostly/browser/shared/types";
import { hasPublicProfile } from "@ghostly/browser/profiles/readers";
import type { ProfileLookup } from "../../hooks/usePublicProfileRequest";
import type { Translate } from "../../contexts/I18nContext";
import { providerIcon } from "./ProviderIcons";
import { categoryLabel, date, daysLeft, expiringSoon, providerLabel, providerOf, receivedStatus, shortSubject } from "../../lib/identities";
import { english } from "../../lib/english";
import { ago, badgeState } from "./contactBadges";

/**
 * What an identity's ID card says (IdCardFace.tsx), worked out once so the card, its panel and the tests agree.
 *
 * Its status, the worst first: `revoking` while its removal publishes the revocation (the card then leaves the
 * deck: a removed proof is not kept), `expired`, `failed` when a contact's app checked it and refused it,
 * `expiring` in its last days (lib/identities.ts's rule) and otherwise `verified`: it was checked, the way
 * contacts check it, when it was made. A contact's card (receivedIdCard) can also be `revoked` by its owner, or
 * `withdrawn`: no longer shared, or made with a key the contact has since replaced. A share in a chat's timeline
 * (shareIdCard) is `checking` until the contact's app has answered.
 */
export type IdCardStatus = "verified" | "expiring" | "expired" | "failed" | "revoking" | "revoked" | "withdrawn" | "default" | "checking";

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
  /** The identity's public profile as its network publishes it (PUBLIC-PROFILES.md): its picture and name go on the face. */
  profile?: PublicProfileView;
  /** Set while the proof is current and verified, for a provider with public profiles: the card asks for it when on screen. */
  lookup?: ProfileLookup;
}

/** The profile's picture and name, when its network has them; else what the evidence carried. */
const face = (profile: PublicProfileView | undefined, name: string | undefined, avatar: string | undefined) => {
  const picture = profile?.found && profile.avatar?.startsWith("data:image/") ? profile.avatar : avatar?.startsWith("data:image/") ? avatar : undefined;
  return { name: (profile?.found ? profile.name : undefined) ?? name, photo: picture };
};
/**
 * The profile and its lookup, for a provider with public profiles and only while the proof is current and verified:
 * an expired, revoked or withdrawn identity's card never wears what its account says about itself.
 */
const profileOf = (provider: string, subject: string, profile: PublicProfileView | undefined, current: boolean): { lookup?: ProfileLookup; profile?: PublicProfileView } =>
  current && hasPublicProfile(provider) ? { lookup: { provider, subject }, ...(profile ? { profile } : {}) } : {};

/** "Expires in 3 days", "Expires in 1 day". */
const expiresIn = (t: Translate, expiresAt: number, now: number) => {
  const days = daysLeft(expiresAt, now);
  return days === 1 ? t("identities.card.expiresInOne") : t("identities.card.expiresIn", { count: days });
};
/** "Valid until 3 Oct 2026", or "Expired 3 Oct 2026". */
const validity = (t: Translate, expiresAt: number, now: number) =>
  expiresAt <= now ? t("identities.card.expiredOn", { date: date(expiresAt) }) : t("identities.card.validUntil", { date: date(expiresAt) });

/** `t`: the interface's words (English by default, as in tests). */
export function idCard(p: IdentityProofView, { now = Date.now() / 1000, refusedBy = [], revoking = false, t = english }: { now?: number; refusedBy?: string[]; revoking?: boolean; t?: Translate } = {}): IdCardContent {
  const attested = providerOf(p.provider)?.category === "provider-attested";
  const expired = p.expiresAt <= now;
  const status: IdCardStatus = revoking ? "revoking" : expired ? "expired" : refusedBy.length ? "failed" : expiringSoon(p, now) ? "expiring" : "verified";
  const statusLabel = {
    revoking: t("identities.card.revoking"),
    expired: t("identities.card.expired"),
    failed: t("identities.card.failed"),
    expiring: expiresIn(t, p.expiresAt, now),
    verified: t("identities.card.verified"),
  }[status];
  const pp = profileOf(p.provider, p.verified.subject, p.publicProfile, !expired && !revoking);
  return {
    id: p.id,
    provider: p.provider,
    label: providerLabel(p.provider),
    subject: p.verified.subject,
    short: shortSubject(p.provider, p.verified.subject),
    bound: p.subject,
    ...face(pp.profile, p.verified.display?.name, p.verified.display?.avatar),
    category: categoryLabel(p.provider, p.verified.attester, t, true),
    attested,
    status,
    statusLabel,
    validity: validity(t, p.expiresAt, now),
    issued: date(p.issuedAt),
    shared: p.sharedWith === 0 ? t("identities.card.notShared") : p.sharedWith === 1 ? t("identities.card.sharedInOne") : t("identities.card.sharedIn", { count: p.sharedWith }),
    refusedBy,
    ...pp,
  };
}

/**
 * A contact's identity as an ID card: the same card as one's own, its status as this app last checked it
 * (contactBadges.ts's states), "Their own key" or who attests it, and when it was checked in the last field.
 */
/** `t` and `language`: the interface's words, and its language for "3 h ago" (English by default, as in tests). */
export function receivedIdCard(r: ReceivedIdentityView, now = Date.now() / 1000, t: Translate = english, language?: string): IdCardContent {
  const attested = providerOf(r.provider)?.category === "provider-attested";
  const badge = badgeState(r, now);
  const status: IdCardStatus = badge === "revoked" ? "revoked" : badge ?? "withdrawn";
  const statusLabel = {
    verified: t("identities.card.verified"),
    expiring: expiresIn(t, r.expiresAt, now),
    failed: t("identities.card.failed"),
    revoked: t("identities.card.revoked"),
    expired: t("identities.card.expired"),
    withdrawn: receivedStatus(r.status, t),
    revoking: "",
  }[status];
  const avatar = r.display?.avatar ?? r.verified.display?.avatar;
  const pp = profileOf(r.provider, r.verified.subject, r.publicProfile, status === "verified" || status === "expiring");
  return {
    id: r.id,
    provider: r.provider,
    label: providerLabel(r.provider),
    subject: r.verified.subject,
    short: shortSubject(r.provider, r.verified.subject),
    bound: r.subject,
    ...face(pp.profile, r.display?.name ?? r.verified.display?.name, avatar),
    category: categoryLabel(r.provider, r.verified.attester, t),
    attested,
    status,
    statusLabel,
    validity: validity(t, r.expiresAt, now),
    issued: date(r.verifiedAt),
    shared: t("identities.card.checked", { time: ago(r.checkedAt, now, language) }),
    refusedBy: [],
    ...pp,
  };
}

/**
 * Where a share stands in its chat's timeline (IdentityShareLine.tsx). `waiting`: mine, the contact not connected
 * yet. `unanswered`: theirs, never presented. `withdrawn`, `revoked`: it stopped later (its owner took it back, or
 * its proof key published a revocation).
 */
export type ShareState = "verifying" | "waiting" | "unanswered" | "verified" | "failed" | "withdrawn" | "revoked";

/**
 * A share in a chat's timeline as an ID card: the identity's own card (mine: idCard, the contact's: receivedIdCard)
 * when this app still holds it, else what the timeline entry kept (the kind, and the identity once presented), with
 * the share's state in the status corner. A verified share says what its card says now (verified, expiring,
 * expired); any other state is the share's own, and then the card wears no public profile: a share that failed or
 * stopped never shows what the account says about itself.
 *
 * It never asks for a public profile (no `lookup`): a card in the timeline wears the picture and name this app
 * already has, and a contact's profile is only fetched once their card is opened (PUBLIC-PROFILES.md: a chat on
 * screen must not reach the identity's network by itself).
 */
export function shareIdCard(entry: IdentityTimelineEntry, state: ShareState, { proof, received, contact, now = Date.now() / 1000, t = english, language }: {
  proof?: IdentityProofView; received?: ReceivedIdentityView; contact?: string; now?: number; t?: Translate; language?: string;
} = {}): IdCardContent {
  const own = received ? receivedIdCard(received, now, t, language) : proof ? idCard(proof, { now, t }) : undefined;
  const subject = own?.subject ?? entry.subject ?? "";
  const base: IdCardContent = own ?? {
    id: entry.proof, provider: entry.provider, label: providerLabel(entry.provider), subject, short: subject ? shortSubject(entry.provider, subject) : "…", bound: subject,
    category: "", attested: providerOf(entry.provider)?.category === "provider-attested", status: "checking", statusLabel: "", validity: "", issued: "", shared: "", refusedBy: [],
  };
  // One of mine says, as in the picker, whether this contact sees it.
  const stopped = state === "withdrawn" || state === "revoked";
  const shared = proof && contact ? { shared: stopped ? t("identities.picker.notSharedWith", { contact }) : t("identities.ghostly.sharedWith", { contact }) } : {};
  const { lookup: _lookup, ...known } = base;
  if (state === "verified") return own ? { ...known, ...shared } : { ...known, status: "verified", statusLabel: t("identities.card.verified") };
  const { name: _name, photo: _photo, profile: _profile, ...plain } = known;
  const status: IdCardStatus = state === "failed" || stopped ? state : "checking";
  const statusLabel = {
    verifying: t("identities.share.checking"), waiting: t("identities.share.waiting"), unanswered: t("identities.share.notChecked"),
    failed: t("identities.share.notVerified"), withdrawn: t("identities.status.withdrawn"), revoked: t("identities.card.revoked"),
  }[state];
  return { ...plain, ...shared, status, statusLabel };
}

/** The ink an identity's card wears (id-deck.css): its provider's, or a key's/an attestation's for one without a mark. */
export const idCardTone = (card: { provider: string; subject: string; attested?: boolean }) =>
  `id-card-${(providerIcon(card.provider, card.subject)?.key ?? (card.attested ? "attested" : "key")).replace(":", "-")}`;

/**
 * The machine-readable line along the bottom of an ID: the provider and the identity, in its alphabet. Decoration.
 * Accented letters lose their marks first, as a passport writes them ("João" is JOAO, not JO<O).
 */
export const machineLine = (label: string, subject: string) =>
  `ID<GHOSTLY<<${label}<<${subject}`.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase()
    .replace(/[^A-Z0-9<]+/g, "<").padEnd(44, "<").slice(0, 44);

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
