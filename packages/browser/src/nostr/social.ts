import { npubEncode, decode as nip19Decode } from "nostr-tools/nip19";
import { byNewest, type NostrEvent } from "./relay";

/**
 * The Nostr social layer's data, parsed from signed events into bounded plain values: a profile (kind 0),
 * a follow list (kind 3), notes (kind 1) and a mute list (kind 10000). Everything here is
 * self-described by the key that signed it; nothing is inferred. Text is plain text: controls and
 * bidirectional overrides removed, lengths capped, never rendered as markup. Pictures are only URLs here;
 * `profiles/public.ts` turns one into a small re-encoded JPEG from fixed hosts.
 */

export const KIND_PROFILE = 0;
export const KIND_NOTE = 1;
export const KIND_FOLLOWS = 3;
export const KIND_MUTE = 10_000;

export const MAX_NOTE_LENGTH = 4_000;
export const MAX_ABOUT_LENGTH = 500;
export const MAX_PROFILE_CONTENT = 8 * 1024;
export const MAX_FOLLOWS = 2_000;
export const MAX_NOTES_KEPT = 200;
export const NOTES_PAGE = 20;
/** After this, a cached profile or list is shown as stale and offered a refresh. */
export const STALE_AFTER_SECONDS = 24 * 60 * 60;

const HEX64 = /^[a-f0-9]{64}$/;

// eslint-disable-next-line no-control-regex -- strip control and bidi-override characters from relay-supplied text
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** Longest string looked at before it is cut: a relay's frame is capped at 64 KiB anyway. */
const MAX_TEXT_INPUT = 64 * 1024;

/** Plain text: no controls (newlines kept when `multiline`), no bidi overrides, trimmed, capped. */
export function plainText(value: unknown, max: number, multiline = false): string | undefined {
  if (typeof value !== "string" || value.length > MAX_TEXT_INPUT) return;
  let text = value.replace(UNSAFE, "");
  if (!multiline) text = text.replace(/[\r\n\t]+/g, " ");
  text = text.trim();
  if (text.length > max) text = text.slice(0, max);
  return text || undefined;
}

/** An https URL for a website or a picture, or nothing: never javascript:, data:, or a host with credentials. */
export function httpsUrl(value: unknown, max = 512): string | undefined {
  if (typeof value !== "string" || value.length > max) return;
  try { const u = new URL(value); if (u.protocol !== "https:" || u.username || u.password) return; return u.href; } catch { return; }
}

/** A NIP-05 identifier as typed by its owner: `name@domain`, ASCII, no proof that it resolves. */
export function nip05Text(value: unknown): string | undefined {
  const text = plainText(value, 253);
  return text && /^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(text) ? text.toLowerCase() : undefined;
}

export interface NostrProfile {
  /** `display_name`, or `name` when there is none. */
  name?: string;
  /** The `name` handle, when it differs from what is shown. */
  handle?: string;
  about?: string;
  /** The picture URL as published; only `profiles/public.ts` may fetch it. */
  picture?: string;
  nip05?: string;
  website?: string;
  eventId: string;
  eventAt: number;
}

/** Parses a kind-0 event by exactly `pubkey`. The event must already be signature-checked. */
export function parseProfile(event: NostrEvent, pubkey: string): NostrProfile | undefined {
  if (event.kind !== KIND_PROFILE || event.pubkey !== pubkey || event.content.length > MAX_PROFILE_CONTENT) return;
  let data: Record<string, unknown>;
  try { data = JSON.parse(event.content); } catch { return; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const handle = plainText(data.name, 64);
  const display = plainText(data.display_name, 64) ?? plainText(data.displayName, 64);
  const profile: NostrProfile = { eventId: event.id, eventAt: event.created_at };
  const name = display ?? handle;
  if (name) profile.name = name;
  if (handle && handle !== name) profile.handle = handle;
  const about = plainText(data.about, MAX_ABOUT_LENGTH, true);
  if (about) profile.about = about;
  const picture = httpsUrl(data.picture, 2048);
  if (picture) profile.picture = picture;
  const nip05 = nip05Text(data.nip05);
  if (nip05) profile.nip05 = nip05;
  const website = httpsUrl(data.website);
  if (website) profile.website = website;
  return profile;
}

export interface NostrFollows {
  /** Followed public keys, hex, in the event's order, deduplicated. */
  follows: string[];
  eventId: string;
  eventAt: number;
}

/** Parses a kind-3 event by exactly `pubkey`: its `p` tags. Relay hints and petnames are ignored. */
export function parseFollows(event: NostrEvent, pubkey: string): NostrFollows | undefined {
  if (event.kind !== KIND_FOLLOWS || event.pubkey !== pubkey) return;
  const follows: string[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] !== "p" || typeof tag[1] !== "string") continue;
    const key = tag[1].toLowerCase();
    if (!HEX64.test(key) || seen.has(key)) continue;
    seen.add(key);
    follows.push(key);
    if (follows.length >= MAX_FOLLOWS) break;
  }
  return { follows, eventId: event.id, eventAt: event.created_at };
}

