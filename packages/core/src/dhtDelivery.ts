import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64Url, toBase64Url, utf8Encode } from "./bytes";
import { encrypt, tryDecrypt } from "./crypto";
import { identityFromSeed, identityFromSeedB64, publicKeyFromZ32, sign, verify } from "./identity";
import type { LinkParams } from "./invite";
import type { PairingCredentials } from "./pairedSession";
import { measureRecords, MAX_DNS_PACKET_BYTES, type GhostRecord, type SignedPacket } from "./pkarr";
import type { PkarrTransport } from "./transport";
import { traceLink } from "./linkTrace";

export type DeliveryMode = "stream" | "dht";
export const DHT_TEXT_BYTES = 256;
export const DHT_MESSAGE_TTL = 5 * 60_000;
const CONTROL_TTL = 10 * 60_000;
const MAX_ATTEMPTS = 8;
/** The contact's mailbox is read this often while either side is DHT-only, and otherwise… */
const DHT_POLL_MS = 4_000;
const STREAM_POLL_MS = 30_000;
/**
 * …except for this long after this side leaves DHT-only while the contact is still there: its own
 * switch then shows in seconds, not at the next 30 s read (both sides are blocked from a live link until
 * each has seen the other leave).
 */
export const LEAVING_DHT_FAST_MS = 2 * 60_000;
const ID = /^[A-Za-z0-9_-]{22}$/;
type Message = [id: string, timestamp: number, text: string];
type Body = [version: 1, sequence: number, issued: number, expires: number, author: string, mode: DeliveryMode, message: Message | null, receipt: string | null];
export interface DhtDeliveryState {
  sequence: number;
  peerSequence: number;
  peerMode?: DeliveryMode;
  peerRejected?: boolean;
  pending?: { message: Message; expires: number; attempts: number; next: number };
  receipt?: { id: string; expires: number; attempts: number };
  confirmed?: string;
}
export interface DhtDeliveryView {
  mode: DeliveryMode;
  peerMode?: DeliveryMode;
  authenticated: boolean;
  error?: string;
  pendingUntil?: number;
  maxTextBytes: number;
}
export const emptyDhtDeliveryState = (): DhtDeliveryState => ({ sequence: 0, peerSequence: 0 });

/** An invite is a secret capability, not an independently verified identity.
 * Participation signatures bind each encrypted envelope to both invite roles.
 * The same durable TOFU pin is required here and on all subsequent streams.
 * No forward-secrecy or guaranteed DHT retention claim is made. */
