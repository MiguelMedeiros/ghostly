import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64Url, toBase64Url, utf8Encode } from "./bytes";
import { encrypt, sealedLength, tryDecrypt } from "./crypto";
import { identityFromSeed, identityFromSeedB64, publicKeyFromZ32, sign, verify, type Identity } from "./identity";
import type { LinkParams } from "./invite";
import type { PairingCredentials } from "./pairedSession";
import { measureRecords, MAX_DNS_PACKET_BYTES, type GhostRecord, type SignedPacket } from "./pkarr";
import { budgetRetryMs, isDiscoveryBudgetError, type PkarrRequestOptions, type PkarrTransport } from "./transport";
import { traceLink } from "./linkTrace";
import { REACTION_LIMITS, readDhtReactions, validReactionNumber, type WireReaction } from "./reactions";
import { readForwarded } from "./forwards";
import { validEditNumber } from "./pairedEdits";

export type DeliveryMode = "stream" | "dht";
export const DHT_TEXT_BYTES = 256;
export const DHT_MESSAGE_TTL = 5 * 60_000;
const CONTROL_TTL = 10 * 60_000;
const MAX_ATTEMPTS = 8;
/** The wait before publication attempt `attempts + 1` of a text, or of a receipt the contact still asks for. */
const backoff = (attempts: number) => Math.min(60_000, 4_000 * 2 ** attempts);
/** The contact's mailbox is read this often while either side is DHT-only, and otherwise… */
const DHT_POLL_MS = 4_000;
const STREAM_POLL_MS = 30_000;
/**
 * …except for this long after this side leaves DHT-only while the contact is still there: its own
 * switch then shows in seconds, not at the next 30 s read (both sides are blocked from a live link until
 * each has seen the other leave).
 */
export const LEAVING_DHT_FAST_MS = 2 * 60_000;
/**
 * Reads of a DHT-only contact's mailbox that go as signaling (`expect(ms, true)`) once something shows it leaving,
 * for as long as it still says DHT only. What shows it (a fresh packet on its link key, its offer) can reach this side
 * before the envelope saying so reaches the relays, and the first read then finds DHT only still. With the relays'
 * minute spent, every read after it was held back for 42 s, and the chat stayed "On DHT · retrying live" while its
 * contact had left (mx-d707d8d5, 2026-09-30). A few, not the whole window: the allowance they spend is also what this
 * side's offer and its reads for the answer go over the minute on (`SIGNALING_ALLOWANCE_SHARE` in relay.ts).
 */
export const LEAVING_SIGNAL_READS = 3;
/** Only this often while layer 1 carries the chat (WISP 403, Q7): the relays' per-IP budget is shared by every chat. */
export const LIVE_POLL_MS = 5 * 60_000;
/**
 * On the DHT with the chat open, the mailbox is read this often (WISP 403 proposes 4 s). The relays' per-IP budget
 * (30 requests a minute per relay here, reads and publishes together) is shared with presence polling, which is at its
 * fastest right then, while layer 1 is redialled; 4 s starved the publications of held items in the store-and-forward
 * e2e. A text of ours awaiting its receipt still reads at 4 s, and a drop reads once, at once.
 */
export const ACTIVE_DHT_POLL_MS = 10_000;
const ID = /^[A-Za-z0-9_-]{22}$/;
/** What a text may reply to over the DHT: a message, file or payment id of this chat (WISP 401 § Replies). */
const REPLY_TO = /^[A-Za-z0-9_-]{8,64}$/;
type Message = [id: string, timestamp: number, text: string];
/**
 * The ninth element, the author's capability-record revision (WISP 03), is optional; readers ignore
 * trailing elements they do not know. The signature covers all of them. The tenth is the pinned mailbox
 * (WISP 403, revision 0.3): `1`, the author can use it; `2`, the author knows the reader can too, and reads
 * there first. A ninth element then goes as `null` when there is no revision to name. The eleventh, with a text only,
 * is the id of the message it replies to (WISP 403 § Replies): the id alone, which the reader looks up in its history.
 * The twelfth is kept for an edit (WISP 403 § Edits). The thirteenth, the author's reactions the reader has not confirmed
 * yet, `[[id, emoji, n], …]`, oldest first and as many as fit; the fourteenth, the highest number of the reader's
 * reactions the author took (WISP 403 § Reactions). The eleventh and twelfth then go as `null` when there is no reply
 * and no edit. The fifteenth, with a text only, is how many times it has been forwarded (WISP 403 § Forwards); the
 * four before it then go as `null`, `null`, `[]` and `null` when they have nothing to say.
 */
type DhtReaction = [id: string, emoji: string, n: number];
type Body = [version: 1, sequence: number, issued: number, expires: number, author: string, mode: DeliveryMode, message: Message | null, receipt: string | null, capsRev?: number | null, pinnedMailbox?: 1 | 2, replyTo?: string | null, edit?: DhtEdit | null, reactions?: DhtReaction[], reactionsTaken?: number | null, forwarded?: number];
/** An envelope's plaintext past this is not read (`receive`): what rides along must stay under it. */
const MAX_ENVELOPE_PLAINTEXT = 900;
/**
 * Every envelope's records carry this TTL, whatever it holds (WISP 403 § What a mailbox shows): a text's TTL used to
 * count down from its five minutes while a keep-alive's said ten, so a look at the mailbox told a text was pending.
 * Readers never read it; relays cache for at least this long anyway.
 */
const ENVELOPE_TTL = 300;
/**
 * An envelope's packet, text or not, is padded to the largest plaintext that fits this. A few bytes under the DHT's
 * 1000: the Rust client splits TXT strings at 254 bytes, not 255, so the packet it builds can be a byte or two larger.
 */
const ENVELOPE_PACKET_BYTES = MAX_DNS_PACKET_BYTES - 8;
/**
 * The twelfth element, with a text only: the text is an edit (WISP 403 § Edits), the new text of the message with this id,
 * edit number `e`. The eleventh then goes as `null` when the text replies to nothing. An app from before edits would show
 * the text as a message of its own: it is sent only to a contact whose capability record lists `edit/1`.
 */
