import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64Url, toBase64Url, utf8Encode } from "./bytes";
import { encrypt, tryDecrypt } from "./crypto";
import { identityFromSeed, identityFromSeedB64, publicKeyFromZ32, sign, verify, type Identity } from "./identity";
import type { LinkParams } from "./invite";
import type { PairingCredentials } from "./pairedSession";
import type { TransportDescriptors } from "./pairedTransports";
import { measureRecords, MAX_DNS_PACKET_BYTES, type GhostRecord, type SignedPacket } from "./pkarr";
import type { PkarrTransport } from "./transport";

/**
 * The layer-0 capability record of a chat (WISP 03, revision 0.2): what each side accepts on the DHT
 * (`dht-text/1`, `hold/1`), what its layer 1 would carry, the minimum to dial its native transports
 * without a WebRTC session first, and the name it shares. One Pkarr key per direction, derived from the
 * invite secret like the DHT mailboxes, so its size never competes with a text.
 *
 * Sealed with the invitation-derived key until the contact is pinned, and with a key only the two
 * participation keys derive afterwards, so a copied invite stops reading it. Always signed by the
 * author's participation key over both rendezvous keys.
 */
export const DHT_TEXT_CAPABILITY = "dht-text/1" as const;
export const CAPS_LABEL = "_caps";
export const CAPS_LIMITS = {
  versions: 8,
  transports: 8,
  capabilities: 32,
  extensions: 32,
  /** One identifier, capability or extension. */
  itemChars: 48,
  nameBytes: 64,
  /** A record dated further ahead than this is refused. */
  clockSkewMs: 60_000,
} as const;
/** Published again this often while the chat exists, so it does not age out of the DHT. */
export const CAPS_REFRESH_MS = 60 * 60_000;
/** Reads of the contact's record closer together than this are merged into one. */
const CAPS_READ_SPACING_MS = 15_000;
/**
 * Changes closer together than this go out as one publication, the last: every publication spends one of the
 * relays' requests per relay, a budget the chat's signaling needs more.
 */
export const CAPS_PUBLISH_SPACING_MS = 30_000;

/**
 * Per native transport, the minimum to dial it: no network address, ever. Keys travel as base64url (32
 * bytes, 43 characters) to leave the packet room for capabilities.
 */
export interface CapsDescriptors {
  "iroh/1"?: { id: string; relay?: string };
  "hyperdht/1"?: { publicKey: string };
}
export interface CapsContent {
  versions: number[];
  /** Layer-1 transports this runtime has, in local preference order. Never the DHT. */
  transports: string[];
  capabilities: string[];
  extensions: string[];
  descriptors: CapsDescriptors;
  /** The name this profile shares with contacts; empty when it shares none. */
  name: string;
}
export interface CapsRecord extends CapsContent {
  rev: number;
  issued: number;
  /** The participation key that signed it. */
  author: string;
}
type Body = [version: 1, rev: number, issued: number, author: string, versions: number[], transports: string[], capabilities: string[],
  extensions: string[], descriptors: CapsDescriptors, name: string];

export type CapsRefusal = "address" | "size" | "sealed" | "format" | "signature" | "author" | "future" | "rev";
/** Why a record was not used. A refused record leaves the last good one in force. */
export class CapsRefusedError extends Error {
  constructor(readonly reason: CapsRefusal, message: string) { super(message); }
}

const IDENT = /^[a-z0-9][a-z0-9._-]*\/[0-9]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const Z32 = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const hexToKey = (hex: string) => toBase64Url(Uint8Array.from(hex.match(/../g)!, b => parseInt(b, 16)));
const keyToHex = (key: string) => Array.from(fromBase64Url(key), b => b.toString(16).padStart(2, "0")).join("");

/**
 * The part of the native descriptors a capability record may carry: the Iroh endpoint id (and the relay
 * it is reachable through, a public service rather than an address of this device), the HyperDHT key.
 */
