import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, fromBase64Url, randomBytes, toBase64Url, utf8Decode, utf8Encode } from "./bytes";
import { encrypt, tryDecrypt } from "./crypto";
import { identityFromSeed, identityFromSeedB64, publicKeyFromZ32, sign, verify, type Identity } from "./identity";
import type { LinkParams } from "./invite";
import { measureRecords, MAX_DNS_PACKET_BYTES, type GhostRecord, type SignedPacket } from "./pkarr";

/**
 * Store-and-forward for an away contact (WISP 4xx draft, `hold/1`).
 *
 * What a person sends while the contact is away is sealed into a *bundle* (signed by the sender's
 * participation key, then encrypted to a key only the two of them can derive), put in the sender's
 * own storage (WISP 1000), and named in a *manifest* the storage also holds. A small signed, encrypted
 * *pointer* record on a per-link Pkarr key tells the contact where the manifest is (a URL that expires)
 * and which of the contact's own bundles have been received. Storage and relays see ciphertext, sizes
 * and timing only. Nothing here promises forward secrecy or retention beyond the bounds below.
 */
export const HOLD_CAPABILITY = "hold/1" as const;
export const HOLD_LIMITS = {
  /** One bundle, ciphertext and header included: a picture, not a video. */
  maxBundleBytes: 8 * 1024 * 1024,
  /** All bundles held for one contact at once. */
  maxMailboxBytes: 64 * 1024 * 1024,
  maxMailboxBundles: 64,
  /** A bundle not picked up by then is dropped by its sender. The longest a presigned URL lives, too. */
  ttlMs: 7 * 24 * 60 * 60_000,
  maxTextBytes: 16 * 1024,
  maxPaymentRequestBytes: 64 * 1024,
  maxManifestBytes: 64 * 1024,
  /** A pointer or bundle from the future by more than this is refused. */
  clockSkewMs: 60_000,
} as const;

export type HoldKind = "text" | "file" | "pay-req" | "manifest";
const KINDS: readonly string[] = ["text", "file", "pay-req", "manifest"];
const WIRE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAILBOX = /^[A-Za-z0-9_-]{22}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const MAGIC = utf8Encode("GHLD");
const VERSION = 1;
const NONCE = 24;

export interface HoldFileMeta { name: string; size: number; mime: string }
/** One held bundle as the manifest lists it: where to get it, and what to expect. */
export type HoldManifestEntry = [seq: number, id: string, kind: Exclude<HoldKind, "manifest">, bytes: number, url: string, expires: number];
export interface HoldHeader {
  v: 1;
  /** Rendezvous keys, as the sender sees the link. */
  from: string;
  to: string;
  /** Participation keys: who signed, who may open. */
  author: string;
  recipient: string;
  mailbox: string;
  seq: number;
  id: string;
  ts: number;
  kind: HoldKind;
  meta: unknown;
  /** base64url SHA-256 of the body. */
  digest: string;
  expires: number;
}
export interface HoldPointer {
  rev: number;
  issued: number;
  /** When the manifest URL stops working. */
  expires: number;
  manifestUrl: string | null;
  /** Highest sequence the publisher has held for the reader. */
  top: number;
  /** Highest sequence the publisher received from the reader. */
  ack: number;
  count: number;
  bytes: number;
  /** Sequences of the reader's items this publisher refused (changed, oversized, not for it): at most the last 32. */
  refused: number[];
}

/** Why a bundle, manifest or pointer was refused. Never a reason to trust it a little. */
export class HoldRefusedError extends Error {
  constructor(readonly reason: "size" | "format" | "tampered" | "not-for-me" | "author" | "signature" | "digest" | "limits" | "expired" | "future", message: string) {
    super(message);
  }
}

const bodyDigest = (body: Uint8Array) => toBase64Url(sha256(body));
const newMailbox = () => toBase64Url(randomBytes(16)).slice(0, 22);
export { newMailbox as newHoldMailbox };

/**
 * Everything derived once per link for this feature: my pointer key, the contact's pointer address and
 * the key that seals bundles and pointers between the two participation keys. Needs a pinned contact.
 */
