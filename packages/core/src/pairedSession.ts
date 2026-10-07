import { PROOF_ADAPTERS, proofCapability, type ProofAdapter } from "./peerProofs";
import { IDENTITY_PROOF_CAPABILITY } from "./identityProofs";
import { HOLD_CAPABILITY } from "./storeForward";
import { fromBase64Url, randomBytes, toBase64Url, toZ32, utf8Encode } from "./bytes";
import { identityFromSeedB64, publicKeyFromZ32, sign, verify } from "./identity";
import type { FrameChannel } from "./frames";
import { rankTransports, type PairedTransport, type NativeBinding } from "./pairedTransports";
import type { Signer } from "./signer";

/** Experimental, opt-in profile. Ed25519 authenticates a transcript bound to WebRTC DTLS.
 * This is not a new cipher/key exchange, nor an audited WISP Final profile. */
export const PAIRED_PROFILE = "paired-chat/1" as const;
export interface PairingState {
  transport?: PairedTransport;
  preferred?: PairedTransport;
  status: "connecting" | "negotiating" | "confirm" | "waiting" | "ready" | "error";
  code?: string;
  error?: string;
  peerKey?: string;
  verified?: boolean;
  peerNeedsConfirmation?: boolean;
  keyMismatch?: boolean;
  transitionTarget?: PairedTransport;
  transitionError?: string;
}
export interface PairingCredentials {
  /** This side's participation seed. Not read when `signer` is given (a device link passes an empty one). */
  seedB64: string;
  /**
   * Signs in place of the seed (WISP 06 § Terms): a device link's participation key is the device signing key, which
   * the app may hold no seed for. The session then names `signer.publicKey` as its key and signs its transcript
   * through it. Absent, as in every chat and group: the seed signs, exactly as before.
   */
  signer?: Signer;
  peerKey?: string;
  requireSignedSignals?: boolean;
  verifiedPeerKey?: string;
  /**
   * The key the invite named (a `ghostly1` code carries the inviter's): before
   * anything is pinned, an answer signed by any other key is a security rejection.
   */
  expectedPeerKey?: string;
}
interface Offer {
  t: "pair-offer";
  versions: number[];
  transports: string[];
  capabilities: string[];
  /** Absent in apps that do not send it; see `OFFER_EXTENSIONS`. */
  extensions?: string[];
  key: string;
  nonce: string;
}
export interface PairedSessionOptions {
  credentials: PairingCredentials;
  rendezvousKeys: [string, string];
  /** SHA-256 certificate fingerprints extracted from this exact RTCPeerConnection. */
  fingerprints?: [string, string];
  binding?: NativeBinding;
  transports?: PairedTransport[];
  allowFallback?: boolean;
  proofSupport?: boolean;
  /** Identity proofs (WISP 300): `identity-proof/1`. */
  identitySupport?: boolean;
  filesSupport?: boolean;
  paymentsSupport?: boolean;
  /** Ecash straight in the chat. Absent means allowed, as before ways of paying could be chosen per chat. */
  cashuPaymentsSupport?: boolean;
  /** Lightning invoices in the chat. Absent means allowed. */
  lightningPaymentsSupport?: boolean;
  arkPaymentsSupport?: boolean;
  usdtPaymentsSupport?: boolean;
  barkPaymentsSupport?: boolean;
  transportSwitchSupport?: boolean;
  /** Store-and-forward for an away contact (`hold/1`): this device accepts held items and may hold some. */
  holdSupport?: boolean;
  /** TOFU admission is distinct from an optional human comparison. */
  trustOnFirstUse?: boolean;
  /**
   * How long the peer has to authenticate before the session fails: three minutes by default, room for a person to
   * compare codes. A connection that holds a place no person waits on (one dialled in on a pinned chat) gets less.
   */
  authTimeoutMs?: number;
  verifyPeer?: (key: string) => Promise<void>;
  /** Atomic durable compare-and-set. Resolving means the key is pinned on disk. */
  pinPeer: (key: string, signedSignals?: boolean) => Promise<void>;
  onState: (state: PairingState) => void;
  onReady: () => void;
  onApplication: (data: string | Uint8Array) => void | Promise<void>;
  onFailure: () => void;
}