export function capsDescriptors(descriptors: TransportDescriptors | undefined): CapsDescriptors {
  const out: CapsDescriptors = {};
  const iroh = descriptors?.["iroh/1"] as { id?: unknown; relay?: unknown } | undefined;
  if (iroh && typeof iroh.id === "string" && HEX64.test(iroh.id))
    out["iroh/1"] = { id: hexToKey(iroh.id), ...(typeof iroh.relay === "string" && /^https:\/\/[^\s]{1,120}$/.test(iroh.relay) ? { relay: iroh.relay } : {}) };
  const hyper = descriptors?.["hyperdht/1"] as { publicKey?: unknown } | undefined;
  if (hyper && typeof hyper.publicKey === "string" && HEX64.test(hyper.publicKey)) out["hyperdht/1"] = { publicKey: hexToKey(hyper.publicKey) };
  return out;
}

/** A record's descriptors as the transport adapters dial them (Iroh with no direct addresses). */
export function dialDescriptors(descriptors: CapsDescriptors): TransportDescriptors {
  const out: TransportDescriptors = {};
  if (descriptors["iroh/1"]) out["iroh/1"] = { id: keyToHex(descriptors["iroh/1"].id), relay: descriptors["iroh/1"].relay ?? null, addresses: [] };
  if (descriptors["hyperdht/1"]) out["hyperdht/1"] = { publicKey: keyToHex(descriptors["hyperdht/1"].publicKey) };
  return out;
}

const list = (value: unknown, max: number, item: (v: unknown) => boolean): boolean =>
  Array.isArray(value) && value.length <= max && value.every(item);
const ident = (v: unknown) => typeof v === "string" && v.length <= CAPS_LIMITS.itemChars && IDENT.test(v);

function parseDescriptors(value: unknown): CapsDescriptors | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // Descriptors of transports this reader does not know are skipped, not a reason to refuse the record.
  const raw = value as Record<string, { id?: unknown; relay?: unknown; publicKey?: unknown } | undefined>;
  const out: CapsDescriptors = {};
  const iroh = raw["iroh/1"], hyper = raw["hyperdht/1"];
  if (iroh !== undefined) {
    if (!iroh || typeof iroh.id !== "string" || !KEY.test(iroh.id) || (iroh.relay !== undefined && (typeof iroh.relay !== "string" || !/^https:\/\/[^\s]{1,120}$/.test(iroh.relay)))) return null;
    out["iroh/1"] = { id: iroh.id, ...(iroh.relay !== undefined ? { relay: iroh.relay as string } : {}) };
  }
  if (hyper !== undefined) {
    if (!hyper || typeof hyper.publicKey !== "string" || !KEY.test(hyper.publicKey)) return null;
    out["hyperdht/1"] = { publicKey: hyper.publicKey };
  }
  return out;
}

/** Keys of the capability record of one link: my record's key and seals, the contact's address. */
export class CapsKeys {
  readonly from: string;
  readonly to: string;
  readonly me: string;
  /** Publishes my record. */
  readonly identity: Identity;
  /** Where the contact publishes its record. */
  readonly peerAddress: string;
  private readonly seed: Uint8Array;
  private readonly inviteKey: Uint8Array;

  constructor(params: LinkParams, participationSeedB64: string) {
    this.from = identityFromSeedB64(params.seedB64).pubKeyZ32;
    this.to = params.peerPubKeyZ32;
    const mine = identityFromSeedB64(participationSeedB64);
    this.seed = mine.seed;
    this.me = mine.pubKeyZ32;
    const secret = fromBase64Url(params.encKeyB64);
    const context = JSON.stringify(["ghostly-caps/1", [this.from, this.to].sort()]);
    const derive = (label: string) => hkdf(sha256, secret, utf8Encode(context), utf8Encode(label), 32);
    this.identity = identityFromSeed(derive(`caps:${this.from}`));
    this.peerAddress = identityFromSeed(derive(`caps:${this.to}`)).pubKeyZ32;
    this.inviteKey = derive("envelope");
  }