export class HoldKeys {
  readonly from: string;
  readonly to: string;
  readonly me: string;
  readonly peer: string;
  /** Publishes my pointer. */
  readonly identity: Identity;
  /** Where the contact publishes its pointer. */
  readonly peerAddress: string;
  private readonly seed: Uint8Array;
  private readonly sealKey: Uint8Array;

  constructor(params: LinkParams, participationSeedB64: string, peerKey: string) {
    this.from = identityFromSeedB64(params.seedB64).pubKeyZ32;
    this.to = params.peerPubKeyZ32;
    const mine = identityFromSeedB64(participationSeedB64);
    this.seed = mine.seed;
    this.me = mine.pubKeyZ32;
    this.peer = peerKey;
    const secret = fromBase64Url(params.encKeyB64);
    const context = JSON.stringify(["ghostly-hold/1", [this.from, this.to].sort()]);
    const derive = (label: string) => hkdf(sha256, secret, utf8Encode(context), utf8Encode(label), 32);
    this.identity = identityFromSeed(derive(`pointer:${this.from}`));
    this.peerAddress = identityFromSeed(derive(`pointer:${this.to}`)).pubKeyZ32;
    const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(this.seed), ed25519.utils.toMontgomery(publicKeyFromZ32(peerKey)));
    this.sealKey = hkdf(sha256, shared, derive("envelope"), utf8Encode("ghostly-hold-envelope/1"), 32);
  }

  /** Seals one item for the contact: signed with my participation key, encrypted to our shared key. */
  seal(item: { mailbox: string; seq: number; id: string; ts: number; kind: HoldKind; meta?: unknown; expires: number }, body: Uint8Array): Uint8Array {
    const fields = [VERSION, this.from, this.to, this.me, this.peer, item.mailbox, item.seq, item.id, item.ts, item.kind, item.meta ?? null, bodyDigest(body), item.expires];
    const signature = toBase64Url(sign(utf8Encode(JSON.stringify(["ghostly-hold-bundle", fields])), this.seed));
    const header = utf8Encode(JSON.stringify([fields, signature]));
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, header.length);
    const nonce = randomBytes(NONCE);
    const box = xsalsa20poly1305(this.sealKey, nonce).encrypt(concatBytes(length, header, body));
    return concatBytes(MAGIC, new Uint8Array([VERSION]), nonce, box);
  }

  /**
   * Opens a bundle the contact sealed for me. Everything is checked before anything is returned: the
   * authenticated encryption, the header's shape, that it names this link, this contact and me, the
   * signature, the body digest and the limits of its kind.
   */
  open(bytes: Uint8Array, expect: { maxBytes?: number; mailbox?: string; now?: number } = {}): { header: HoldHeader; body: Uint8Array } {
    const now = expect.now ?? Date.now();
    if (bytes.length > (expect.maxBytes ?? HOLD_LIMITS.maxBundleBytes)) throw new HoldRefusedError("size", "The held item is larger than allowed");
    if (bytes.length < MAGIC.length + 1 + NONCE + 16 + 4 || !MAGIC.every((b, i) => bytes[i] === b)) throw new HoldRefusedError("format", "Not a held item");
    if (bytes[MAGIC.length] !== VERSION) throw new HoldRefusedError("format", "Held item from a newer Ghostly");
    let plain: Uint8Array;
    try { plain = xsalsa20poly1305(this.sealKey, bytes.subarray(MAGIC.length + 1, MAGIC.length + 1 + NONCE)).decrypt(bytes.subarray(MAGIC.length + 1 + NONCE)); }
    catch { throw new HoldRefusedError("tampered", "The held item was changed or is not for this chat"); }
    if (plain.length < 4) throw new HoldRefusedError("format", "Not a held item");
    const headerLength = new DataView(plain.buffer, plain.byteOffset, 4).getUint32(0);
    if (headerLength > 128 * 1024 || 4 + headerLength > plain.length) throw new HoldRefusedError("format", "Not a held item");
    let parsed: unknown;
    try { parsed = JSON.parse(utf8Decode(plain.subarray(4, 4 + headerLength))); } catch { throw new HoldRefusedError("format", "Not a held item"); }
    if (!Array.isArray(parsed) || parsed.length !== 2 || !Array.isArray(parsed[0]) || parsed[0].length !== 13 || typeof parsed[1] !== "string" || !SIG.test(parsed[1])) throw new HoldRefusedError("format", "Not a held item");
    const [fields, signature] = parsed as [unknown[], string];
    const [v, from, to, author, recipient, mailbox, seq, id, ts, kind, meta, digest, expires] = fields;
    if (v !== VERSION || typeof from !== "string" || typeof to !== "string" || typeof author !== "string" || typeof recipient !== "string" || typeof mailbox !== "string" || !MAILBOX.test(mailbox) ||
      !Number.isSafeInteger(seq) || (seq as number) < 0 || typeof id !== "string" || !WIRE_ID.test(id) || !Number.isSafeInteger(ts) || (ts as number) <= 0 ||
      typeof kind !== "string" || !KINDS.includes(kind) || typeof digest !== "string" || !Number.isSafeInteger(expires)) throw new HoldRefusedError("format", "Not a held item");
    // Both directions of this link are sealed with the same key: the header says which one this is.
    if (from !== this.to || to !== this.from || recipient !== this.me) throw new HoldRefusedError("not-for-me", "The held item is for another chat");
    if (author !== this.peer) throw new HoldRefusedError("author", "The held item was not signed by this contact");
    if (expect.mailbox && mailbox !== expect.mailbox) throw new HoldRefusedError("not-for-me", "The held item is from another mailbox");
    let valid: boolean;
    try { valid = verify(fromBase64Url(signature), utf8Encode(JSON.stringify(["ghostly-hold-bundle", fields])), publicKeyFromZ32(author)); } catch { valid = false; }
    if (!valid) throw new HoldRefusedError("signature", "The held item's signature does not check out");
    const body = plain.subarray(4 + headerLength);
    if (bodyDigest(body) !== digest) throw new HoldRefusedError("digest", "The held item's content does not match its header");
    if ((ts as number) > now + HOLD_LIMITS.clockSkewMs) throw new HoldRefusedError("future", "The held item is dated in the future");
    // The item may be older than its upload (a retry, a message written offline); its expiry may not reach past one lifetime from now.
    if ((expires as number) <= (ts as number) || (expires as number) > now + HOLD_LIMITS.ttlMs + HOLD_LIMITS.clockSkewMs) throw new HoldRefusedError("limits", "The held item's lifetime is out of bounds");
    const header: HoldHeader = { v: 1, from, to, author, recipient, mailbox, seq: seq as number, id, ts: ts as number, kind: kind as HoldKind, meta, digest, expires: expires as number };
    checkKind(header, body);
    return { header, body };
  }

  /** My pointer, as records to publish under `identity`. Throws when it cannot fit a packet. */
  pointerRecords(pointer: HoldPointer, now = Date.now()): GhostRecord[] {
    const body = [VERSION, pointer.rev, pointer.issued, pointer.expires, pointer.manifestUrl, pointer.top, pointer.ack, pointer.count, pointer.bytes, pointer.refused.slice(-32)];
    const signature = toBase64Url(sign(utf8Encode(JSON.stringify(["ghostly-hold-pointer", this.from, this.to, body])), this.seed));
    const ttl = Math.min(24 * 3600, Math.max(60, Math.ceil((pointer.expires - now) / 1000)));
    const records = [{ label: "_hold", value: encrypt(JSON.stringify([body, signature]), this.sealKey), ttl }];
    if (measureRecords(this.identity.pubKeyZ32, records) > MAX_DNS_PACKET_BYTES) throw new Error("The storage address is too long for a DHT packet. Use a shorter endpoint or prefix.");
    return records;
  }

  /** The contact's pointer out of its packet, or null when the packet is not one of its pointers. */
  readPointer(packet: SignedPacket, now = Date.now()): HoldPointer | null {
    if (packet.pubKeyZ32 !== this.peerAddress || measureRecords(packet.pubKeyZ32, packet.records) > MAX_DNS_PACKET_BYTES) return null;
    const records = packet.records.filter(r => r.label === "_hold");
    if (records.length !== 1) return null;
    const plain = tryDecrypt(records[0].value, this.sealKey);
    if (!plain) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(plain); } catch { return null; }
    if (!Array.isArray(parsed) || parsed.length !== 2 || !Array.isArray(parsed[0]) || (parsed[0].length !== 9 && parsed[0].length !== 10) || typeof parsed[1] !== "string" || !SIG.test(parsed[1])) return null;
    const [body, signature] = parsed as [unknown[], string];
    const [v, rev, issued, expires, manifestUrl, top, ack, count, bytes, refused = []] = body;
    if (v !== VERSION || ![rev, issued, expires, top, ack, count, bytes].every(n => Number.isSafeInteger(n) && (n as number) >= 0) ||
      (manifestUrl !== null && (typeof manifestUrl !== "string" || manifestUrl.length > 2048)) || (issued as number) > now + HOLD_LIMITS.clockSkewMs ||
      !Array.isArray(refused) || refused.length > 32 || !refused.every(n => Number.isSafeInteger(n) && (n as number) > 0)) return null;
    try {
      if (!verify(fromBase64Url(signature), utf8Encode(JSON.stringify(["ghostly-hold-pointer", this.to, this.from, body])), publicKeyFromZ32(this.peer))) return null;
    } catch { return null; }
    return { rev: rev as number, issued: issued as number, expires: expires as number, manifestUrl: manifestUrl as string | null, top: top as number, ack: ack as number, count: count as number, bytes: bytes as number, refused: refused as number[] };
  }
}

