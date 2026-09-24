import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, fromBase64Url, randomBytes, toBase64Url, utf8Decode, utf8Encode } from "./bytes";
import { edgeParams } from "./groupCrypto";
import { GROUP_ID, MEMBER_KEY } from "./groupCommits";
import { identityFromSeed, publicKeyFromZ32, type Identity } from "./identity";
import type { LinkParams } from "./invite";
import type { GhostRecord } from "./pkarr";

/**
 * A group's public entry link (`group-entry/1`, WISP 9xx § Entry link): one
 * address the admin can hand to anyone, so people who are not their contacts
 * can join, without a contact chat and without saying who they are.
 *
 * The link names the group and an **entry key** of the admin's, made for the
 * link and nothing else. From those two, everyone holding the link derives
 * the same **knock identity**: a Pkarr key whose seed is known to every
 * holder, where a joiner leaves its fresh member key. The admin's app reads
 * it; for every knock it opens an **entry session**, a paired link derived like
 * a group edge from the entry key and the joiner's member key and pinned to
 * both, and runs the ordinary admission over it (invite, accept, welcome).
 * The joiner's trust anchor is the entry key the link named: whoever holds
 * its seed is the admin who must admit it.
 *
 * A link is a bearer capability. Anyone who has it can join while it is on;
 * the admin turns it off, or replaces it, and the old one stops working.
 */
export const GROUP_ENTRY_PROFILE = "group-entry/1" as const;
const PREFIX = "group1";
/** A knock older than this is not answered: the joiner republishes while it waits. */
export const KNOCK_TTL_MS = 3 * 60_000;
/** Knocks a record keeps: joiners share one Pkarr packet, so it holds the latest few. */
export const MAX_KNOCKS = 6;
const KNOCK_LABEL = "_knock";
const NONCE_LENGTH = 24;

export interface GroupEntryLink {
  /** The group id. */
  g: string;
  /** The admin's entry key (z-base-32 Ed25519), made for this link. */
  host: string;
}

export interface Knock {
  /** The joiner's member key for this group. */
  key: string;
  /** When the joiner last said it is waiting (ms). */
  ts: number;
}

const info = (label: string) => utf8Encode(`ghostly-group-entry/1 ${label}`);

/** `group1/<group id>/<entry key>` */
export function encodeGroupEntryLink(link: GroupEntryLink): string {
  return `${PREFIX}/${link.g}/${link.host}`;
}

/** Where the link opens the web app: its join route. */
export function groupEntryUrl(origin: string, link: GroupEntryLink): string {
  return `${origin.replace(/\/+$/, "")}/#/join/${encodeGroupEntryLink(link)}`;
}

/** A pasted link, a `/join/…` path or the bare code; null when it is none of them. */
export function decodeGroupEntryLink(input: string): GroupEntryLink | null {
  const clean = input.trim().replace(/^.*#/, "").replace(/^.*?\/join\//, "").replace(/^\/+/, "");
  const parts = clean.split("/");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, g, host] = parts;
  if (!GROUP_ID.test(g) || !MEMBER_KEY.test(host)) return null;
  try { publicKeyFromZ32(host); } catch { return null; }
  return { g, host };
}

function knockMaterial(link: GroupEntryLink, label: string): Uint8Array {
  return hkdf(sha256, publicKeyFromZ32(link.host), utf8Encode(link.g), info(label), 32);
}

/** The Pkarr identity every holder of the link can publish knocks under. */
export function knockIdentity(link: GroupEntryLink): Identity {
  return identityFromSeed(knockMaterial(link, "knock seed"));
}

/**
 * The knocks under the knock identity, sealed with a key from the link: a
 * relay sees an opaque value on a key it cannot tie to the group.
 */
export function knockRecords(link: GroupEntryLink, knocks: Knock[]): GhostRecord[] {
  const nonce = randomBytes(NONCE_LENGTH);
  const body = utf8Encode(JSON.stringify(knocks.slice(-MAX_KNOCKS).map(k => [k.key, k.ts])));
  const box = xchacha20poly1305(knockMaterial(link, "knock key"), nonce, utf8Encode(link.g)).encrypt(body);
  return [{ label: KNOCK_LABEL, value: toBase64Url(concatBytes(nonce, box)) }];
}

/** Knocks that open with the link's key and are well formed; anything else is nobody. */
export function readKnocks(link: GroupEntryLink, records: GhostRecord[]): Knock[] {
  const value = records.find(r => r.label === KNOCK_LABEL)?.value;
  if (!value || value.length > 900) return [];
  try {
    const bytes = fromBase64Url(value);
    const body = xchacha20poly1305(knockMaterial(link, "knock key"), bytes.slice(0, NONCE_LENGTH), utf8Encode(link.g)).decrypt(bytes.slice(NONCE_LENGTH));
    const parsed: unknown = JSON.parse(utf8Decode(body));
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_KNOCKS).flatMap(entry => Array.isArray(entry) && typeof entry[0] === "string" && MEMBER_KEY.test(entry[0]) && Number.isSafeInteger(entry[1])
      ? [{ key: entry[0], ts: entry[1] as number }] : []);
  } catch { return []; }
}

/** The knocks to publish: mine refreshed, others' still fresh, newest last, at most `MAX_KNOCKS`. */
export function mergeKnocks(existing: Knock[], mine: Knock, now = Date.now()): Knock[] {
  const fresh = existing.filter(k => k.key !== mine.key && now - k.ts < KNOCK_TTL_MS && k.ts <= now + 60_000);
  return [...fresh.sort((a, b) => a.ts - b.ts).slice(-(MAX_KNOCKS - 1)), mine];
}

/**
 * The entry session between the admin's entry key and a joiner's member key:
 * the same derivation as a group edge, under a salt of its own, so it can
 * never be confused with an edge of the same group.
 */
export function entryParams(link: GroupEntryLink, mySeed: Uint8Array, myZ32: string, peerZ32: string): LinkParams {
  return edgeParams(`entry/${link.g}`, mySeed, myZ32, peerZ32);
}