/** The ways of paying a chat can allow one by one. */
/**
 * `bitcoin` (on-chain), `fedimint` and `spark` are never offered in the handshake: a full offer is already at the 16
 * capabilities apps before 0.5 accept. Both sides allow them only through the `paired-payments` list of the open
 * session.
 */
export type PaymentMethodName = "cashu" | "lightning" | "arkade" | "usdt" | "bark" | "bitcoin" | "fedimint" | "spark";

/**
 * What this app does that grants nothing, said outside `capabilities`: apps before 0.5 accept at most 16
 * of those, and a full offer is already there. The field is not in the transcript (an app that does not
 * know it could not sign it), so nothing that needs authenticating may go here; the DTLS binding of the
 * transcript still ties it to this connection. `ping/1`: this app answers `paired-ping`, from the open.
 */
const OFFER_EXTENSIONS = ["ping/1"];

const MAX_HANDSHAKE_BYTES = 4096;
/** One frame from the peer, at most (UTF-16 units for text, bytes for binary): a bigger one breaks the protocol. */
export const SESSION_FRAME_MAX = 60 * 1024;
/**
 * Frames received and not handled yet, at most: their count and their size together. Frames are handled one at a time,
 * each awaited (a group frame is decrypted, checked and stored before the next), and the peer sends at the network's
 * pace. A member back in a group answers a sync with a burst: a commit per epoch, its kept messages, the ones it hands
 * on, edits, reactions. With a bound of 64 frames a phone handling them a few milliseconds each failed its session
 * mid catch-up ("Session receive limit exceeded", 2026-10-07). The size bound keeps the old worst case in memory
 * (64 frames of 60 KiB); the count only bounds a flood of tiny frames.
 */
export const SESSION_RECEIVE_PENDING = { frames: 1024, bytes: 64 * SESSION_FRAME_MAX } as const;
const KEY = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const isList = (v: unknown, maximum = 8): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= maximum &&
  v.every(x => typeof x === "string" && /^[a-z0-9/-]{1,40}$/.test(x)) && new Set(v).size === v.length;

function parseOffer(v: Record<string, unknown>): Offer | null {
  if (!Array.isArray(v.versions) || v.versions.length === 0 || v.versions.length > 8 ||
    !v.versions.every(n => Number.isSafeInteger(n) && n > 0) || new Set(v.versions).size !== v.versions.length ||
    !isList(v.transports) || !isList(v.capabilities, 32) || typeof v.key !== "string" || !KEY.test(v.key) ||
    typeof v.nonce !== "string" || !NONCE.test(v.nonce)) return null;
  // Optional and new: one this app cannot read counts as none said, rather than failing the offer.
  const extensions = isList(v.extensions, 32) ? v.extensions : undefined;
  return { t: "pair-offer", versions: v.versions, transports: v.transports, capabilities: v.capabilities, ...(extensions && { extensions }), key: v.key, nonce: v.nonce };
}
const offerTuple = (o: Offer) => [o.key, o.nonce, o.versions, o.transports, o.capabilities];

