import { PROOF_ADAPTERS, proofCapability, type ProofAdapter } from "./peerProofs";
import { IDENTITY_PROOF_CAPABILITY } from "./identityProofs";
import { fromBase64Url, randomBytes, toBase64Url, utf8Encode } from "./bytes";
import { identityFromSeedB64, publicKeyFromZ32, sign, verify } from "./identity";
import type { FrameChannel } from "./frames";
import { rankTransports, type PairedTransport, type NativeBinding } from "./pairedTransports";

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
  seedB64: string;
  peerKey?: string;
  requireSignedSignals?: boolean;
  verifiedPeerKey?: string;
}
interface Offer {
  t: "pair-offer";
  versions: number[];
  transports: string[];
  capabilities: string[];
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
  /** TOFU admission is distinct from an optional human comparison. */
  trustOnFirstUse?: boolean;
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
 * `bitcoin` (on-chain) is never offered in the handshake: a full offer is already at the 16 capabilities
 * apps before 0.5 accept. Both sides allow it only through the `paired-payments` list of the open session.
 */
export type PaymentMethodName = "cashu" | "lightning" | "arkade" | "usdt" | "bark" | "bitcoin";

const MAX_HANDSHAKE_BYTES = 4096;
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
  return { t: "pair-offer", versions: v.versions, transports: v.transports, capabilities: v.capabilities, key: v.key, nonce: v.nonce };
}
const offerTuple = (o: Offer) => [o.key, o.nonce, o.versions, o.transports, o.capabilities];

export class PairedSession {
  state: PairingState = { status: "negotiating" };
  private readonly identity;
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
  private queue = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private channel: FrameChannel, private options: PairedSessionOptions) {
    this.identity = identityFromSeedB64(options.credentials.seedB64);
    this.transport = options.binding?.transport ?? "webrtc/1";
    this.offer = { t: "pair-offer", versions: [1], transports: options.transports ?? [this.transport], capabilities: ["chat/1", "signed-signal/1", ...(options.trustOnFirstUse ? ["tofu/1"] : []), ...(options.filesSupport ? ["files/2"] : []), ...(options.paymentsSupport && (options.cashuPaymentsSupport !== false || options.lightningPaymentsSupport !== false) ? ["payments/1"] : []), ...(options.paymentsSupport && options.cashuPaymentsSupport !== false ? ["payments-cashu/1"] : []), ...(options.paymentsSupport && options.lightningPaymentsSupport !== false ? ["payments-lightning/1"] : []), ...(options.arkPaymentsSupport && options.paymentsSupport ? ["payments-arkade/1"] : []), ...(options.usdtPaymentsSupport && options.paymentsSupport ? ["payments-usdt/1"] : []), ...(options.barkPaymentsSupport && options.paymentsSupport ? ["payments-bark/1"] : []), ...(options.transportSwitchSupport ? ["transport-switch/1"] : []), ...(options.proofSupport ? PROOF_ADAPTERS.map(proofCapability) : []), ...(options.identitySupport ? [IDENTITY_PROOF_CAPABILITY] : []), ...(options.allowFallback ? ["transport-fallback/1"] : [])],
      key: this.identity.pubKeyZ32, nonce: toBase64Url(randomBytes(32)) };
  }

  supports(capability: "files/2" | "payments/1" | "payments-arkade/1" | "payments-usdt/1" | "payments-bark/1"): boolean { return this.state.status === "ready" && this.offer.capabilities.includes(capability) && !!this.peer?.capabilities.includes(capability); }
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
    if (method === "arkade" || method === "usdt" || method === "bark" || method === "bitcoin") return theirs.includes(capability);
    const other = method === "cashu" ? "payments-lightning/1" : "payments-cashu/1";
    return theirs.includes("payments/1") && (theirs.includes(capability) || !theirs.includes(other));
  }
  get peerTransportSwitchSupport(): boolean { return !!this.peer?.capabilities.includes("transport-switch/1"); }

  get proofSession(): string { return this.digest; }
  get peerProofAdapters(): ProofAdapter[] { return PROOF_ADAPTERS.filter(a => this.offer.capabilities.includes(proofCapability(a)) && this.peer?.capabilities.includes(proofCapability(a))); }
  get peerProofSupport(): boolean { return this.peerProofAdapters.length > 0; }
  /** Both offers carry `identity-proof/1`. */
  get identitySupport(): boolean { return this.state.status === "ready" && this.offer.capabilities.includes(IDENTITY_PROOF_CAPABILITY) && !!this.peer?.capabilities.includes(IDENTITY_PROOF_CAPABILITY); }
  get peerTransports(): readonly string[] { return this.peer?.transports ?? []; }
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
      if ((typeof data === "string" ? data.length : data.length) > 60 * 1024 || ++this.pending > 64)
        return this.fail("Session receive limit exceeded");
      this.queue = this.queue.then(async () => {
        if (this.stopped) return;
        if (typeof data === "string" && data.startsWith('{"t":"pair-')) {
          if (data.length > MAX_HANDSHAKE_BYTES) return this.fail("Negotiation message too large");
          await this.receive(data);
        } else if (this.state.status === "ready") await this.options.onApplication(data);
      }).catch(() => this.fail("Invalid session negotiation"))
        .finally(() => { this.pending--; });
    };
    this.timer = setTimeout(() => this.fail("The peer did not finish authentication. Reconnect to try again."), 180_000);
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
      if (this.options.credentials.peerKey && this.options.credentials.peerKey !== peer.key)
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
      this.send({ t: "pair-proof", sig: toBase64Url(sign(this.transcript, this.identity.seed)) });
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