/** A URL a bundle or manifest may be fetched from: HTTPS, or HTTP to this machine while testing. */
export function isHoldUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch { return false; }
}

/** The limits of each kind, on the way in. */
function checkKind(header: HoldHeader, body: Uint8Array): void {
  const bad = (message: string) => new HoldRefusedError("limits", message);
  switch (header.kind) {
    case "text":
      if (body.length > HOLD_LIMITS.maxTextBytes) throw bad("The held text is too long");
      try { utf8Decode(body); } catch { throw bad("The held text is not text"); }
      return;
    case "pay-req":
      if (body.length > HOLD_LIMITS.maxPaymentRequestBytes) throw bad("The held payment request is too large");
      return;
    case "file": {
      const meta = header.meta as Partial<HoldFileMeta> | null;
      if (!meta || typeof meta !== "object" || typeof meta.name !== "string" || meta.name.length > 255 || typeof meta.mime !== "string" || meta.mime.length > 255 || meta.size !== body.length) throw bad("The held file does not match its description");
      return;
    }
    case "manifest": {
      if (body.length !== 0) throw bad("A manifest carries no body");
      readManifest(header.meta);
      return;
    }
  }
}

/** The entries of a manifest, checked: strictly increasing sequences, bounded sizes, fetchable URLs. */
export function readManifest(meta: unknown): HoldManifestEntry[] {
  const bad = (message: string) => new HoldRefusedError("limits", message);
  const entries = (meta as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries) || entries.length > HOLD_LIMITS.maxMailboxBundles) throw bad("The manifest lists too many items");
  let last = 0, total = 0;
  const out: HoldManifestEntry[] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 6) throw bad("The manifest is malformed");
    const [seq, id, kind, bytes, url, expires] = entry;
    if (!Number.isSafeInteger(seq) || seq <= last || typeof id !== "string" || !WIRE_ID.test(id) || typeof kind !== "string" || !KINDS.includes(kind) || kind === "manifest" ||
      !Number.isSafeInteger(bytes) || bytes < 0 || bytes > HOLD_LIMITS.maxBundleBytes || !isHoldUrl(url) || !Number.isSafeInteger(expires)) throw bad("The manifest is malformed");
    last = seq; total += bytes;
    if (total > HOLD_LIMITS.maxMailboxBytes) throw bad("The manifest lists more than a mailbox may hold");
    out.push([seq, id, kind as HoldManifestEntry[2], bytes, url, expires]);
  }
  return out;
}