export interface NostrNote {
  id: string;
  createdAt: number;
  content: string;
  /** The note answers another note (an `e` tag). */
  reply: boolean;
  /** Public keys the note mentions (`p` tags), for the mute list. */
  mentions: string[];
}

/** Parses a kind-1 event by exactly `pubkey`. Content is plain text, capped. */
export function parseNote(event: NostrEvent, pubkey: string): NostrNote | undefined {
  if (event.kind !== KIND_NOTE || event.pubkey !== pubkey) return;
  const content = plainText(event.content, MAX_NOTE_LENGTH, true);
  if (!content) return;
  const mentions = [...new Set(event.tags.filter(t => t[0] === "p" && typeof t[1] === "string" && HEX64.test(t[1])).map(t => t[1]))].slice(0, 50);
  return { id: event.id, createdAt: event.created_at, content, reply: event.tags.some(t => t[0] === "e"), mentions };
}

export interface NostrMuteList {
  pubkeys: string[];
  eventIds: string[];
  /** Lowercased. */
  words: string[];
  eventId: string;
  eventAt: number;
  /** The event also carries an encrypted private part, which is not read (that needs the signer). */
  hasPrivate: boolean;
}

/** Parses a kind-10000 event by exactly `pubkey`: its public `p`, `e` and `word` tags. */
export function parseMuteList(event: NostrEvent, pubkey: string): NostrMuteList | undefined {
  if (event.kind !== KIND_MUTE || event.pubkey !== pubkey) return;
  const pubkeys = new Set<string>(), eventIds = new Set<string>(), words = new Set<string>();
  for (const tag of event.tags) {
    if (typeof tag[1] !== "string") continue;
    if (tag[0] === "p" && HEX64.test(tag[1])) pubkeys.add(tag[1]);
    else if (tag[0] === "e" && HEX64.test(tag[1])) eventIds.add(tag[1]);
    else if (tag[0] === "word") { const w = plainText(tag[1], 64)?.toLowerCase(); if (w) words.add(w); }
  }
  return { pubkeys: [...pubkeys].slice(0, MAX_FOLLOWS), eventIds: [...eventIds].slice(0, MAX_FOLLOWS), words: [...words].slice(0, 500), eventId: event.id, eventAt: event.created_at, hasPrivate: event.content.length > 0 };
}

/** Why a note is hidden by the person's own mute list, or nothing when it is not. */
export function mutedBecause(note: NostrNote, author: string, mute: NostrMuteList | undefined): "author" | "mention" | "note" | "word" | undefined {
  if (!mute) return;
  if (mute.pubkeys.includes(author)) return "author";
  if (mute.eventIds.includes(note.id)) return "note";
  if (note.mentions.some(m => mute.pubkeys.includes(m))) return "mention";
  const text = note.content.toLowerCase();
  if (mute.words.some(w => text.includes(w))) return "word";
  return;
}

/** The newest event of `kind` by `pubkey` among `events` (replaceable kinds: newest wins, smaller id on a tie). */
export function newestOf(events: readonly NostrEvent[], kind: number, pubkey: string): NostrEvent | undefined {
  return events.filter(e => e.kind === kind && e.pubkey === pubkey).sort(byNewest)[0];
}

/** What two follow lists say about each other. Every hint names its direction; none implies trust. */
export interface FollowHints {
  /** The contact's list names one of the person's keys. */
  followsYou: boolean;
  /** The person's list names the contact. */
  youFollow: boolean;
  /** Keys on both lists. */
  mutual: string[];
}
export function followHints(theirs: readonly string[], mine: readonly string[], myKeys: readonly string[], theirKey: string): FollowHints {
  const mineSet = new Set(mine);
  return { followsYou: myKeys.some(k => theirs.includes(k)), youFollow: mineSet.has(theirKey), mutual: theirs.filter(k => mineSet.has(k) && k !== theirKey && !myKeys.includes(k)) };
}

export const npub = (hex: string) => { try { return npubEncode(hex); } catch { return hex; } };
export const shortNpub = (hex: string) => { const n = npub(hex); return n.startsWith("npub1") ? `${n.slice(0, 12)}…${n.slice(-4)}` : n; };

/** What a NIP-19 code in a message points at: a key (`npub`, `nprofile`) or a note (`note`, `nevent`). */
export type NostrPointer =
  | { type: "profile"; pubkey: string; relays: string[] }
  | { type: "note"; id: string; author?: string; relays: string[] };

/**
 * Decodes an `npub`, `nprofile`, `note` or `nevent` (a `nostr:` prefix allowed), checksum and all; undefined for
 * anything else. Relay hints are returned as written: the social layer never asks them (see `relay.ts`).
 */
