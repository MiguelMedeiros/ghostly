import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, fromBase64Url, randomBytes, toBase64Url, toZ32, utf8Encode } from "./bytes";
import { identityFromSeed, publicKeyFromZ32, type Identity } from "./identity";
import type { GhostRecord } from "./pkarr";

/**
 * Where the members of a `group-community/1` group find each other (WISP 9xx · Group Community §
 * Topology): a **beacon** listing the current hubs, and a **lobby** per hub where a member asks
 * that hub for an edge. Both are Pkarr records under identities every member derives from the
 * group's rendezvous secret, sealed with a key from the same secret: relays see a key and an
 * opaque value. Several members write the same record, so a writer reads, merges and publishes.
 */
export const COMMUNITY_TOPOLOGY = {
  /** Hubs listed in the beacon, at most. */
  maxHubs: 8,
  /** Hubs wanted before a member settles for being a member. */
  minHubs: 2,
  /** Members one hub keeps edges with. */
  hubCapacity: 48,
  /** Hubs a member connects to: one; if it goes, the member asks another and a sync fills the gap. */
  hubsPerMember: 1,
  /** A hub republishes its beacon entry this often… */
  beaconEveryMs: 30_000,
  /** …and an entry older than this is stale. */
  beaconFreshMs: 90_000,
  /** Lobby entries: at most this many, fresh this long. */
  lobbyEntries: 6,
  lobbyFreshMs: 2 * 60_000,
} as const;

const NONCE_LENGTH = 24;
const BEACON_LABEL = "_hubs";
const LOBBY_LABEL = "_lobby";
const info = (label: string) => utf8Encode(`ghostly-group-community/1 ${label}`);

/** A hub as the beacon lists it: when it last said so (`ts`), since when it is a hub, and how many members it holds. */
export interface Hub { key: string; ts: number; load: number; since?: number }
export interface LobbyEntry { key: string; ts: number }

function material(rv: Uint8Array, salt: Uint8Array, label: string): Uint8Array {
  return hkdf(sha256, rv, salt, info(label), 32);
}

/** The beacon's Pkarr identity and sealing key, for a group. */
export function beaconKeys(rvB64: string, groupId: string): { identity: Identity; key: Uint8Array; aad: Uint8Array } {
  const rv = fromBase64Url(rvB64), salt = utf8Encode(groupId);
  return { identity: identityFromSeed(material(rv, salt, "beacon seed")), key: material(rv, salt, "beacon key"), aad: utf8Encode(`beacon/${groupId}`) };
}

/** A hub's lobby: its Pkarr identity and sealing key. */
export function lobbyKeys(rvB64: string, groupId: string, hubKey: string): { identity: Identity; key: Uint8Array; aad: Uint8Array } {
  const rv = fromBase64Url(rvB64), salt = concatBytes(utf8Encode(groupId), publicKeyFromZ32(hubKey));
  return { identity: identityFromSeed(material(rv, salt, "lobby seed")), key: material(rv, salt, "lobby key"), aad: utf8Encode(`lobby/${groupId}/${hubKey}`) };
}

function seal(label: string, keys: { key: Uint8Array; aad: Uint8Array }, body: Uint8Array): GhostRecord[] {
  const nonce = randomBytes(NONCE_LENGTH);
  return [{ label, value: toBase64Url(concatBytes(nonce, xchacha20poly1305(keys.key, nonce, keys.aad).encrypt(body))) }];
}
function open(label: string, keys: { key: Uint8Array; aad: Uint8Array }, records: GhostRecord[]): Uint8Array | null {
  const value = records.find(r => r.label === label)?.value;
  if (!value || value.length > 900) return null;
  try {
    const bytes = fromBase64Url(value);
    return xchacha20poly1305(keys.key, bytes.slice(0, NONCE_LENGTH), keys.aad).decrypt(bytes.slice(NONCE_LENGTH));
  } catch { return null; }
}

/** 32-byte key, 4-byte time in seconds, then (beacon) one byte of load and 4 bytes of since (seconds). */
function pack(entries: { key: string; ts: number; load?: number; since?: number }[], withLoad: boolean): Uint8Array {
  const size = 36 + (withLoad ? 5 : 0), out = new Uint8Array(entries.length * size), view = new DataView(out.buffer);
  entries.forEach((entry, i) => {
    out.set(publicKeyFromZ32(entry.key), i * size);
    view.setUint32(i * size + 32, Math.floor(entry.ts / 1000));
    if (withLoad) {
      out[i * size + 36] = Math.max(0, Math.min(255, entry.load ?? 0));
      view.setUint32(i * size + 37, Math.floor((entry.since ?? entry.ts) / 1000));
    }
  });
  return out;
}
function unpack(bytes: Uint8Array, withLoad: boolean, max: number): Hub[] {
  const size = 36 + (withLoad ? 5 : 0);
  if (bytes.length % size !== 0) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out: Hub[] = [];
  for (let i = 0; i < bytes.length / size && out.length < max; i++) {
    try {
      const key = toZ32(bytes.slice(i * size, i * size + 32));
      publicKeyFromZ32(key);
      const ts = view.getUint32(i * size + 32) * 1000;
      out.push(withLoad ? { key, ts, load: bytes[i * size + 36], since: view.getUint32(i * size + 37) * 1000 } : { key, ts, load: 0 });
    } catch { /* not a key: skipped */ }
  }
  return out;
}