  private pinnedKey(peer: string): Uint8Array {
    const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(this.seed), ed25519.utils.toMontgomery(publicKeyFromZ32(peer)));
    return hkdf(sha256, shared, this.inviteKey, utf8Encode("ghostly-caps-participation/1"), 32);
  }
  private signable(from: string, to: string, body: unknown[]): Uint8Array { return utf8Encode(JSON.stringify(["ghostly-caps", from, to, body])); }

  /**
   * My record as Pkarr records, sealed for the pinned contact (or with the invite key before the pin).
   * Past 1,000 bytes the name goes first, then the extensions; capabilities and transports are never cut.
   */
  seal(content: CapsContent, rev: number, peerKey?: string, now = Date.now()): { records: GhostRecord[]; dropped: ("name" | "extensions")[] } {
    const dropped: ("name" | "extensions")[] = [];
    let name = content.name, extensions = content.extensions;
    for (;;) {
      const body: Body = [1, rev, now, this.me, content.versions, content.transports, content.capabilities, extensions, content.descriptors, name];
      const signature = toBase64Url(sign(this.signable(this.from, this.to, body), this.seed));
      const records = [{ label: CAPS_LABEL, value: encrypt(JSON.stringify([body, signature]), peerKey ? this.pinnedKey(peerKey) : this.inviteKey), ttl: 3600 }];
      if (measureRecords(this.identity.pubKeyZ32, records) <= MAX_DNS_PACKET_BYTES) return { records, dropped };
      if (name) { name = ""; dropped.push("name"); continue; }
      if (extensions.length) { extensions = []; dropped.push("extensions"); continue; }
      throw new CapsRefusedError("size", "The capability record does not fit a DHT packet even without its name and extensions.");
    }
  }

  /**
   * The contact's record, checked: its address, its seal, a well-formed body, a signature by the pinned
   * participation key (before the pin, by `expected` when a first contact named one), not from the future
   * and not older than `minRev`.
   */
  open(packet: SignedPacket, options: { pinned?: string; expected?: string; minRev?: number; now?: number } = {}): CapsRecord {
    const now = options.now ?? Date.now();
    if (packet.pubKeyZ32 !== this.peerAddress) throw new CapsRefusedError("address", "Not this contact's capability record.");
    if (measureRecords(packet.pubKeyZ32, packet.records) > MAX_DNS_PACKET_BYTES) throw new CapsRefusedError("size", "Capability record over the DHT packet budget.");
    const sealed = packet.records.filter(r => r.label === CAPS_LABEL);
    if (sealed.length !== 1) throw new CapsRefusedError("format", "No single capability record.");
    const plaintext = (options.pinned ? tryDecrypt(sealed[0].value, this.pinnedKey(options.pinned)) : null) ?? tryDecrypt(sealed[0].value, this.inviteKey);
    if (!plaintext) throw new CapsRefusedError("sealed", "The capability record cannot be opened with this chat's keys.");
    let envelope: unknown;
    try { envelope = JSON.parse(plaintext); } catch { throw new CapsRefusedError("format", "Malformed capability record."); }
    if (!Array.isArray(envelope) || envelope.length !== 2 || !Array.isArray(envelope[0]) || typeof envelope[1] !== "string" || !SIG.test(envelope[1]))
      throw new CapsRefusedError("format", "Malformed capability record.");
    const body = envelope[0] as unknown[], signature = envelope[1];
    // Trailing elements a later revision may add are carried by the signature and otherwise ignored.
    if (body.length < 10 || body.length > 16) throw new CapsRefusedError("format", "Malformed capability record.");
    const [version, rev, issued, author, versions, transports, capabilities, extensions, rawDescriptors, name] = body;
    const descriptors = parseDescriptors(rawDescriptors);
    if (version !== 1 || !Number.isSafeInteger(rev) || (rev as number) < 0 || !Number.isSafeInteger(issued) || (issued as number) <= 0 ||
      typeof author !== "string" || !Z32.test(author) ||
      !list(versions, CAPS_LIMITS.versions, v => Number.isSafeInteger(v) && (v as number) > 0) ||
      !list(transports, CAPS_LIMITS.transports, ident) || (transports as string[]).includes("dht/1") ||
      !list(capabilities, CAPS_LIMITS.capabilities, ident) || !list(extensions, CAPS_LIMITS.extensions, ident) ||
      !descriptors || typeof name !== "string" || utf8Encode(name).length > CAPS_LIMITS.nameBytes)
      throw new CapsRefusedError("format", "Malformed capability record.");
    const signer = options.pinned ?? options.expected;
    if (signer && author !== signer) throw new CapsRefusedError("author", "The capability record is signed by another participation key than this contact's.");
    try {
      if (!verify(fromBase64Url(signature), this.signable(this.to, this.from, body), publicKeyFromZ32(author)))
        throw new CapsRefusedError("signature", "The capability record's signature does not verify.");
    } catch (error) {
      if (error instanceof CapsRefusedError) throw error;
      throw new CapsRefusedError("signature", "The capability record's signature does not verify.");
    }
    if ((issued as number) > now + CAPS_LIMITS.clockSkewMs) throw new CapsRefusedError("future", "The capability record is dated in the future.");
    if (options.minRev !== undefined && (rev as number) < options.minRev) throw new CapsRefusedError("rev", "An older capability record than one already seen.");
    return { rev: rev as number, issued: issued as number, author, versions: versions as number[], transports: transports as string[],
      capabilities: capabilities as string[], extensions: extensions as string[], descriptors, name };
  }
}