export class DhtDelivery {
  private state: DhtDeliveryState;
  private mode: DeliveryMode;
  private running = false;
  private ticking = false;
  private tickAgain = false;
  private fastUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain = Promise.resolve();
  private lastPublish = 0;
  private controlDue = 0;
  private errors: Partial<Record<"publish" | "read" | "peer", string>> = {};
  private readonly identity;
  private readonly peerAddress: string;
  private readonly key: Uint8Array;
  private readonly from: string;
  private readonly to: string;
  private readonly participation;
  constructor(private readonly options: {
    params: LinkParams; mode: DeliveryMode; state?: DhtDeliveryState;
    credentials: PairingCredentials; transport: PkarrTransport;
    save(state: DhtDeliveryState): Promise<void>;
    pin(key: string): Promise<void>;
    message(message: { id: string; text: string; timestamp: number }): Promise<void>;
    receipt(id: string): Promise<void>;
    changed(view: DhtDeliveryView): void;
    pollMs?: number;
  }) {
    this.state = structuredClone(options.state ?? emptyDhtDeliveryState()); this.mode = options.mode;
    if (this.state.peerRejected) this.errors.peer = "DHT participation key does not match the saved contact. No content or receipt was accepted.";
    this.from = identityFromSeedB64(options.params.seedB64).pubKeyZ32; this.to = options.params.peerPubKeyZ32;
    this.participation = identityFromSeedB64(options.credentials.seedB64);
    const secret = fromBase64Url(options.params.encKeyB64);
    const context = JSON.stringify(["ghostly-dht-delivery/1", [this.from, this.to].sort()]);
    const derive = (label: string) => hkdf(sha256, secret, utf8Encode(context), utf8Encode(label), 32);
    this.identity = identityFromSeed(derive(`mailbox:${this.from}`));
    this.peerAddress = identityFromSeed(derive(`mailbox:${this.to}`)).pubKeyZ32;
    this.key = derive("envelope");
  }
  get view(): DhtDeliveryView {
    return { mode: this.mode, peerMode: this.state.peerMode, authenticated: !!this.options.credentials.peerKey,
      error: Object.values(this.errors).join(". ") || undefined, pendingUntil: this.state.pending?.expires, maxTextBytes: DHT_TEXT_BYTES };
  }
  get comparisonCode(): string | undefined {
    if (!this.options.credentials.peerKey) return undefined;
    const digest = sha256(utf8Encode(JSON.stringify(["ghostly-dht-comparison/1", [this.from, this.to].sort(), [this.participation.pubKeyZ32, this.options.credentials.peerKey].sort()])));
    return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("").slice(0, 24).match(/.{4}/g)!.join(" ");
  }
  get peerMode(): DeliveryMode | undefined { return this.state.peerMode; }
  private changed(): void { this.options.changed(this.view); }
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.chain.then(run); this.chain = operation.then(() => {}, () => {}); return operation;
  }
  private async persist(next: DhtDeliveryState): Promise<void> { await this.options.save(structuredClone(next)); this.state = next; }
  private sealedKey(peer: string): Uint8Array {
    const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(this.participation.seed), ed25519.utils.toMontgomery(publicKeyFromZ32(peer)));
    return hkdf(sha256, shared, this.key, utf8Encode("ghostly-dht-participation-envelope/1"), 32);
  }
  private signed(body: Body, recipient = "invite"): Uint8Array { return utf8Encode(JSON.stringify(["ghostly-dht-envelope", this.from, this.to, recipient, body])); }
  private records(body: Body, recipient = this.options.credentials.peerKey): GhostRecord[] {
    const signature = toBase64Url(sign(this.signed(body, recipient), this.participation.seed));
    const ttl = Math.max(1, Math.ceil((body[3] - Date.now()) / 1000));
    const records = [{ label: "_dm", value: encrypt(JSON.stringify([body, signature]), recipient ? this.sealedKey(recipient) : this.key), ttl },
      ...(recipient ? [{ label: "_dmk", value: encrypt(this.participation.pubKeyZ32, this.key), ttl }] : [])];
    if (measureRecords(this.identity.pubKeyZ32, records) > MAX_DNS_PACKET_BYTES) throw new Error("Text and authentication exceed the DHT packet budget. Shorten the message.");
    return records;
  }
  async start(): Promise<void> {
    if (this.running) return; this.running = true;
    if (this.state.confirmed) await this.options.receipt(this.state.confirmed);
    this.changed(); void this.tick();
  }
  async stop(): Promise<void> { this.running = false; if (this.timer) clearTimeout(this.timer); this.timer = null; await this.chain; }
  async setMode(mode: DeliveryMode): Promise<void> {
    await this.serialize(async () => {
      // Preserve accepted DHT intent, its stable ID and original expiry across mode changes.
      await this.persist({ ...this.state });
      // The contact learns the new method from the next envelope: it goes out now, not after the publish spacing.
      this.mode = mode; this.controlDue = 0; this.lastPublish = 0;
      this.fastUntil = mode === "stream" ? Date.now() + LEAVING_DHT_FAST_MS : 0;
      this.changed();
    });
    void this.tick();
  }
  /** Reads the contact's mailbox now: something says it may have changed its delivery method. */
  refresh(): void { void this.tick(); }
  validate(text: string, timestamp: number, id: string): string | null {
    if (this.mode === "stream" && (!this.options.credentials.peerKey || !this.state.peerMode)) return "Offline DHT delivery needs an authenticated contact advertising DHT support. Use a DHT-only invitation for first contact.";
    if (this.errors.peer) return this.errors.peer;
    if (!ID.test(id) || !Number.isSafeInteger(timestamp) || timestamp <= 0) return "Invalid message.";
    if (utf8Encode(text).length > DHT_TEXT_BYTES) return `DHT text is limited to ${DHT_TEXT_BYTES} UTF-8 bytes. Shorten it or choose a live connection.`;
    if (/cashu[AB][A-Za-z0-9_-]+/i.test(text)) return "Payment tokens cannot be sent through DHT delivery.";
    const now = Date.now(), pending = this.state.pending;
    if (pending && pending.expires > now && pending.message[0] !== id) return "One DHT text can await a receipt at a time. Wait for its receipt or expiry before sending another.";
    if (pending?.message[0] === id && pending.expires > now && pending.attempts >= MAX_ATTEMPTS) return "DHT retry budget exhausted. Wait for expiry before retrying this message.";
    const next = pending?.message[0] === id && pending.expires > now ? pending : { message: [id, timestamp, text] as Message, expires: now + DHT_MESSAGE_TTL, attempts: 0, next: now };
    // Validate the complete encrypted DNS packet before accepting local intent.
    try { this.records([1, this.state.sequence + 1, now, next.expires, this.participation.pubKeyZ32, this.mode, next.message, this.state.receipt?.id ?? "abcdefghijklmnopqrstuv"], this.options.credentials.peerKey ?? this.participation.pubKeyZ32); }
    catch (error) { return error instanceof Error ? error.message : String(error); }
    return null;
  }
  async send(text: string, timestamp: number, id: string): Promise<string | null> {
    return this.serialize(async () => {
      const error = this.validate(text, timestamp, id);
      if (error) return error;
      const now = Date.now(), pending = this.state.pending;
      const next = pending?.message[0] === id && pending.expires > now ? pending : { message: [id, timestamp, text] as Message, expires: now + DHT_MESSAGE_TTL, attempts: 0, next: now };
      await this.persist({ ...this.state, pending: next }); this.changed();
      try { await this.publish(true); return null; }
      catch (error) { this.errors.publish = `DHT publication failed: ${String(error instanceof Error ? error.message : error)}. Bounded retry continues until expiry.`; this.changed(); return this.errors.publish; }
    });
  }
  /** A stream receipt for the same stable ID also cancels DHT retransmission. */
  async acknowledge(id: string): Promise<void> {
    await this.serialize(async () => {
      if (this.state.pending?.message[0] === id) await this.persist({ ...this.state, pending: undefined, confirmed: id });
      this.changed();
    });
  }
  private async publish(force = false): Promise<void> {
    const now = Date.now();
    if (!this.running || this.errors.peer || (!force && now - this.lastPublish < 4_000)) return;
    const pending = this.state.pending && this.state.pending.expires > now && this.state.pending.attempts < MAX_ATTEMPTS ? this.state.pending : undefined;
    const receipt = this.state.receipt && this.state.receipt.expires > now && this.state.receipt.attempts < MAX_ATTEMPTS ? this.state.receipt : undefined;
    if (!force && (!pending || pending.next > now) && !receipt && this.controlDue > now) return;
    const expires = pending?.expires ?? now + CONTROL_TTL;
    const body: Body = [1, this.state.sequence + 1, now, expires, this.participation.pubKeyZ32, this.mode, pending?.message ?? null, receipt?.id ?? null];
    const records = this.records(body);
    // Persist sequence and attempt count first. A crash cannot reuse them or
    // reset the retransmission budget/absolute message deadline.
    await this.persist({ ...this.state, sequence: body[1], pending: pending ? { ...pending, attempts: pending.attempts + 1, next: now + Math.min(60_000, 4_000 * 2 ** pending.attempts) } : this.state.pending,
      receipt: receipt ? { ...receipt, attempts: receipt.attempts + 1 } : this.state.receipt });
    this.lastPublish = now; this.controlDue = now + 4 * 60_000;
    traceLink(this.from, "dht-publish", { mode: this.mode, seq: body[1] });
    await this.options.transport.publish(this.identity, records);
    delete this.errors.publish; this.changed();
  }
  private async receive(packet: SignedPacket): Promise<void> {
    if (packet.pubKeyZ32 !== this.peerAddress || measureRecords(packet.pubKeyZ32, packet.records) > MAX_DNS_PACKET_BYTES) return;
    const records = packet.records.filter(r => r.label === "_dm"); if (records.length !== 1) return;
    const hints = packet.records.filter(r => r.label === "_dmk"); if (hints.length > 1) return;
    const sender = hints.length ? tryDecrypt(hints[0].value, this.key) : null;
    if (hints.length && !sender) return;
    let plaintext: string | null;
    try { plaintext = tryDecrypt(records[0].value, sender ? this.sealedKey(sender) : this.key); } catch { return; }
    if (!plaintext || utf8Encode(plaintext).length > 900) return;
    let envelope: unknown; try { envelope = JSON.parse(plaintext); } catch { return; }
    if (!Array.isArray(envelope) || envelope.length !== 2 || !Array.isArray(envelope[0])) return;
    const [body, signature] = envelope as [Body, string];
    const [version, sequence, issued, expires, author, mode, message, receipt] = body;
    const now = Date.now();
    if (body.length !== 8 || version !== 1 || !Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(issued) ||
      !Number.isSafeInteger(expires) || issued > now + 30_000 || expires <= now || expires - issued > CONTROL_TTL || issued >= expires ||
      (mode !== "stream" && mode !== "dht") || typeof author !== "string" || typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return;
    if (sender && sender !== author) return;
    try {
      if (!verify(fromBase64Url(signature), utf8Encode(JSON.stringify(["ghostly-dht-envelope", this.to, this.from, sender ? this.participation.pubKeyZ32 : "invite", body])), publicKeyFromZ32(author))) return;
    } catch { return; }
    // Before the pin, the key the invite named: another invite holder's envelope is refused, and not remembered,
    // since whoever holds a copy can write to this mailbox and the inviter's next envelope replaces it.
    if (!this.options.credentials.peerKey && this.options.credentials.expectedPeerKey && this.options.credentials.expectedPeerKey !== author) return;
    if (this.options.credentials.peerKey && this.options.credentials.peerKey !== author) { await this.persist({ ...this.state, peerRejected: true }); this.errors.peer = "DHT participation key does not match the saved contact. No content or receipt was accepted."; this.changed(); return; }
    if (sequence <= this.state.peerSequence) return;
    if (message !== null && (!Array.isArray(message) || message.length !== 3 || typeof message[0] !== "string" || !ID.test(message[0]) || !Number.isSafeInteger(message[1]) || message[1] <= 0 || message[1] > issued + 30_000 ||
      typeof message[2] !== "string" || utf8Encode(message[2]).length > DHT_TEXT_BYTES || expires - issued > DHT_MESSAGE_TTL)) return;
    if (receipt !== null && (typeof receipt !== "string" || !ID.test(receipt))) return;
    await this.options.pin(author); this.options.credentials.peerKey = author; this.options.credentials.requireSignedSignals = true;
    // Store content before advancing anti-replay state. Retrying after a crash
    // is safe because the durable message table deduplicates the stable ID.
    let nextReceipt = this.state.receipt;
    if (message) {
      await this.options.message({ id: message[0], timestamp: message[1], text: message[2] });
      if (nextReceipt?.id !== message[0]) nextReceipt = { id: message[0], expires, attempts: 0 };
    }
    const confirmed = receipt && this.state.pending?.message[0] === receipt ? receipt : this.state.confirmed;
    if (mode !== this.state.peerMode) traceLink(this.from, "dht-peer-mode", { peerMode: mode });
    await this.persist({ ...this.state, peerSequence: sequence, peerMode: mode, peerRejected: undefined, receipt: nextReceipt, confirmed,
      pending: confirmed && this.state.pending?.message[0] === confirmed ? undefined : this.state.pending });
    if (confirmed) await this.options.receipt(confirmed);
    delete this.errors.peer;
    this.changed();
  }
  private async tick(): Promise<void> {
    if (!this.running) return;
    // A read asked for during one in flight happens right after it: its answer may predate the reason.
    if (this.ticking) { this.tickAgain = true; return; }
    this.ticking = true; this.tickAgain = false;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    try { await this.serialize(async () => {
      if (!this.running) return;
      try { const packet = await this.options.transport.resolve(this.peerAddress); if (!this.running) return; if (packet) await this.receive(packet); delete this.errors.read; }
      catch (error) { this.errors.read = `Could not read DHT delivery: ${error instanceof Error ? error.message : String(error)}`; }
      try { await this.publish(); }
      catch (error) { this.errors.publish = `Could not publish DHT delivery: ${error instanceof Error ? error.message : String(error)}`; }
      this.changed();
    });
    } finally { this.ticking = false; }
    if (!this.running) return;
    if (this.tickAgain) { void this.tick(); return; }
    const waiting = this.mode === "dht" || (this.state.peerMode === "dht" && Date.now() < this.fastUntil);
    this.timer = setTimeout(() => void this.tick(), this.options.pollMs ?? (waiting ? DHT_POLL_MS : STREAM_POLL_MS));
  }
}
