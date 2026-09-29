import type { ReceivedIdentityView } from "@ghostly/browser/shared/types";
import { providerIcon } from "./ProviderIcons";
import { currentStatus, expiringSoon, providerLabel, shortSubject, useEngineState } from "../../lib/identities";

/**
 * A contact's identities as small marks: beside their name in the chat list and a group's member list (verified only,
 * at most two), and as a stack in the chat's header (every state). One order and one set of states for all of them.
 */

/**
 * Which marks come first: the ones people recognise at a glance. A domain, then a GitHub or GitLab account (by the SSH
 * keys it lists), then an account at a sign-in provider (Google, Apple, Microsoft, GitLab, Twitch), then a Nostr key,
 * an OpenPGP key, a bare SSH key and a Bitcoin address. Keys are ProviderIcons.tsx's: `oidc:*` is any known account.
 * Anything else comes last. Within a rank the contact's own order stays.
 */
export const BADGE_ORDER = ["domain", "ssh-github", "ssh-gitlab", "oidc:*", "nostr", "openpgp", "ssh", "bitcoin"] as const;

/** Where a proof sorts in BADGE_ORDER; GitHub and GitLab share a rank, and so does every account at a provider. */
export function badgeRank(provider: string, subject?: string): number {
  const key = providerIcon(provider, subject)?.key ?? provider;
  const at = (k: (typeof BADGE_ORDER)[number]) => BADGE_ORDER.indexOf(k);
  if (key === "ssh-gitlab") return at("ssh-github");
  if (key === "oidc" || key.startsWith("oidc:")) return at("oidc:*");
  const i = (BADGE_ORDER as readonly string[]).indexOf(key);
  return i < 0 ? BADGE_ORDER.length : i;
}

/**
 * A mark's state, the same everywhere: `verified` in its provider's colour, `expiring` (its last days) with a small
 * clock, `revoked` (its owner published a revocation) greyed and struck through, `failed` (a check could not confirm
 * it) with an amber dot, `expired` greyed. A proof no longer shared, or made with a previous key, has no mark.
 */
export type BadgeState = "verified" | "expiring" | "revoked" | "failed" | "expired";

export function badgeState(r: ReceivedIdentityView, now = Date.now() / 1000): BadgeState | undefined {
  const status = currentStatus(r, now);
  if (status === "verified") return expiringSoon({ issuedAt: r.verifiedAt, expiresAt: r.expiresAt }, now) ? "expiring" : "verified";
  if (status === "unconfirmed") return "failed";
  if (status === "revoked" || status === "expired") return status;
  return undefined;
}

/** Still vouched for: shown in colour, and counted by the chat list. */
export const isGood = (state: BadgeState) => state === "verified" || state === "expiring";

export interface Badge {
  id: string;
  provider: string;
  subject: string;
  state: BadgeState;
  /** "GitHub: mmedeiros · verified 2 h ago": what the mark is, for a tooltip and a screen reader. */
  label: string;
  /** The identity's public profile picture (a sanitized data URL), while the proof still vouches for it: the header's mark wears it. */
  photo?: string;
  /** For the mark's card (IdentityTip.tsx): "GitHub (SSH key)", the subject shortened, and the state in words. */
  providerName: string;
  short: string;
  stateText: string;
  /** From its public profile, while the proof vouches for it: its name, handle and the hosts it was read from. */
  name?: string;
  handle?: string;
  hosts?: string[];
}

/** "2 h ago", "3 days ago", "in 3 days", in the interface's language. */
export function ago(seconds: number, now = Date.now() / 1000, language?: string): string {
  const d = seconds - now, abs = Math.abs(d);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
  if (abs < 60) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(d / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(d / 3600), "hour");
  return rtf.format(Math.round(d / 86400), "day");
}

const STATE_WORDS: Record<BadgeState, (r: ReceivedIdentityView, now: number) => string> = {
  verified: (r, now) => `verified ${ago(r.checkedAt, now)}`,
  expiring: (r, now) => `verified ${ago(r.checkedAt, now)}, expires ${ago(r.expiresAt, now)}`,
  revoked: (r, now) => `revoked by its owner, seen ${ago(r.checkedAt, now)}`,
  failed: (r, now) => `check failed ${ago(r.checkedAt, now)}`,
  expired: (r, now) => `expired ${ago(r.expiresAt, now)}`,
};

/**
 * A contact's identities as marks, the ones that have one, in BADGE_ORDER; with `good`, only those still vouched for
 * (verified or expiring). Among equals, good before the rest.
 */
export function contactBadges(received: ReceivedIdentityView[] | undefined, { good = false, now = Date.now() / 1000 } = {}): Badge[] {
  const badges: (Badge & { rank: number; i: number })[] = [];
  (received ?? []).forEach((r, i) => {
    const state = badgeState(r, now);
    if (!state || (good && !isGood(state))) return;
    // A public profile's name, while the proof still vouches for it: "Nostr: npub1…yz (Alice) · verified 2 h ago".
    const profile = isGood(state) && r.publicProfile?.found ? r.publicProfile : undefined;
    const providerName = providerLabel(r.provider), short = shortSubject(r.provider, r.verified.subject), stateText = STATE_WORDS[state](r, now);
    const label = `${providerName}: ${short}${profile?.name ? ` (${profile.name})` : ""} · ${stateText}`;
    const photo = profile?.avatar?.startsWith("data:image/") ? profile.avatar : undefined;
    const about = profile ? { ...(profile.name ? { name: profile.name } : {}), ...(profile.handle ? { handle: profile.handle } : {}), ...(profile.hosts?.length ? { hosts: profile.hosts } : {}) } : {};
    badges.push({ id: r.id, provider: r.provider, subject: r.subject, state, label, providerName, short, stateText, ...about, ...(photo ? { photo } : {}), rank: badgeRank(r.provider, r.subject), i });
  });
  return badges
    .sort((a, b) => Number(isGood(b.state)) - Number(isGood(a.state)) || a.rank - b.rank || a.i - b.i)
    .map(({ rank: _rank, i: _i, ...badge }) => badge);
}

/** The first `limit` marks and how many more there are, for the "+N" chip. */
export function takeBadges<T>(badges: T[], limit: number): { shown: T[]; more: number } {
  const n = Math.max(0, Math.min(limit, badges.length));
  return { shown: badges.slice(0, n), more: badges.length - n };
}

/** How many marks each place shows: the chat list and member lists, and the header by its width. */
export const BADGE_LIMITS = { row: 2, rowNarrow: 1, header: 3, headerNarrow: 2, headerPhone: 1 } as const;

/** A contact's received identities, from the engine's state: the chat's link with this contact key. */
export const useReceived = (peerKey: string | undefined) =>
  useEngineState()?.links.find(l => l.peerPubKeyZ32 === peerKey)?.identities?.received;