export interface CapsState {
  /** My record's revision: increases with every change of its content. */
  rev: number;
  /** A digest of the content last published, and when, and whether sealed for the pinned contact. */
  digest?: string;
  publishedAt?: number;
  sealedFor?: string;
  /** The contact's last good record. */
  peer?: CapsRecord;
}
export const emptyCapsState = (): CapsState => ({ rev: 0 });

const digestOf = (content: CapsContent) => toBase64Url(sha256(utf8Encode(JSON.stringify(content)))).slice(0, 22);

/**
 * Publishes this side's record (at first start, at every change, hourly) and reads the contact's (at
 * pairing, when an envelope names a newer revision, when the chat drops to the DHT). Every read and
 * publish goes through one queue; reads close together are merged.
 */
export class CapsExchange {
  private state: CapsState;
  private readonly keys: CapsKeys;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastRead = 0;
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  private dropped: ("name" | "extensions")[] = [];

  constructor(private readonly options: {
    params: LinkParams;
    credentials: PairingCredentials;
    transport: PkarrTransport;
    local(): CapsContent;
    state?: CapsState;
    save(state: CapsState): Promise<void>;
    /** The contact's record changed (a newer revision was read). */
    changed?(record: CapsRecord): void;
    /** A record was refused; `author` is a security signal (another key signed under this chat's address). */
    refused?(error: CapsRefusedError): void;
  }) {
    this.state = structuredClone(options.state ?? emptyCapsState());
    this.keys = new CapsKeys(options.params, options.credentials.seedB64);
  }