type DhtEdit = [id: string, e: number];
/**
 * Before the contact said it can use the pinned mailbox, the invite's mailbox is read. When that held a packet but
 * nothing from the contact (expired, or someone else's), the pinned one is looked in too, no more often than this:
 * the contact may have moved there while this side was away, and every read spends a relay request.
 */
const PINNED_PROBE_MS = 60_000;
export interface DhtDeliveryState {
  sequence: number;
  peerSequence: number;
  peerMode?: DeliveryMode;
  /**
   * How far the contact is in the pinned mailbox (WISP 403, revision 0.3), from its envelopes sealed to this side: it
   * `can` use it; it `reads` there first (it knows this side can); it was `seen` publishing there. This side reads
   * there first from `can` on and publishes there from `reads` on; from `seen` on it reads only there.
   */
  peerPinned?: "can" | "reads" | "seen";
  /** `reply`: the id of the message the text replies to, published with it (the eleventh element). */
  pending?: { message: Message; expires: number; attempts: number; next: number; reply?: string; edit?: DhtEdit; forwarded?: number };
  /**
   * The receipt this side owes for the contact's last text. `next`: when it forces a publication again (absent: at
   * once). `settled`: the contact's newer envelope no longer carries that text (it has a receipt, on either path, or
   * gave up on it), so the receipt only rides along on envelopes that go out anyway.
   */
  receipt?: { id: string; expires: number; attempts: number; next?: number; settled?: boolean };
  confirmed?: string;
  /** The highest number of the contact's reactions taken from its envelopes: said back in every envelope. */
  reactionsTaken?: number;
  /**
   * The contact's envelope, by its hint the pinned (or expected) key's, is sealed to another key: the contact paired with
   * someone else who used the same invite first. Kept until an envelope of the contact's newer than the last read opens.
   */
  inviteTaken?: true;
}
export interface DhtDeliveryView {
  mode: DeliveryMode;
  peerMode?: DeliveryMode;
  authenticated: boolean;
  error?: string;
  pendingUntil?: number;
  maxTextBytes: number;
  /** The envelope last published from here, for a text's details; absent until one carried a text. */
  lastPublished?: DhtPacketFacts;
  /**
   * When an envelope or a connection signal signed by a participation key other than the pinned one last came in
   * over one of the chat's invite-derived keys. Anyone holding a copy of the invite can publish there, so it is
   * ignored, never a reason to stop the chat: a passive warning only.
   */
  foreignKeySeenAt?: number;
  /** The invite was used by someone else first (`DhtDeliveryState.inviteTaken`): this side's texts reach nobody. */
  inviteTaken?: boolean;
}
/**
 * What can be said about one DHT envelope without opening it: which text it carried, its sequence and times, the
 * signed packet's size, the sealed record's nonce (the first 24 bytes of the record, never a key) and the address
 * it was published under. All of it travels in the clear on the DHT already.
 */