export class PairedSession {
  state: PairingState = { status: "negotiating" };
  /** The peer said nothing more within `authTimeoutMs`: the connection carried nothing, which proves nothing about the peer. */
  authTimedOut = false;
  /**
   * The peer sent faster than this side handles, past `SESSION_RECEIVE_PENDING`: the session ends, which is no proof
   * of anything wrong with the peer (a burst of catch-up on a slow device), so the chat dials again.
   */
  overloaded = false;
  /** The seed's identity; null when a signer signs. */
  private readonly identity;
  private readonly signer?: Signer;
  private readonly offer: Offer;
  private readonly transport: PairedTransport;
  private preferred?: PairedTransport;
  private peer: Offer | null = null;
  private transcript: Uint8Array | null = null;
  private digest = "";
  private proofReceived = false;
  private localReady = false;
  private peerReady = false;
  private stopped = false;
  private confirming = false;
  private admission: Promise<void> | null = null;
  private pending = 0;
  private pendingBytes = 0;
  private queue = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private channel: FrameChannel, private options: PairedSessionOptions) {
    this.signer = options.credentials.signer;
    this.identity = this.signer ? null : identityFromSeedB64(options.credentials.seedB64);
    this.transport = options.binding?.transport ?? "webrtc/1";
    this.offer = { t: "pair-offer", versions: [1], transports: options.transports ?? [this.transport], capabilities: ["chat/1", "signed-signal/1", ...(options.trustOnFirstUse ? ["tofu/1"] : []), ...(options.filesSupport ? ["files/2"] : []), ...(options.paymentsSupport && (options.cashuPaymentsSupport !== false || options.lightningPaymentsSupport !== false) ? ["payments/1"] : []), ...(options.paymentsSupport && options.cashuPaymentsSupport !== false ? ["payments-cashu/1"] : []), ...(options.paymentsSupport && options.lightningPaymentsSupport !== false ? ["payments-lightning/1"] : []), ...(options.arkPaymentsSupport && options.paymentsSupport ? ["payments-arkade/1"] : []), ...(options.usdtPaymentsSupport && options.paymentsSupport ? ["payments-usdt/1"] : []), ...(options.barkPaymentsSupport && options.paymentsSupport ? ["payments-bark/1"] : []), ...(options.transportSwitchSupport ? ["transport-switch/1"] : []), ...(options.holdSupport ? [HOLD_CAPABILITY] : []), ...(options.proofSupport ? PROOF_ADAPTERS.map(proofCapability) : []), ...(options.identitySupport ? [IDENTITY_PROOF_CAPABILITY] : []), ...(options.allowFallback ? ["transport-fallback/1"] : [])],
      extensions: OFFER_EXTENSIONS, key: this.identity ? this.identity.pubKeyZ32 : toZ32(this.signer!.publicKey), nonce: toBase64Url(randomBytes(32)) };
  }

  supports(capability: "files/2" | "payments/1" | "payments-arkade/1" | "payments-usdt/1" | "payments-bark/1" | typeof HOLD_CAPABILITY): boolean { return this.state.status === "ready" && this.offer.capabilities.includes(capability) && !!this.peer?.capabilities.includes(capability); }
  /**
   * Both sides allow this way of paying. A peer that offers payments/1 without naming Cashu or
   * Lightning predates choosing them per chat, and allows both.
   */
  allowsPayment(method: PaymentMethodName): boolean {
    return this.state.status === "ready" && this.offer.capabilities.includes(`payments-${method}/1`) && this.peerAllowsPayment(method);
  }
  /** The peer's offer alone allows this way of paying. */
  peerAllowsPayment(method: PaymentMethodName): boolean {
    if (this.state.status !== "ready" || !this.peer) return false;
    const theirs = this.peer.capabilities, capability = `payments-${method}/1`;
    if (method === "arkade" || method === "usdt" || method === "bark" || method === "bitcoin" || method === "fedimint" || method === "spark") return theirs.includes(capability);
    const other = method === "cashu" ? "payments-lightning/1" : "payments-cashu/1";
    return theirs.includes("payments/1") && (theirs.includes(capability) || !theirs.includes(other));
  }
  get peerTransportSwitchSupport(): boolean { return !!this.peer?.capabilities.includes("transport-switch/1"); }
  /** The peer's offer alone carries `hold/1`: it accepts held items from us, whatever we offered. */
  get peerHoldSupport(): boolean { return !!this.peer?.capabilities.includes(HOLD_CAPABILITY); }

  get proofSession(): string { return this.digest; }
  get peerProofAdapters(): ProofAdapter[] { return PROOF_ADAPTERS.filter(a => this.offer.capabilities.includes(proofCapability(a)) && this.peer?.capabilities.includes(proofCapability(a))); }
  get peerProofSupport(): boolean { return this.peerProofAdapters.length > 0; }
  /** Both offers carry `identity-proof/1`. */
  get identitySupport(): boolean { return this.state.status === "ready" && this.offer.capabilities.includes(IDENTITY_PROOF_CAPABILITY) && !!this.peer?.capabilities.includes(IDENTITY_PROOF_CAPABILITY); }
  get peerTransports(): readonly string[] { return this.peer?.transports ?? []; }
  /** The peer said in its offer that it answers pings, so its silence from the open means it stopped. */
  get peerAnswersPings(): boolean { return !!this.peer?.extensions?.includes("ping/1"); }
  get peerAllowsFallback(): boolean { return this.peer?.capabilities.includes("transport-fallback/1") ?? false; }

  start(): void {
    const binding = this.options.binding;
    const validBinding = binding
      ? (binding.transport === "hyperdht/1" ? /^[a-f0-9]{128}$/.test(binding.context) : FINGERPRINT.test(binding.context)) && binding.identities.length === 2 && binding.identities.every(k => FINGERPRINT.test(k)) && binding.identities[0] !== binding.identities[1]
      : this.options.fingerprints?.length === 2 && this.options.fingerprints.every(f => FINGERPRINT.test(f));
    if (!validBinding || !this.offer.transports.includes(this.transport) ||
      this.options.rendezvousKeys.some(k => !KEY.test(k))) return this.fail("Invalid connection binding or unavailable transport");
    this.channel.onMessage = data => {
      if (this.stopped) return;
      const size = data.length;
      if (size > SESSION_FRAME_MAX) return this.fail("Session receive limit exceeded");
      if (++this.pending > SESSION_RECEIVE_PENDING.frames || (this.pendingBytes += size) > SESSION_RECEIVE_PENDING.bytes) {
        this.overloaded = true;
        return this.fail("Session receive limit exceeded");
      }
      this.queue = this.queue.then(async () => {
        if (this.stopped) return;
        if (typeof data === "string" && data.startsWith('{"t":"pair-')) {
          if (data.length > MAX_HANDSHAKE_BYTES) return this.fail("Negotiation message too large");
          await this.receive(data);
        } else if (this.state.status === "ready") await this.options.onApplication(data);
      }).catch(() => this.fail("Invalid session negotiation"))
        .finally(() => { this.pending--; this.pendingBytes -= size; });
    };
    this.timer = setTimeout(() => { this.authTimedOut = true; this.fail("The peer did not finish authentication. Reconnect to try again."); }, this.options.authTimeoutMs ?? 180_000);
    this.update({ status: "negotiating" });
    this.send(this.offer);
  }

  private send(frame: object): void {
    if (!this.stopped) this.channel.send(JSON.stringify(frame));
  }

  private async receive(text: string): Promise<void> {
    if (this.stopped) return;
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw.t === "pair-offer") {
      const peer = parseOffer(raw);
      if (!peer || peer.key === this.offer.key) return this.fail("Invalid participation key or offer");
      if (this.peer) {
        if (JSON.stringify(peer) !== JSON.stringify(this.peer)) this.fail("The peer changed its negotiation offer");
        return;
      }
      if (!peer.versions.includes(1) || !peer.transports.includes(this.transport) || !peer.capabilities.includes("chat/1"))
        return this.fail("No compatible paired chat profile");
      const pinned = this.options.credentials.peerKey ?? this.options.credentials.expectedPeerKey;
      if (pinned && pinned !== peer.key)
        return this.fail("Saved contact key mismatch. This invite is already paired with another participation key. Check with your contact and use a new invitation if the change was intended.", true);
      const ranked = rankTransports(this.offer.transports, peer.transports);
      if (!ranked.length) return this.fail("No common available transport");
      this.preferred = ranked[0];
      if (this.transport !== this.preferred && !(this.options.allowFallback && peer.capabilities.includes("transport-fallback/1")))
        return this.fail("This transport would violate the negotiated fallback policy");
      this.peer = peer;
      // Fixed arrays define the canonical transcript; unknown offer fields grant nothing.
      const offers = [this.offer, peer].sort((a,b) => a.key < b.key ? -1 : 1).map(offerTuple);
      this.transcript = utf8Encode(JSON.stringify(["ghostly-paired-chat", 1,
        [...this.options.rendezvousKeys].sort(), this.options.binding
          ? [this.transport, [...this.options.binding.identities].sort(), this.options.binding.context]
          : [...this.options.fingerprints!].sort(), offers,
        [1, this.transport, "chat/1", "no-dht-payload"]]));
      const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(this.transcript));
      if (this.stopped) return;
      this.digest = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
      if (this.identity) this.send({ t: "pair-proof", sig: toBase64Url(sign(this.transcript, this.identity.seed)) });
      else {
        // A signer may sign outside this page's code (WebCrypto): the frames behind this one wait in the queue.
        const sig = toBase64Url(await this.signer!.sign(this.transcript));
        if (this.stopped) return;
        this.send({ t: "pair-proof", sig });
      }
    } else if (raw.t === "pair-proof") {
      if (!this.peer || !this.transcript || typeof raw.sig !== "string" || !SIG.test(raw.sig) ||
        !verify(fromBase64Url(raw.sig), this.transcript, publicKeyFromZ32(this.peer.key)))
        return this.fail("The peer could not authenticate this connection");
      if (this.proofReceived) return;
      this.proofReceived = true;
      if (this.options.credentials.peerKey || this.options.trustOnFirstUse) await this.admit();
      else this.update({ status: "confirm", code: this.code(), peerKey: this.peer.key });
    } else if (raw.t === "pair-ready") {
      if (!this.proofReceived || raw.context !== this.digest) return this.fail("Invalid session confirmation");
      this.peerReady = true;
      this.maybeReady();
    } else this.fail("Unsupported session message");
  }

  private code(): string { return this.digest.slice(0, 24).match(/.{4}/g)!.join(" "); }

  /** A user's explicit comparison. Never called by automatic admission/reconnection. */
  async confirm(expectedCode: string): Promise<void> {
    if (this.stopped || !this.proofReceived || !this.peer) throw new Error("No authenticated peer to verify");
    if (expectedCode !== this.code()) throw new Error("The connection changed. Compare the current code again.");
    if (this.confirming) return;
    this.confirming = true;
    const peerKey = this.peer.key;
    try {
      await this.admit();
      // Admission reports its own failure and stops the session; a stop is also
      // what a deliberate disconnect looks like. Neither is a verification, and
      // neither is news worth raising at whoever asked for one.
      if (this.stopped) return;
      if (!this.localReady) throw new Error("The connection closed. Compare again after reconnecting.");
      await this.options.verifyPeer?.(peerKey);
      this.options.credentials.verifiedPeerKey = peerKey;
      if (!this.stopped) this.update({ ...this.state, verified: true });
    } finally { this.confirming = false; }
  }

  /** Save the authenticated key before enabling any application capability. */
  private admit(): Promise<void> {
    if (this.admission) return this.admission;
    this.admission = this.admitOnce();
    return this.admission;
  }

  private async admitOnce(): Promise<void> {
    if (this.stopped || !this.proofReceived || !this.peer || this.localReady) return;
    const peerKey = this.peer.key;
    try {
      const signedSignals = this.peer.capabilities.includes("signed-signal/1");
      if (this.options.credentials.requireSignedSignals && !signedSignals) throw new Error("This peer needs a version supporting signed signaling");
      await this.options.pinPeer(peerKey, signedSignals);
      this.options.credentials.requireSignedSignals ||= signedSignals;
      if (this.stopped) return;
      this.options.credentials.peerKey = peerKey;
      this.localReady = true;
      this.update({ status: "waiting", code: this.code(), peerKey,
        peerNeedsConfirmation: !this.peer.capabilities.includes("tofu/1") });
      // This means authenticated, durably pinned and ready, not independently verified.
      this.send({ t: "pair-ready", context: this.digest });
      this.maybeReady();
    } catch {
      this.fail("Could not durably save this peer. No messages were enabled.");
    }
  }

  private maybeReady(): void {
    if (this.stopped || !this.localReady || !this.peerReady || this.state.status === "ready") return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.update({ status: "ready", code: this.code(), peerKey: this.peer!.key });
    this.options.onReady();
  }

  private update(state: PairingState): void { this.state = { ...state, verified: !!state.peerKey && this.options.credentials.verifiedPeerKey === state.peerKey, transport: this.transport, preferred: this.preferred }; this.options.onState(this.state); }
  private fail(error: string, keyMismatch = false): void {
    if (this.stopped) return;
    this.update({ status: "error", error, keyMismatch });
    this.stop();
    this.options.onFailure();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