  get rev(): number { return this.state.rev; }
  get peer(): CapsRecord | undefined { return this.state.peer; }
  /** What had to be left out to fit the packet at the last publication. */
  get droppedFields(): readonly ("name" | "extensions")[] { return this.dropped; }
  get address(): string { return this.keys.identity.pubKeyZ32; }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run); this.chain = next.catch(() => {}); return next;
  }
  private async persist(next: CapsState): Promise<void> { await this.options.save(structuredClone(next)); this.state = next; }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.update().catch(() => {});
    // Paired, and the contact's record never read: once. After that, a newer revision named in an envelope,
    // a drop or a new pin is what reads it again, not every start.
    if (this.options.credentials.peerKey && !this.state.peer) this.refresh(true);
  }
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.readTimer) clearTimeout(this.readTimer);
    this.timer = this.readTimer = null;
    await this.chain.catch(() => {});
  }

  /**
   * Publishes when the content changed, when the contact was pinned since the last publication (the
   * record is sealed anew for it), or when the last one is an hour old. Otherwise nothing goes out.
   */
  update(): Promise<void> {
    return this.serialize(async () => {
      if (!this.running) return;
      const content = this.options.local(), digest = digestOf(content), now = Date.now();
      const peerKey = this.options.credentials.peerKey;
      const changed = digest !== this.state.digest;
      const due = changed || peerKey !== this.state.sealedFor || !this.state.publishedAt || now - this.state.publishedAt >= CAPS_REFRESH_MS;
      // A change right after a publication waits for the spacing; a new pin does not (the contact reads it next).
      const soon = changed && peerKey === this.state.sealedFor && !!this.state.publishedAt && now - this.state.publishedAt < CAPS_PUBLISH_SPACING_MS;
      if (due && soon) { this.schedule(this.state.publishedAt! + CAPS_PUBLISH_SPACING_MS - now); return; }
      if (due) {
        const rev = changed ? this.state.rev + 1 : this.state.rev;
        const { records, dropped } = this.keys.seal(content, rev, peerKey, now);
        this.dropped = dropped;
        // The revision is saved before it is published, so a crash never reuses it for other content.
        await this.persist({ ...this.state, rev, digest, sealedFor: peerKey });
        await this.options.transport.publish(this.keys.identity, records, changed ? undefined : { background: true });
        await this.persist({ ...this.state, publishedAt: now });
      }
      this.schedule();
    });
  }
  private schedule(inMs?: number): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.running) return;
    const age = Date.now() - (this.state.publishedAt ?? 0);
    this.timer = setTimeout(() => void this.update().catch(() => this.schedule()), inMs ?? Math.max(60_000, CAPS_REFRESH_MS - age));
  }

  /** An envelope named this revision of the contact's record: read it when it is newer than the one known. */
  peerRev(rev: number): void {
    if (!Number.isSafeInteger(rev) || rev <= (this.state.peer?.rev ?? -1)) return;
    this.refresh(true);
  }

  /** Reads the contact's record now (or right after the last read, when that was a moment ago). */
  refresh(force = false): void {
    if (!this.running || this.readTimer) return;
    const wait = force ? 0 : Math.max(0, this.lastRead + CAPS_READ_SPACING_MS - Date.now());
    const run = () => { this.readTimer = null; void this.read().catch(() => {}); };
    if (!wait) { this.readTimer = setTimeout(run, 0); return; }
    this.readTimer = setTimeout(run, wait);
  }

  /** Reads and checks the contact's record; the last good one stays when this one is refused. */
  read(): Promise<CapsRecord | undefined> {
    return this.serialize(async () => {
      if (!this.running) return this.state.peer;
      this.lastRead = Date.now();
      const packet = await this.options.transport.resolve(this.keys.peerAddress);
      if (!packet || !this.running) return this.state.peer;
      let record: CapsRecord;
      try {
        record = this.keys.open(packet, { pinned: this.options.credentials.peerKey, minRev: this.state.peer?.rev });
      } catch (error) {
        if (error instanceof CapsRefusedError && error.reason !== "rev") this.options.refused?.(error);
        return this.state.peer;
      }
      if (this.state.peer && record.rev === this.state.peer.rev && record.author === this.state.peer.author) return this.state.peer;
      await this.persist({ ...this.state, peer: record });
      this.options.changed?.(record);
      return record;
    });
  }
}