export interface DhtPacketFacts {
  /** The text's stable id, when the envelope carried one. */
  id?: string;
  seq: number;
  issued: number;
  expires: number;
  packetBytes: number;
  nonce: string;
  recordKey: string;
  records: string[];
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
  /** Until when this side, having left DHT-only, reads a contact still there at the fast pace. */
  private leavingUntil = 0;
  /** Until when the mailbox is read at the fast pace for any other reason (a drop, a first contact). */
  private fastUntil = 0;
  private live = false;
  private active = false;
  /** The next read was asked for (a refresh, a fresh packet of the contact): it is not a background one. */
  private urgent = false;
  /** Reads left that are signaling: the contact is leaving DHT only, and the live link waits on them (`expect`). */
  private signalReads = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The first control envelope of a start that waits (`firstControlAfterMs`). */
  private controlTimer: ReturnType<typeof setTimeout> | null = null;
  private chain = Promise.resolve();
  private lastPublish = 0;
  private controlDue = 0;
  /** Until when the relays' request budget holds publications back: what is due then goes at once. */
  private budgetUntil = 0;
  private errors: Partial<Record<"publish" | "read", string>> = {};
  private foreignKeySeenAt?: number;
  /** When the pinned mailbox was last looked in while the contact had not said it uses it. */
  private pinnedProbeAt = 0;
  private pinnedBoxes?: { peerKey: string; identity: Identity; peerAddress: string };
  private readonly identity;
  private readonly peerAddress: string;
  private readonly key: Uint8Array;
  private readonly from: string;
  private readonly to: string;
  private readonly participation;
  /** The capability-record revision the last envelope published here named. */
  private namedRev?: number;
  /** A reaction of this side waits to ride on an envelope, or the contact's reactions wait to be said taken. */
  private reactionsDue = false;
  constructor(private readonly options: {
    params: LinkParams; mode: DeliveryMode; state?: DhtDeliveryState;
    credentials: PairingCredentials; transport: PkarrTransport;
    save(state: DhtDeliveryState): Promise<void>;
    pin(key: string): Promise<void>;
    message(message: { id: string; text: string; timestamp: number; reply?: { i: string }; edit?: { i: string; e: number }; forwarded?: number }, packet: DhtPacketFacts): Promise<void>;
    receipt(id: string): Promise<void>;
    changed(view: DhtDeliveryView): void;
    /** This side's capability-record revision, told in every envelope (WISP 03). */
    capsRev?(): number | undefined;
    /** An envelope from the contact named this revision of its capability record. */
    peerCapsRev?(rev: number): void;
    /** Whether the contact's capability record accepts DHT text (`dht-text/1`); absent or unknown: it does. */
    peerAcceptsText?(): boolean;
    /** This side's reactions the contact has not confirmed, oldest first: they ride on the envelopes (WISP 403 § Reactions). */
    reactions?(): readonly WireReaction[];
    /** A reaction of the contact's, from an envelope, already checked. */
    reaction?(reaction: WireReaction): Promise<void>;
    /** The contact took this side's reactions up to number `n`. */
    reactionsTaken?(n: number): Promise<void>;
    pollMs?: number;
    /**
     * A chat already paired, started again: its first control envelope goes this long after the start, not in the
     * burst of an app coming back (bug hunt r7a). A text, a receipt, a new mode or a new capability revision still go at once.
     */
    firstControlAfterMs?: number;
  }) {
    // `peerRejected`, saved by apps before WISP 403 revision 0.3, stopped the chat for good on an envelope anyone
    // holding the invite could forge: it is dropped, not honoured.
    const { peerRejected: _peerRejected, ...state } = structuredClone(options.state ?? emptyDhtDeliveryState()) as DhtDeliveryState & { peerRejected?: boolean };
    this.state = state; this.mode = options.mode;
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
      error: Object.values(this.errors).join(". ") || undefined, pendingUntil: this.state.pending?.expires, maxTextBytes: DHT_TEXT_BYTES,
      ...(this.lastPublished && { lastPublished: this.lastPublished }), ...(this.foreignKeySeenAt && { foreignKeySeenAt: this.foreignKeySeenAt }),
      ...(this.state.inviteTaken && { inviteTaken: true }) };
  }
  /**
   * Something signed by a participation key other than the pinned one came in over the chat's invite-derived keys (this
   * mailbox, the link's signals, a connection to an endpoint whose address a copy of the invite could read): ignored,
   * and said in the view as a passive warning.
   */
  foreignKeySeen(path: "dht" | "signal" | "stream"): void {
    const first = !this.foreignKeySeenAt;
    this.foreignKeySeenAt = Date.now();
    traceLink(this.from, "foreign-key-ignored", { path });
    if (first) this.changed();
  }
  /**
   * The mailboxes once the contact is pinned (WISP 403, revision 0.3): derived from the secret only the two
   * participation keys share, so a copy of the invite can neither publish there nor overwrite the contact's texts.
   */
  private pinned(): { identity: Identity; peerAddress: string } | undefined {
    const peerKey = this.options.credentials.peerKey;
    if (!peerKey) return undefined;
    if (this.pinnedBoxes?.peerKey !== peerKey) {
      const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(this.participation.seed), ed25519.utils.toMontgomery(publicKeyFromZ32(peerKey)));
      const derive = (label: string) => hkdf(sha256, shared, this.key, utf8Encode(`ghostly-dht-pinned-mailbox/1:${label}`), 32);
      this.pinnedBoxes = { peerKey, identity: identityFromSeed(derive(this.from)), peerAddress: identityFromSeed(derive(this.to)).pubKeyZ32 };
    }
    return this.pinnedBoxes;
  }
  private lastPublished?: DhtPacketFacts;
  /** The sealed record's nonce is its first 24 bytes: 32 characters of base64. */
  private static facts(body: Body, records: GhostRecord[], key: string): DhtPacketFacts {
    return { ...(body[6] && { id: body[6][0] }), seq: body[1], issued: body[2], expires: body[3], packetBytes: measureRecords(key, records),
      nonce: records[0].value.slice(0, 32), recordKey: key, records: records.map(r => r.label) };
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
    const plaintext = JSON.stringify([body, signature]);
    const hint = recipient ? [{ label: "_dmk", value: encrypt(this.participation.pubKeyZ32, this.key), ttl: ENVELOPE_TTL }] : [];
    // The packet a plaintext of this many bytes makes: its size depends on the length alone.
    const fits = (bytes: number) => bytes <= MAX_ENVELOPE_PLAINTEXT &&
      measureRecords(this.identity.pubKeyZ32, [{ label: "_dm", value: "A".repeat(sealedLength(bytes)), ttl: ENVELOPE_TTL }, ...hint]) <= ENVELOPE_PACKET_BYTES;
    const bytes = utf8Encode(plaintext).length;
    if (!fits(bytes)) throw new Error("Text and authentication exceed the DHT packet budget. Shorten the message.");
    // Padded with spaces up to the largest that fits, so a keep-alive is as long as a text. JSON allows spaces after the
    // value: readers from before read the envelope as ever.
    let padded = bytes;
    for (let step = 512; step >= 1; step >>= 1) if (fits(padded + step)) padded += step;
    return [{ label: "_dm", value: encrypt(plaintext + " ".repeat(padded - bytes), recipient ? this.sealedKey(recipient) : this.key), ttl: ENVELOPE_TTL }, ...hint];
  }
  async start(): Promise<void> {
    if (this.running) return; this.running = true;
    const quiet = this.options.credentials.peerKey ? this.options.firstControlAfterMs ?? 0 : 0;
    if (quiet > 0) {
      this.controlDue = Math.max(this.controlDue, Date.now() + quiet);
      this.controlTimer = setTimeout(() => { this.controlTimer = null; void this.serialize(async () => { try { await this.publish(); } catch { /* the next tick */ } }); }, quiet);
    }
    if (this.state.confirmed) await this.options.receipt(this.state.confirmed);
    // A chat with no pinned contact is read at the signaling pace only once the contact shows up (`expect`, from its
    // fresh presence packet): an invite nobody opened yet, or one warmed ahead of time, spends no relay budget.
    this.changed(); void this.tick();
  }
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.controlTimer) clearTimeout(this.controlTimer);
    this.timer = this.controlTimer = null;
    await this.chain;
  }
  async setMode(mode: DeliveryMode): Promise<void> {
    await this.serialize(async () => {
      // Preserve accepted DHT intent, its stable ID and original expiry across mode changes.
      await this.persist({ ...this.state });
      // The contact learns the new method from the next envelope: it goes out now, not after the publish spacing.
      this.mode = mode; this.controlDue = 0; this.lastPublish = 0;
      this.leavingUntil = mode === "stream" ? Date.now() + LEAVING_DHT_FAST_MS : 0;
      // DHT only here: no live link waits on the contact leaving it.
      if (mode === "dht") this.signalReads = 0;
      this.changed();
    });
    void this.tick();
  }
  /** Reads the contact's mailbox now: something says it may have changed its delivery method. */
  refresh(): void { this.urgent = true; void this.tick(); }
  /**
   * Reads the contact's mailbox at the signaling pace for a while (a fresh packet of a contact not pinned yet).
   * `signal`: the contact is leaving DHT only (a fresh packet on its link key, or its offer), and the live link waits
   * on a read to say so: the next read goes now, and it and the next ones while the contact still says DHT only
   * (`LEAVING_SIGNAL_READS` in all) are signaling (`PkarrRequestOptions.signal`).
   */
  expect(ms = 2 * 60_000, signal = false): void {
    const until = Date.now() + ms;
    if (signal) this.signalReads = LEAVING_SIGNAL_READS;
    if (until <= this.fastUntil && !signal) return;
    this.fastUntil = Math.max(this.fastUntil, until); this.urgent = true; void this.tick();
  }
  /**
   * Layer 1 carries the chat, or no longer does. While it does, the mailbox is read every 5 minutes, after one
   * last look as it goes live: a text the contact put on the DHT in the seconds before (after this side's last
   * read) would otherwise wait for the next look. That look is a background request, which yields to links that
   * signal, and only for a contact that wrote in this mailbox already. The moment layer 1 is lost, at once
   * (WISP 403, poll pace), and then at the chat's pace.
   */
  setLive(live: boolean): void {
    if (live === this.live) return;
    this.live = live;
    if (!live) { this.urgent = true; void this.tick(); return; }
    this.fastUntil = 0; this.signalReads = 0;
    if (this.options.credentials.peerKey && this.state.peerMode) void this.tick(); else this.schedule();
  }
  get isLive(): boolean { return this.live; }
  /** The chat is open with the app in front: on the DHT, its mailbox is read at the signaling pace. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active && !this.live) void this.tick(); else this.schedule();
  }
  validate(text: string, timestamp: number, id: string, reply?: string, edit?: DhtEdit): string | null {
    // Every chat's first contact runs here too (WISP 403): before the pin the text is sealed with the invite key.
    if (this.options.peerAcceptsText?.() === false) return DHT_TEXT_REFUSED;
    if (!ID.test(id) || !Number.isSafeInteger(timestamp) || timestamp <= 0 || (reply !== undefined && !REPLY_TO.test(reply))) return "Invalid message.";
    if (edit !== undefined && (reply !== undefined || !ID.test(edit[0]) || !validEditNumber(edit[1]))) return "Invalid message.";
    if (utf8Encode(text).length > DHT_TEXT_BYTES) return `DHT text is limited to ${DHT_TEXT_BYTES} UTF-8 bytes. Shorten it or choose a live connection.`;
    if (/cashu[AB][A-Za-z0-9_-]+/i.test(text)) return "Payment tokens cannot be sent through DHT delivery.";
    const now = Date.now(), pending = this.state.pending;
    if (pending && pending.expires > now && pending.message[0] !== id) return "One DHT text can await a receipt at a time. Wait for its receipt or expiry before sending another.";
    if (pending?.message[0] === id && pending.expires > now && pending.attempts >= MAX_ATTEMPTS) return "DHT retry budget exhausted. Wait for expiry before retrying this message.";
    const next = pending?.message[0] === id && pending.expires > now ? pending : { message: [id, timestamp, text] as Message, expires: now + DHT_MESSAGE_TTL, attempts: 0, next: now, ...(reply && { reply }), ...(edit && { edit }) };
    // Validate the complete encrypted DNS packet before accepting local intent. A text near the bound goes without the
    // id of the message it replies to when both do not fit: the text is what matters. An edit never goes without its
    // element: it would read as a new message.
    const error = this.packetError(next.message, next.expires, next.reply, next.edit);
    return error && next.reply ? this.packetError(next.message, next.expires) : error;
  }
  private packetError(message: Message, expires: number, reply?: string, edit?: DhtEdit): string | null {
    try { this.records(this.body(this.state.sequence + 1, Date.now(), expires, message, this.state.receipt?.id ?? "abcdefghijklmnopqrstuv", reply, [], edit), this.options.credentials.peerKey ?? this.participation.pubKeyZ32); return null; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }
  /** Whether a text with its hop count fits the packet and what a reader reads (`MAX_ENVELOPE_PLAINTEXT`). */
  private roomForHops(message: Message, expires: number, reply: string | undefined, forwarded: number): boolean {
    const body = this.body(this.state.sequence + 1, Date.now(), expires, message, this.state.receipt?.id ?? "abcdefghijklmnopqrstuv", reply, [], undefined, forwarded);
    try { this.records(body, this.options.credentials.peerKey ?? this.participation.pubKeyZ32); } catch { return false; }
    return utf8Encode(JSON.stringify([body, "x".repeat(86)])).length <= MAX_ENVELOPE_PLAINTEXT;
  }
  /**
   * `forwarded`: a forwarded text's hop count (WISP 403 § Forwards). Like a reply's id it goes only when the packet has
   * room for it: the text is what matters, and it then reads as written here.
   */
  async send(text: string, timestamp: number, id: string, reply?: string, edit?: DhtEdit, forwarded?: number): Promise<string | null> {
    return this.serialize(async () => {
      const error = this.validate(text, timestamp, id, reply, edit);
      if (error) return error;
      const now = Date.now(), pending = this.state.pending;
      const hops = edit ? undefined : readForwarded(forwarded);
      let next = pending?.message[0] === id && pending.expires > now ? pending : { message: [id, timestamp, text] as Message, expires: now + DHT_MESSAGE_TTL, attempts: 0, next: now, ...(reply && { reply }), ...(edit && { edit }), ...(hops && { forwarded: hops }) };
      if (next.forwarded && !this.roomForHops(next.message, next.expires, next.reply, next.forwarded)) { const { forwarded: _dropped, ...alone } = next; next = alone; }
      if (next.reply && this.packetError(next.message, next.expires, next.reply)) { const { reply: _dropped, ...alone } = next; next = alone; }
      await this.persist({ ...this.state, pending: next }); this.changed();
      // The next read comes at the pace for a text awaiting its receipt.
      try { await this.publish(true); this.schedule(); return null; }
      catch (error) {
        // Held back by the relays' request budget: the text is queued and goes as soon as the budget frees a request.
        if (isDiscoveryBudgetError(error)) { this.schedule(); return null; }
        this.errors.publish = `DHT publication failed: ${String(error instanceof Error ? error.message : error)}. Bounded retry continues until expiry.`; this.changed(); return this.errors.publish;
      }
    });
  }
  /**
   * This side's capability record has a new revision (WISP 03): an envelope names it now. Otherwise the contact
   * learns of it with the next envelope that goes out anyway, a control one minutes away when nothing is sent,
   * and dials no native transport the record newly offers until then.
   */
  async announce(): Promise<void> {
    await this.serialize(async () => {
      // Every publication spends a relay request: none when the last envelope named this revision already.
      const rev = this.options.capsRev?.();
      if (rev === undefined || rev === this.namedRev) return;
      try { await this.publish(true); } catch { /* The next envelope names it. */ }
    });
  }
  /**
   * This side has reactions the contact has not confirmed (`reactions`): the next envelope carries them, and goes
   * as soon as the publication spacing allows.
   */
  async announceReactions(): Promise<void> {
    if (!this.options.reactions?.().length) return;
    this.reactionsDue = true;
    await this.serialize(async () => { try { await this.publish(); } catch { /* the next envelope carries them */ } });
    if (this.reactionsDue) this.schedule();
  }
  /** A stream receipt for the same stable ID also cancels DHT retransmission. */
  async acknowledge(id: string): Promise<void> {
    await this.serialize(async () => {
      if (this.state.pending?.message[0] === id) await this.persist({ ...this.state, pending: undefined, confirmed: id });
      this.changed();
    });
  }
  private body(sequence: number, issued: number, expires: number, message: Message | null, receipt: string | null, reply?: string, reactions: readonly WireReaction[] = [], edit?: DhtEdit, forwarded?: number): Body {
    const rev = this.options.capsRev?.();
    const body: Body = [1, sequence, issued, expires, this.participation.pubKeyZ32, this.mode, message, receipt];
    // Whether it has a revision to name or not, the ninth element holds the place of the tenth: this side uses the pinned mailbox.
    body.push(rev !== undefined && Number.isSafeInteger(rev) && rev >= 0 ? rev : null, this.state.peerPinned ? 2 : 1);
    const taken = this.state.reactionsTaken;
    const hops = message && !edit ? readForwarded(forwarded) : undefined;
    if (reactions.length || taken || hops) {
      body.push(message && reply ? reply : null, message && edit ? edit : null, reactions.map(r => [r.id, r.e, r.n] as DhtReaction), taken ?? null);
      if (hops) body.push(hops);
    }
    else {
      if (message && (reply || edit)) body.push(reply ?? null);
      if (message && edit) body.push(edit);
    }
    return body;
  }
  /**
   * The envelope with as many of this side's pending reactions as fit, oldest first: the packet's budget and what a
   * reader reads (`MAX_ENVELOPE_PLAINTEXT`) both bound it. The contact confirms up to the newest it carried.
   */
  private fitted(sequence: number, issued: number, expires: number, message: Message | null, receipt: string | null, reply?: string, edit?: DhtEdit, forwarded?: number): { body: Body; records: GhostRecord[]; reactions: number } {
    const pending = (this.options.reactions?.() ?? []).slice(0, REACTION_LIMITS.dht);
    for (let count = pending.length; count > 0; count--) {
      const body = this.body(sequence, issued, expires, message, receipt, reply, pending.slice(0, count), edit, forwarded);
      try {
        const records = this.records(body);
        if (utf8Encode(JSON.stringify([body, "x".repeat(86)])).length <= MAX_ENVELOPE_PLAINTEXT) return { body, records, reactions: count };
      } catch { /* one fewer */ }
    }
    const body = this.body(sequence, issued, expires, message, receipt, reply, [], edit, forwarded);
    return { body, records: this.records(body), reactions: 0 };
  }
  private async publish(force = false): Promise<void> {
    const now = Date.now();
    if (!this.running || (!force && (now - this.lastPublish < 4_000 || now < this.budgetUntil))) return;
    const pending = this.state.pending && this.state.pending.expires > now && this.state.pending.attempts < MAX_ATTEMPTS ? this.state.pending : undefined;
    const receipt = this.state.receipt && this.state.receipt.expires > now && this.state.receipt.attempts < MAX_ATTEMPTS ? this.state.receipt : undefined;
    // A receipt forces an envelope of its own only while the contact still asks for it, and with a text's backoff: the
    // envelope stays in the mailbox until the next one, and every publication spends a request on each relay.
    const receiptDue = !!receipt && !receipt.settled && (receipt.next ?? 0) <= now;
    if (!force && (!pending || pending.next > now) && !receiptDue && !this.reactionsDue && this.controlDue > now) return;
    const expires = pending?.expires ?? now + CONTROL_TTL;
    const { body, records, reactions } = this.fitted(this.state.sequence + 1, now, expires, pending?.message ?? null, receipt?.id ?? null, pending?.reply, pending?.edit, pending?.forwarded);
    const reactionsWereDue = this.reactionsDue;
    // A text that left no room: the reactions go on the next envelope. Once some went, the rest wait for the contact
    // to say those were taken (the engine announces the rest then).
    this.reactionsDue = !reactions && !!this.options.reactions?.().length;
    // In the pinned mailbox once the contact said it reads there; until then where an older app looks.
    const identity = (this.state.peerPinned && this.state.peerPinned !== "can" && this.pinned()?.identity) || this.identity;
    // Persist sequence and attempt count first. A crash cannot reuse them or
    // reset the retransmission budget/absolute message deadline.
    await this.persist({ ...this.state, sequence: body[1], pending: pending ? { ...pending, attempts: pending.attempts + 1, next: now + backoff(pending.attempts) } : this.state.pending,
      receipt: receipt ? { ...receipt, attempts: receipt.attempts + 1, next: now + backoff(receipt.attempts) } : this.state.receipt });
    const before = { lastPublish: this.lastPublish, controlDue: this.controlDue };
    this.lastPublish = now; this.controlDue = now + 4 * 60_000;
    traceLink(this.from, "dht-publish", { mode: this.mode, seq: body[1], ...(identity !== this.identity && { pinned: true }) });
    if (pending) this.lastPublished = DhtDelivery.facts(body, records, identity.pubKeyZ32);
    try { await this.options.transport.publish(identity, records); }
    catch (error) {
      this.reactionsDue ||= reactionsWereDue;
      if (isDiscoveryBudgetError(error)) await this.heldBack(error, now, before, pending, receipt);
      throw error;
    }
    this.namedRev = body[8] ?? undefined;
    delete this.errors.publish; this.changed();
  }
  /**
   * The relays' request budget held the envelope back: nothing went out, so it was no attempt (a text keeps its eight),
   * and what it carried (a text, a receipt, a new mode) goes the moment the budget frees a request: the text and the
   * receipt as they were before, and no publication before then (`budgetUntil`) but a forced one.
   */
  private async heldBack(error: Parameters<typeof budgetRetryMs>[0], now: number, before: { lastPublish: number; controlDue: number },
    pending: DhtDeliveryState["pending"], receipt: DhtDeliveryState["receipt"]): Promise<void> {
    const at = now + budgetRetryMs(error, 1_000, 60_000);
    this.budgetUntil = at;
    this.lastPublish = before.lastPublish; this.controlDue = Math.min(before.controlDue, at);
    traceLink(this.from, "dht-publish-waits", { retryInMs: at - now });
    await this.persist({ ...this.state, pending: pending ?? this.state.pending, receipt: receipt ?? this.state.receipt });
  }
  /**
   * One packet from one of the contact's mailboxes, opened and checked the way `receive` takes it: the right address,
   * one sealed record, a well-formed body within its times, signed by the key it names. Null: not an envelope of the
   * contact's (the pin rules are the caller's).
   */
  private open(packet: SignedPacket, box: "invite" | "pinned") {
    const address = box === "pinned" ? this.pinned()?.peerAddress : this.peerAddress;
    if (!address || packet.pubKeyZ32 !== address || measureRecords(packet.pubKeyZ32, packet.records) > MAX_DNS_PACKET_BYTES) return null;
    const records = packet.records.filter(r => r.label === "_dm"); if (records.length !== 1) return null;
    const hints = packet.records.filter(r => r.label === "_dmk"); if (hints.length > 1) return null;
    const sender = hints.length ? tryDecrypt(hints[0].value, this.key) : null;
    if (hints.length && !sender) return null;
    let plaintext: string | null;
    try { plaintext = tryDecrypt(records[0].value, sender ? this.sealedKey(sender) : this.key); } catch { plaintext = null; }
    // Sealed, by its hint, from `sender` to a key other than this side's: nothing to read, but who it names says something.
    if (!plaintext && sender) return { sealedToAnother: sender };
    if (!plaintext || utf8Encode(plaintext).length > MAX_ENVELOPE_PLAINTEXT) return null;
    let envelope: unknown; try { envelope = JSON.parse(plaintext); } catch { return null; }
    if (!Array.isArray(envelope) || envelope.length !== 2 || !Array.isArray(envelope[0])) return null;
    const [body, signature] = envelope as [Body, string];
    const [version, sequence, issued, expires, author, mode, message, receipt, capsRev, pinnedMailbox, replyTo, editOf, reactions, reactionsTaken, forwarded] = body;
    const now = Date.now();
    if (body.length < 8 || body.length > 16 || version !== 1 || !Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(issued) ||
      !Number.isSafeInteger(expires) || issued > now + 30_000 || expires <= now || expires - issued > CONTROL_TTL || issued >= expires ||
      (mode !== "stream" && mode !== "dht") || typeof author !== "string" || typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return null;
    if (sender && sender !== author) return null;
    try {
      if (!verify(fromBase64Url(signature), utf8Encode(JSON.stringify(["ghostly-dht-envelope", this.to, this.from, sender ? this.participation.pubKeyZ32 : "invite", body])), publicKeyFromZ32(author))) return null;
    } catch { return null; }
    return { body, sender, author, sequence, issued, expires, mode, message, receipt, capsRev, pinnedMailbox, replyTo, editOf, reactions, reactionsTaken, forwarded };
  }
  /**
   * The contact's envelope is sealed to another key (`open`): it pinned someone else who used the same invite first, so
   * nothing of this side's will ever be read. Said once this side is not proven the one it pinned (never seen in the
   * pinned mailbox, no text confirmed, never live). The hint is sealed under the invite's key, which any copy of it
   * holds: a passive warning, taken back by the contact's next envelope that opens here.
   */
  private async sealedToAnother(sender: string): Promise<void> {
    const expected = this.options.credentials.peerKey ?? this.options.credentials.expectedPeerKey;
    if (this.state.inviteTaken || !expected || sender !== expected) return;
    if (this.state.peerPinned === "seen" || this.state.confirmed || this.live) return;
    traceLink(this.from, "invite-taken", {});
    await this.persist({ ...this.state, inviteTaken: true });
    this.changed();
  }
  /**
   * One packet from one of the contact's two mailboxes: `invite` (derived from the invite, which anyone holding a copy
   * can write to) or `pinned`. `none`: nothing from the contact in it; `old`: the contact's, already read; `new`: taken.
   */
  private async receive(packet: SignedPacket, box: "invite" | "pinned"): Promise<"none" | "old" | "new"> {
    const opened = this.open(packet, box);
    if (!opened) return "none";
    if ("sealedToAnother" in opened) { if (opened.sealedToAnother) await this.sealedToAnother(opened.sealedToAnother); return "none"; }
    const { body, sender, author, sequence, issued, expires, mode, message, receipt, capsRev, pinnedMailbox, replyTo, editOf, reactions, reactionsTaken, forwarded } = opened;
    // Before the pin, the key the invite named: another invite holder's envelope is refused, and not remembered,
    // since whoever holds a copy can write to this mailbox and the inviter's next envelope replaces it.
    if (!this.options.credentials.peerKey && this.options.credentials.expectedPeerKey && this.options.credentials.expectedPeerKey !== author) return "none";
    // After it, the same: this mailbox's key comes from the invite, so another key signing here proves only that someone
    // holds a copy of it. Ignored, never a reason to stop the chat; a key change is proven only on a stream (WISP 400).
    if (this.options.credentials.peerKey && this.options.credentials.peerKey !== author) { this.foreignKeySeen("dht"); return "none"; }
    // How far the contact is in the pinned mailbox: only an envelope sealed to this side says it (the contact pinned this
    // side, so it can derive the mailbox), and it only goes forward.
    const peerPinned = box === "pinned" ? "seen" : !sender ? this.state.peerPinned
      : pinnedMailbox === 2 && this.state.peerPinned !== "seen" ? "reads" : this.state.peerPinned ?? (pinnedMailbox === 1 ? "can" : undefined);
    if (sequence <= this.state.peerSequence) {
      if (peerPinned !== this.state.peerPinned && this.options.credentials.peerKey) {
        await this.persist({ ...this.state, peerPinned }); traceLink(this.from, "dht-peer-pinned", { peerPinned }); this.changed();
      }
      return "old";
    }
    if (message !== null && (!Array.isArray(message) || message.length !== 3 || typeof message[0] !== "string" || !ID.test(message[0]) || !Number.isSafeInteger(message[1]) || message[1] <= 0 || message[1] > issued + 30_000 ||
      typeof message[2] !== "string" || utf8Encode(message[2]).length > DHT_TEXT_BYTES || expires - issued > DHT_MESSAGE_TTL)) return "none";
    if (receipt !== null && (typeof receipt !== "string" || !ID.test(receipt))) return "none";
    await this.options.pin(author); this.options.credentials.peerKey = author; this.options.credentials.requireSignedSignals = true;
    // Store content before advancing anti-replay state. Retrying after a crash
    // is safe because the durable message table deduplicates the stable ID.
    let nextReceipt = this.state.receipt;
    if (message) {
      // The text this side owes a receipt for was stored already (the receipt is saved only after it): a retransmission
      // that crossed the receipt, or the same envelope moved to the pinned mailbox, is not handed over twice.
      // A reply's id that is not one is dropped, never the text (readers from before ignore the element).
      const reply = typeof replyTo === "string" && REPLY_TO.test(replyTo) ? { reply: { i: replyTo } } : {};
      // An edit's element that is not one leaves a text of its own, as an app from before edits reads it.
      const edit = Array.isArray(editOf) && editOf.length === 2 && typeof editOf[0] === "string" && ID.test(editOf[0]) && validEditNumber(editOf[1]) ? { edit: { i: editOf[0], e: editOf[1] } } : {};
      // A hop count that is not one, or one on an edit, is dropped: the text reads as written here.
      const hops = edit.edit ? undefined : readForwarded(forwarded);
      if (nextReceipt?.id !== message[0]) await this.options.message({ id: message[0], timestamp: message[1], text: message[2], ...reply, ...edit, ...(hops && { forwarded: hops }) }, DhtDelivery.facts(body, packet.records, packet.pubKeyZ32));
      if (nextReceipt?.id !== message[0]) nextReceipt = { id: message[0], expires, attempts: 0 };
      // Asked for again (the text sent anew after a lost session): its receipt goes at once again.
      else if (nextReceipt.settled) { const { settled: _settled, next: _next, ...asked } = nextReceipt; nextReceipt = asked; }
    } else if (nextReceipt && !nextReceipt.settled) nextReceipt = { ...nextReceipt, settled: true };
    // The contact's reactions, each checked on its own (what does not hold is skipped, never the envelope), and the
    // highest number taken, which every envelope of this side says back; one carrying only what was taken asks again.
    const theirs = this.options.reaction ? readDhtReactions(reactions) : [];
    for (const reaction of theirs) await this.options.reaction?.(reaction);
    const newest = theirs.reduce((max, r) => Math.max(max, r.n), 0);
    if (theirs.length) this.reactionsDue = true;
    const confirmed = receipt && this.state.pending?.message[0] === receipt ? receipt : this.state.confirmed;
    if (mode !== this.state.peerMode) traceLink(this.from, "dht-peer-mode", { peerMode: mode });
    if (peerPinned !== this.state.peerPinned) traceLink(this.from, "dht-peer-pinned", { peerPinned });
    // A newer envelope of the contact's that opens here: whatever said the invite was taken was not the contact.
    if (this.state.inviteTaken) traceLink(this.from, "invite-untaken", {});
    const { inviteTaken: _taken, ...kept } = this.state;
    await this.persist({ ...kept, peerSequence: sequence, peerMode: mode, receipt: nextReceipt, confirmed, ...(peerPinned && { peerPinned }),
      pending: confirmed && this.state.pending?.message[0] === confirmed ? undefined : this.state.pending,
      ...(newest > (this.state.reactionsTaken ?? 0) && { reactionsTaken: newest }) });
    if (confirmed) await this.options.receipt(confirmed);
    if (validReactionNumber(reactionsTaken)) await this.options.reactionsTaken?.(reactionsTaken);
    if (Number.isSafeInteger(capsRev) && (capsRev as number) >= 0) this.options.peerCapsRev?.(capsRev as number);
    this.changed();
    return "new";
  }
  /**
   * Reads the contact's mailbox: the pinned one first once the contact said it can use it, the invite's otherwise. The
   * other is read too when the first held nothing from the contact (the contact publishes in the other one still, or a
   * copy of the invite overwrote this one), or when the contact just said it can use the pinned one. Once the contact's
   * envelope was seen in the pinned mailbox, the invite's is not read any more.
   */
  private async read(background: boolean, signal = false): Promise<void> {
    const pinned = this.pinned(), options = signal ? { signal } : background ? { background } : undefined;
    const before = this.state.peerPinned;
    const boxes: ("invite" | "pinned")[] = !pinned ? ["invite"] : before === "seen" ? ["pinned"] : before ? ["pinned", "invite"] : ["invite", "pinned"];
    let found: SignedPacket | null = null;
    for (const [i, box] of boxes.entries()) {
      if (i > 0 && box === "pinned") {
        // The contact just said it can use it: looked in at once. Otherwise a probe, when the invite's mailbox held a
        // packet but nothing from the contact, now and then.
        if (!this.state.peerPinned && (!found || Date.now() - this.pinnedProbeAt < PINNED_PROBE_MS)) return;
        if (!this.state.peerPinned) this.pinnedProbeAt = Date.now();
      }
      const packet = found = await this.options.transport.resolve(box === "pinned" ? pinned!.peerAddress : this.peerAddress, options);
      if (!this.running) return;
      const got = packet ? await this.receive(packet, box) : "none";
      if (got !== "none" && !(box === "invite" && !before && this.state.peerPinned)) return;
    }
  }
  /**
   * A look at this chat from another profile of the device while this one is not running (WISP 04 § Checking other
   * profiles): the mailbox the chat reads first, opened and checked as `receive` does, with nothing saved, pinned or
   * published. It tells only whether the contact's envelope carries a text this side has not taken yet, and that text's
   * id; the words are dropped unread. `reads`: requests spent. Null `text`: nothing new, or nothing of the contact's.
   */
  async peek(options?: PkarrRequestOptions): Promise<{ reads: number; text: string | null }> {
    const expected = this.options.credentials.peerKey ?? this.options.credentials.expectedPeerKey;
    if (!expected) return { reads: 0, text: null };
    const pinned = this.pinned(), before = this.state.peerPinned;
    const boxes: ("invite" | "pinned")[] = !pinned || !before ? ["invite"] : before === "seen" ? ["pinned"] : ["pinned", "invite"];
    let reads = 0;
    for (const box of boxes) {
      const packet = await this.options.transport.resolve(box === "pinned" ? pinned!.peerAddress : this.peerAddress, options);
      reads++;
      const opened = packet && this.open(packet, box);
      if (!opened || "sealedToAnother" in opened || opened.author !== expected) continue;
      const { sequence, message } = opened;
      const fresh = Array.isArray(message) && typeof message[0] === "string" && ID.test(message[0]) && sequence > this.state.peerSequence && this.state.receipt?.id !== message[0];
      return { reads, text: fresh ? message[0] : null };
    }
    return { reads, text: null };
  }
  private async tick(): Promise<void> {
    if (!this.running) return;
    // A read asked for during one in flight happens right after it: its answer may predate the reason.
    if (this.ticking) { this.tickAgain = true; return; }
    this.ticking = true; this.tickAgain = false;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    try { await this.serialize(async () => {
      if (!this.running) return;
      // Only the slow, periodic looks (every 5 minutes while live, every 30 s for a chat in the background) are
      // background requests, served from the relays' background share; a chat on screen, a first contact, DHT
      // only, a drop or a text awaiting its receipt reads as signaling. The share also carries held items'
      // pointers, which a busy mailbox must not starve.
      const background = !this.urgent && this.pollMs >= STREAM_POLL_MS;
      const signal = this.signalReads > 0;
      this.urgent = false; if (signal) this.signalReads--;
      // A read or a publication the relays' request budget held back is a wait, not an error: it goes when the budget frees.
      try { await this.read(background, signal); if (!this.running) return; delete this.errors.read; }
      catch (error) { if (!isDiscoveryBudgetError(error)) this.errors.read = `Could not read DHT delivery: ${error instanceof Error ? error.message : String(error)}`; }
      // The contact says it left DHT only: nothing waits on its mailbox any more.
      if (this.state.peerMode !== "dht") this.signalReads = 0;
      try { await this.publish(); }
      catch (error) { if (!isDiscoveryBudgetError(error)) this.errors.publish = `Could not publish DHT delivery: ${error instanceof Error ? error.message : String(error)}`; }
      this.changed();
    });
    } finally { this.ticking = false; }
    if (!this.running) return;
    if (this.tickAgain) { void this.tick(); return; }
    this.schedule();
  }
  /** How long until the next read of the contact's mailbox (WISP 403, poll pace). */
  get pollMs(): number {
    if (this.options.pollMs) return this.options.pollMs;
    const now = Date.now();
    if (this.mode === "dht" || (this.state.peerMode === "dht" && now < this.leavingUntil) || now < this.fastUntil) return DHT_POLL_MS;
    if (this.live) return LIVE_POLL_MS;
    // Our text awaits its receipt: the receipt is what the person is looking at.
    if (this.state.pending && this.state.pending.expires > now) return DHT_POLL_MS;
    return this.active ? ACTIVE_DHT_POLL_MS : STREAM_POLL_MS;
  }
  private schedule(): void {
    if (!this.running || this.ticking) return;
    if (this.timer) clearTimeout(this.timer);
    // A publication the budget held back goes when the budget frees a request, if that comes before the next read.
    const held = this.budgetUntil - Date.now();
    // Reactions to carry, or to say taken, go once the publication spacing allows, not at the next read.
    const due = this.reactionsDue ? Math.max(0, this.lastPublish + 4_000 - Date.now()) : Infinity;
    this.timer = setTimeout(() => void this.tick(), Math.min(held > 0 ? Math.min(this.pollMs, held) : this.pollMs, due));
  }
}
export const DHT_TEXT_REFUSED = "Your contact's app does not accept text over the DHT. It is sent when you are live.";

/**
 * `DhtDelivery.peek` for a chat of a profile that is not running: built from what that profile stored, with every
 * callback a no-op that refuses to save, so the look can change nothing.
 */
export function peekDhtMailbox(options: { params: LinkParams; credentials: PairingCredentials; state?: DhtDeliveryState; transport: PkarrTransport; background?: boolean }): Promise<{ reads: number; text: string | null }> {
  const refuse = async () => { throw new Error("A peek saves nothing"); };
  const delivery = new DhtDelivery({ params: options.params, mode: "stream", state: options.state, credentials: { ...options.credentials }, transport: options.transport,
    save: refuse, pin: refuse, message: refuse, receipt: refuse, changed: () => {} });
  return delivery.peek(options.background ? { background: true } : undefined);
}