export function nostrPointer(input: string): NostrPointer | undefined {
  const code = input.trim().replace(/^nostr:/i, "").toLowerCase();
  if (!/^(npub|nprofile|note|nevent)1/.test(code) || code.length > 1_000) return undefined;
  try {
    const d = nip19Decode(code);
    const hints = (r: unknown) => (Array.isArray(r) ? r.filter((x): x is string => typeof x === "string").slice(0, 8) : []);
    if (d.type === "npub" && HEX64.test(d.data)) return { type: "profile", pubkey: d.data, relays: [] };
    if (d.type === "nprofile" && HEX64.test(d.data.pubkey)) return { type: "profile", pubkey: d.data.pubkey, relays: hints(d.data.relays) };
    if (d.type === "note" && HEX64.test(d.data)) return { type: "note", id: d.data, relays: [] };
    if (d.type === "nevent" && HEX64.test(d.data.id)) {
      const author = d.data.author && HEX64.test(d.data.author) ? d.data.author : undefined;
      return { type: "note", id: d.data.id, ...(author ? { author } : {}), relays: hints(d.data.relays) };
    }
  } catch { /* not a valid code */ }
  return undefined;
}

/** A public key the person typed: npub or hex → hex. */
export function normalizePubkey(input: string): string {
  const value = input.trim();
  if (HEX64.test(value.toLowerCase())) return value.toLowerCase();
  if (value.startsWith("npub1")) {
    try { const d = nip19Decode(value); if (d.type === "npub") return d.data; } catch { /* fall through */ }
  }
  throw new Error("Enter a Nostr public key: npub1… or 64 hex characters");
}

// ---------------------------------------------------------------------------------------------
// Publication: the unsigned events. The engine builds them; the person's own signer signs them.

export interface EventTemplate { kind: number; created_at: number; tags: string[][]; content: string }

/** A note: plain text, capped, no tags (no reply, no mention: those come later, if ever). */
export function noteTemplate(content: string, now: number): EventTemplate {
  const text = plainText(content, MAX_NOTE_LENGTH, true);
  if (!text) throw new Error("Write something to post");
  if (content.trim().length > MAX_NOTE_LENGTH) throw new Error(`A note is at most ${MAX_NOTE_LENGTH} characters`);
  return { kind: KIND_NOTE, created_at: now, tags: [], content: text };
}

/**
 * The follow list with one key added or removed. Built from the current event so every other tag (and the
 * legacy relay list in `content`) travels unchanged: a kind-3 replaces the whole list on every relay, and
 * publishing a shorter one would silently unfollow everybody else.
 */
export function followsTemplate(current: NostrEvent | undefined, target: string, follow: boolean, now: number): EventTemplate {
  const tags = current ? current.tags.map(t => [...t]) : [];
  const has = tags.some(t => t[0] === "p" && t[1]?.toLowerCase() === target);
  if (follow && has) throw new Error("Already followed");
  if (!follow && !has) throw new Error("Not followed");
  const next = follow ? [...tags, ["p", target]] : tags.filter(t => !(t[0] === "p" && t[1]?.toLowerCase() === target));
  if (follow && next.filter(t => t[0] === "p").length > MAX_FOLLOWS) throw new Error(`At most ${MAX_FOLLOWS} follows`);
  return { kind: KIND_FOLLOWS, created_at: now, tags: next, content: current?.content ?? "" };
}

export interface ProfileFields { name?: string; displayName?: string; about?: string; picture?: string; nip05?: string; website?: string }

/**
 * The profile with some fields changed. Built from the current kind-0 content so fields Ghostly does not
 * know (lud16, banner, …) stay as they are; an empty string removes a field.
 */
export function profileTemplate(current: NostrEvent | undefined, fields: ProfileFields, now: number): EventTemplate {
  let data: Record<string, unknown> = {};
  if (current) { try { const parsed = JSON.parse(current.content); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed; } catch { /* a fresh profile */ } }
  const set = (key: string, value: string | undefined, check: (v: string) => string | undefined, what: string) => {
    if (value === undefined) return;
    if (value === "") { delete data[key]; return; }
    const clean = check(value);
    if (!clean) throw new Error(`${what} is not valid`);
    data[key] = clean;
  };
  set("name", fields.name, v => plainText(v, 64), "The handle");
  set("display_name", fields.displayName, v => plainText(v, 64), "The name");
  set("about", fields.about, v => plainText(v, MAX_ABOUT_LENGTH, true), "The bio");
  set("picture", fields.picture, v => httpsUrl(v, 2048), "The picture address (https://…)");
  set("nip05", fields.nip05, nip05Text, "The NIP-05 address (name@domain)");
  set("website", fields.website, v => httpsUrl(v), "The website (https://…)");
  const content = JSON.stringify(data);
  if (content.length > MAX_PROFILE_CONTENT) throw new Error("The profile is too long");
  return { kind: KIND_PROFILE, created_at: now, tags: current ? current.tags.map(t => [...t]) : [], content };
}