/**
 * The hubs that take turns at the door (WISP 9xx § Admission): those that said so lately and have
 * been hubs for a minute, so that every hub, having read the beacon at least once since, agrees on
 * the same set. Only when there is none, every hub that said so lately.
 */
export function doorHubs(hubs: Hub[], now = Date.now()): string[] {
  const lately = hubs.filter(h => now - h.ts < COMMUNITY_TOPOLOGY.beaconEveryMs * 1.5);
  const settled = lately.filter(h => now - (h.since ?? h.ts) >= 60_000);
  return (settled.length ? settled : lately).map(h => h.key);
}

export function beaconRecords(keys: { key: Uint8Array; aad: Uint8Array }, hubs: Hub[]): GhostRecord[] {
  return seal(BEACON_LABEL, keys, pack(hubs.slice(0, COMMUNITY_TOPOLOGY.maxHubs), true));
}
export function readBeacon(keys: { key: Uint8Array; aad: Uint8Array }, records: GhostRecord[]): Hub[] {
  const body = open(BEACON_LABEL, keys, records);
  return body ? unpack(body, true, COMMUNITY_TOPOLOGY.maxHubs) : [];
}
export function lobbyRecords(keys: { key: Uint8Array; aad: Uint8Array }, entries: LobbyEntry[]): GhostRecord[] {
  return seal(LOBBY_LABEL, keys, pack(entries.slice(-COMMUNITY_TOPOLOGY.lobbyEntries), false));
}
export function readLobby(keys: { key: Uint8Array; aad: Uint8Array }, records: GhostRecord[]): LobbyEntry[] {
  const body = open(LOBBY_LABEL, keys, records);
  return body ? unpack(body, false, COMMUNITY_TOPOLOGY.lobbyEntries).map(({ key, ts }) => ({ key, ts })) : [];
}

/**
 * The beacon to publish: my entry (or none, `mine` null, when I step down) with the other fresh
 * hubs, newest first, at most `maxHubs`. A hub not in the roster any more is dropped.
 */
export function mergeBeacon(existing: Hub[], me: string, mine: Hub | null, now = Date.now(), isMember: (key: string) => boolean = () => true): Hub[] {
  const fresh = existing.filter(h => h.key !== me && now - h.ts < COMMUNITY_TOPOLOGY.beaconFreshMs && h.ts <= now + 60_000 && isMember(h.key));
  const all = mine ? [mine, ...fresh] : fresh;
  return all.sort((a, b) => b.ts - a.ts).slice(0, COMMUNITY_TOPOLOGY.maxHubs);
}

/** The lobby to publish: my request refreshed, others' still fresh, newest last. */
export function mergeLobby(existing: LobbyEntry[], mine: LobbyEntry, now = Date.now()): LobbyEntry[] {
  const fresh = existing.filter(e => e.key !== mine.key && now - e.ts < COMMUNITY_TOPOLOGY.lobbyFreshMs && e.ts <= now + 60_000);
  return [...fresh.sort((a, b) => a.ts - b.ts).slice(-(COMMUNITY_TOPOLOGY.lobbyEntries - 1)), mine];
}

/** Fresh hubs of a beacon, as a member sees them. */
export function freshHubs(hubs: Hub[], now = Date.now()): Hub[] {
  return hubs.filter(h => now - h.ts < COMMUNITY_TOPOLOGY.beaconFreshMs && h.ts <= now + 60_000);
}

/** Rendezvous hashing: how strongly a hub is responsible for someone (a knock, a member). Highest first. */
export function hubRank(subject: string, hubKey: string): string {
  return toBase64Url(sha256(concatBytes(utf8Encode("ghostly-group-community/1 rank"), publicKeyFromZ32(subject), publicKeyFromZ32(hubKey))));
}
export function rankHubs(subject: string, hubs: string[]): string[] {
  return [...hubs].sort((a, b) => { const ra = hubRank(subject, a), rb = hubRank(subject, b); return ra < rb ? 1 : ra > rb ? -1 : 0; });
}

/**
 * The hubs a member asks for edges: the least loaded fresh ones with room, ties broken by rank
 * for this member (so members spread out), at most `hubsPerMember`.
 */
export function pickHubs(me: string, hubs: Hub[], now = Date.now(), avoid: ReadonlySet<string> = new Set()): string[] {
  // A hub that republished lately first (one whose app closed stays listed a while), then the least loaded.
  const lately = (h: Hub) => now - h.ts < COMMUNITY_TOPOLOGY.beaconEveryMs * 1.5 ? 0 : 1;
  const open = freshHubs(hubs, now).filter(h => h.key !== me && !avoid.has(h.key) && h.load < COMMUNITY_TOPOLOGY.hubCapacity)
    .sort((a, b) => lately(a) - lately(b) || a.load - b.load || (hubRank(me, a.key) < hubRank(me, b.key) ? 1 : -1));
  return open.slice(0, COMMUNITY_TOPOLOGY.hubsPerMember).map(h => h.key);
}

/** Should this member be a hub? Too few fresh hubs, or all full, and room in the beacon. */
export function shouldBeHub(me: string, hubs: Hub[], now = Date.now()): boolean {
  const fresh = freshHubs(hubs, now).filter(h => h.key !== me);
  if (fresh.length >= COMMUNITY_TOPOLOGY.maxHubs) return false;
  return fresh.length < COMMUNITY_TOPOLOGY.minHubs || fresh.every(h => h.load >= COMMUNITY_TOPOLOGY.hubCapacity);
}
