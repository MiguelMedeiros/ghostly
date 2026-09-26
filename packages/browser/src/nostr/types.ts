import type { NostrEvent } from "./relay";
import type { NostrFollows, NostrMuteList, NostrNote, NostrProfile } from "./social";

/**
 * The Nostr social layer: settings, what is cached, and what the UI sees. Each layer is a separate,
 * separately permitted capability (proof ≠ profile ≠ graph ≠ content ≠ publication): a proof shared in a
 * chat lets the contact *ask* for the profile; nothing is fetched or published without the person's
 * action or an explicit setting.
 */

export interface NostrSocialSettings {
  /** Relays asked for profiles, follows and notes, and sent what the person publishes. They learn the person's IP address and what was looked up. */
  relays: string[];
  /** Load a contact's profile as soon as their Nostr proof is verified, and refresh a stale one when the chat opens. Off: only on "Load profile". */
  autoLoadProfiles: boolean;
  /** Publication capability: post notes, follow/unfollow, update the profile — through the person's own signer, each action confirmed. Off by default. */
  publish: boolean;
}

/** Where a cached value came from and when. */
export interface Fetched {
  /** Seconds. */
  fetchedAt: number;
  /** The relays that answered. */
  relays: string[];
}

/** A contact's Nostr data, cached per chat under their proven key. */
export interface NostrContactCache {
  subject: string;
  profile?: Fetched & { profile?: NostrProfile; avatar?: string };
  follows?: Fetched & NostrFollows;
  notes?: Fetched & { notes: NostrNote[]; exhausted: boolean };
}

/** The person's own Nostr data, cached per key they proved. Kept as events so a new version can be built on the current one. */
export interface NostrOwnCache {
  subject: string;
  profile?: Fetched & { event?: NostrEvent; profile?: NostrProfile; avatar?: string };
  follows?: Fetched & { event?: NostrEvent; follows: string[] };
  mute?: Fetched & { event?: NostrEvent; list?: NostrMuteList };
}

export interface NostrProfileView {
  name?: string;
  handle?: string;
  about?: string;
  nip05?: string;
  website?: string;
  /** Re-encoded small JPEG, when the picture came from a known host and decoded. */
  avatar?: string;
  /** Whether a picture was published at all (it may be from a host Ghostly does not fetch). */
  hasPicture: boolean;
  /** The kind-0 event's time (when they last changed it) and id. */
  eventAt: number;
  eventId: string;
}

export interface NostrNoteView {
  id: string;
  createdAt: number;
  content: string;
  reply: boolean;
}

export interface NostrContactView {
  subject: string;
  npub: string;
  profile?: Fetched & { stale: boolean; found: boolean; profile?: NostrProfileView };
  follows?: Fetched & {
    stale: boolean;
    count: number;
    eventAt: number;
    /** Hints against the person's own lists; absent when none of their own lists is loaded. */
    hints?: { followsYou: boolean; youFollow: boolean; mutual: number; /** The person's key the hints are against. */ myKey: string; myFollowsAt: number };
  };
  notes?: Fetched & {
    notes: NostrNoteView[];
    /** More can be loaded (the last page was full). */
    more: boolean;
    /** Notes hidden by the person's own mute list, and whether the whole author is muted. */
    hidden: number;
    authorMuted: boolean;
  };
  loading?: "profile" | "follows" | "notes";
  error?: string;
}

export interface NostrOwnView {
  subject: string;
  npub: string;
  profile?: Fetched & { stale: boolean; found: boolean; profile?: NostrProfileView };
  follows?: Fetched & { stale: boolean; follows: string[]; eventAt: number };
  mute?: Fetched & { pubkeys: number; words: number; notes: number; hasPrivate: boolean };
  loading?: boolean;
  error?: string;
}

export interface NostrSocialState {
  /** The person's keys with a Nostr proof, and what is cached for each. */
  own: NostrOwnView[];
  /** Effective settings (defaults filled in). */
  settings: NostrSocialSettings;
}

/** What the engine built for the person to sign: shown, confirmed, then signed by their own signer. */
export interface NostrDraft {
  draftId: string;
  subject: string;
  template: { kind: number; created_at: number; tags: string[][]; content: string };
  /** A sentence for the confirmation: what becomes public and where. */
  notice: string;
  /** For people: "Post a note", "Follow npub1…", "Update your profile". */
  summary: string;
  relays: string[];
}

export type NostrDraftRequest =
  | { subject: string; action: "note"; content: string }
  | { subject: string; action: "follow" | "unfollow"; target: string }
  | { subject: string; action: "profile"; fields: { name?: string; displayName?: string; about?: string; picture?: string; nip05?: string; website?: string } };

export interface NostrPublishResult { accepted: string[]; rejected: { relay: string; reason: string }[] }

/** A key or a note named in a message, looked up on the person's tap (`nostrLookup`). */
export type NostrLookupRequest = { type: "profile"; pubkey: string } | { type: "note"; id: string; author?: string };

/** What the person's relays hold for a `NostrLookupRequest`, returned and never stored. */
export interface NostrLookupResult {
  fetchedAt: number;
  /** The relays that answered. */
  relays: string[];
  found: boolean;
  profile?: NostrProfileView;
  /** A note hidden by the person's own mute list comes back `muted`, with no text. */
  note?: NostrNoteView & { author: string; muted?: boolean };
}
