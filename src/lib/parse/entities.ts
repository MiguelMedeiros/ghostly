import { decodeCommunityLink, decodeGroupEntryLink, isPubkyKey, parseDid, readInviteCode } from "@ghostly/core";
import { nostrPointer, type NostrPointer } from "@ghostly/browser/nostr/social";

/**
 * Things in a message's text that get a card under it: a Ghostly invite, a group's link, a Nostr key or note, a Pubky
 * key or a DID. Each one is only found when it checks out (a bech32m or bech32 checksum, a key that decodes, a DID
 * Ghostly can resolve), so a typo stays plain text. Nothing here reaches the network or joins anything: the cards do
 * that, when the person taps.
 */
export type Entity = { start: number; end: number; text: string } & (
  /** A `ghostly1…` invite, bare or in its `https://ghostly.tools/#…` link. `code` is the bare code. */
  | { kind: "invite"; code: string }
  /** A group's link (`group1/…`) or a community group's (`group2/…`). `link` is the bare code the engine joins by. */
  | { kind: "group"; link: string; community: boolean; groupId: string }
  /** An `npub`, `nprofile`, `note` or `nevent`, with or without `nostr:`. */
  | { kind: "nostr"; code: string; pointer: NostrPointer }
  /** A Pubky key (`pubky://…`, `pk:…`) or a DID (`did:key|jwk|dht|web:…`). `subject` is canonical. */
  | { kind: "identity"; provider: "pubky" | "did"; subject: string }
);

/** Cards under one message, at most: a message that lists more is a list, and the rest stay text. */
export const MAX_ENTITY_CARDS = 3;
/** Longer messages are only scanned this far. */
const SCAN_LIMIT = 20_000;

const INVITE_RE = /(?<![A-Za-z0-9])(?:https?:\/\/[^\s#]*#\/?(?:chat\/)?)?(ghostly1[0-9a-z]+)/gi;
const GROUP_RE = /(?<![A-Za-z0-9])(?:https?:\/\/[^\s#]*#\/?(?:join\/)?)?(group([12])\/[A-Za-z0-9_-]{22}\/[a-z0-9]{52})(?![A-Za-z0-9])/g;
const NOSTR_RE = /(?<![A-Za-z0-9:])(?:nostr:)?((?:npub|nprofile|note|nevent)1[02-9ac-hj-np-z]+)(?![A-Za-z0-9])/gi;
const PUBKY_RE = /(?<![A-Za-z0-9])(?:pubky:\/\/|pk:)([a-z0-9]{52})(?![A-Za-z0-9])/gi;
const DID_RE = /(?<![A-Za-z0-9])did:(?:key|jwk|dht|web):[A-Za-z0-9._%:-]+/g;

function find(text: string): Entity[] {
  const found: Entity[] = [];
  const at = (m: RegExpMatchArray, length = m[0].length) => ({ start: m.index!, end: m.index! + length, text: m[0].slice(0, length) });

  for (const m of text.matchAll(INVITE_RE)) {
    const code = m[1].toLowerCase();
    if (readInviteCode(code).ok) found.push({ ...at(m), kind: "invite", code });
  }
  for (const m of text.matchAll(GROUP_RE)) {
    const community = m[2] === "2";
    const link = community ? decodeCommunityLink(m[1]) : decodeGroupEntryLink(m[1]);
    if (link) found.push({ ...at(m), kind: "group", link: m[1], community, groupId: link.g });
  }
  for (const m of text.matchAll(NOSTR_RE)) {
    const pointer = nostrPointer(m[1]);
    if (pointer) found.push({ ...at(m), kind: "nostr", code: m[1].toLowerCase(), pointer });
  }
  for (const m of text.matchAll(PUBKY_RE)) {
    const key = m[1].toLowerCase();
    if (isPubkyKey(key)) found.push({ ...at(m), kind: "identity", provider: "pubky", subject: key });
  }
  for (const m of text.matchAll(DID_RE)) {
    // The sentence around it keeps its full stop: "my DID is did:web:example.com."
    const did = m[0].replace(/[.:,;]+$/, "");
    try { found.push({ ...at(m, did.length), kind: "identity", provider: "did", subject: parseDid(did).did }); } catch { /* not one Ghostly checks */ }
  }
  return found;
}

/** What makes two finds the same card: the same invite, group, key, note or identity, however it was written. */
export function entityKey(e: Entity): string {
  switch (e.kind) {
    case "invite": return `invite:${e.code}`;
    case "group": return `group:${e.link}`;
    case "nostr": return e.pointer.type === "profile" ? `nostr:p:${e.pointer.pubkey}` : `nostr:e:${e.pointer.id}`;
    case "identity": return `${e.provider}:${e.subject}`;
  }
}

/** Every entity in `text`, in reading order, each one once (its first place), none overlapping another. */
export function findEntities(text: string): Entity[] {
  const seen = new Set<string>();
  let end = 0;
  return find(text.slice(0, SCAN_LIMIT))
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter(e => {
      const key = entityKey(e);
      if (e.start < end || seen.has(key)) return false;
      seen.add(key);
      end = e.end;
      return true;
    });
}
