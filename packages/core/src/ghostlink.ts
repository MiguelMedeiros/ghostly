import { DhtDelivery, type DeliveryMode, type DhtDeliveryState, type DhtDeliveryView } from "./dhtDelivery";
import { PairedFiles } from "./pairedFiles";
import { TransportSwitch, allowedTransports, type SwitchPlan } from "./transportSwitch";
import { proofHash, type ProofAdapter, type ProofScope } from "./peerProofs";
import { IDENTITY_MAX_FRAME, type IdentityScope } from "./identityProofs";
import { sha256 } from "@noble/hashes/sha2.js";
import { identityFromSeedB64 } from "./identity";
import { rankTransports, transportOrder, type NativeEndpoint, type NativeBinding, type PairedTransport, type TransportDescriptors } from "./pairedTransports";
import { sanitizeNick } from "./text";
import { sanitizeAvatar } from "./avatar";
import { randomBytes, toBase64Url, utf8Encode } from "./bytes";
import { fitSignedPairedSignal, verifyPairedSignal } from "./pairedSignal";
import { PairedSession, type PairingState, type PairingCredentials, type PaymentMethodName } from "./pairedSession";
import { DataLink, type DataLinkState } from "./datalink";
import {
  CHUNK_KIND,
  LIMITS,
  PROTOCOL_VERSION,
  decodeChunk,
  decodeControl,
  encodeControl,
  type FrameChannel,
} from "./frames";
import { FileTransfers, type FileInfo, type FileSink } from "./files";
import {
  HttpClient,
  HttpHost,
  GhostlyHttpError,
  type ClientRequest,
  type ClientResponse,
  type HostedHttpService,
  type LocalFetch,
} from "./http";
import type { LinkParams } from "./invite";
import type { Payment, PaymentAsk, PaymentRequest, PaymentResult } from "./payments";
import { LinkSession, type LinkStatus, type PeerPresence, type PollIntervals } from "./link";
import type { ResolvedLink } from "./records";
import { servicesFromWire, servicesToWire, type ServiceAd } from "./services";
import { PairedHttp } from "./pairedHttp";
import type { PkarrTransport } from "./transport";

/**
 * One link to one peer, complete: Pkarr presence and signaling, the WebRTC
 * data link, and the services multiplexed on top of it. Platform specifics
 * (how to reach Pkarr, how to create a peer connection, how to reach a local
 * HTTP server) are injected, so Desktop and Browser run the same code.
 */
/** Unanswered offers are repeated less and less often: 1.5, 3, 6, then every 12 minutes. */
/** After a failed attempt: 20 s, then doubling up to 3 min. Someone opening the chat starts it over. */
const AUTO_CONNECT_RETRY_MS = 20_000;
const AUTO_CONNECT_MAX_RETRY_MS = 3 * 60_000;
/**
 * Liveness of a paired session: a ping this often, and the session is taken for dead after this many
 * pings in a row with nothing at all back. Counted in pings, not seconds, so a throttled background
 * tab (timers once a minute) is not mistaken for a dead peer. Only once the peer has answered a ping:
 * older apps drop the frame and must not be cut off for it.
 */
export const LIVENESS_PING_MS = 15_000;
export const LIVENESS_MISSED_PINGS = 3;

export interface IncomingMessage {
  id?: string;
  text: string;
  timestamp: number;
  nick?: string;
  via: "pkarr" | "datalink";
  batch?: ResolvedLink;
}

export interface GhostLinkEvents {
  onDhtDelivery?(view: DhtDeliveryView): void;
  onDiscoveryError?(error: string | null): void;
  onPeerProof?(frame: Record<string, unknown>): Promise<void>;
  /** An `idp-*` identity-proof frame from the paired contact (only when both sides offer `identity-proof/1`). */
  onIdentityProof?(frame: Record<string, unknown>): Promise<void>;
  onTransportsChanged?(): void;
  onTransportDiscovery?(descriptors: TransportDescriptors, transports: PairedTransport[], fallback: boolean): Promise<void>;
  onPairingState?(state: PairingState): void;
  onMessage?(message: IncomingMessage): void | Promise<void>;
  onPresence?(presence: PeerPresence): void;
  /** A paired contact's profile picture, already checked; `null` when they removed it. */
  onPeerAvatar?(avatar: string | null): void;
  onMessageReceipt?(id: string): void | Promise<void>;
  onPeerAck?(ackTimestamp: number): void;
  onCallSignal?(signal: string): void;
  onStatus?(status: LinkStatus): void;
  onDataLinkState?(state: DataLinkState): void;
  onPoll?(poll: { polling: boolean; nextInMs: number }): void;
  /** The peer is sending a file. Return where to put it, or null (or a reason) to refuse. */
  onFileStored?(file: FileInfo): Promise<string | undefined>;
  onFileIncoming?(file: FileInfo): FileSink | string | null;
  onFileProgress?(fileId: string, transferred: number, direction: "in" | "out"): void;
  onFileComplete?(fileId: string, direction: "in" | "out"): void;
  onFileFailed?(fileId: string, reason: string, direction: "in" | "out"): void;
  onPaymentRequest?(request: PaymentRequest): void | Promise<void>;
  /** A contact asking to pay this side (paired chats): answer with a request carrying the ask's id. */
  onPaymentAsk?(ask: PaymentAsk): void | Promise<void>;
  onPayment?(payment: Payment): void | Promise<void>;
  onPaymentResult?(result: PaymentResult): void | Promise<void>;
  /** A `group-*` frame (WISP 900) from the peer, only while both sides announced `paired-groups`. */
  onGroupFrame?(frame: Record<string, unknown>): void | Promise<void>;
  /** Group frames can flow (both announced), or no longer can. */
  onGroupsSupport?(supported: boolean): void;
}

const PAYMENT_METHODS: PaymentMethodName[] = ["cashu", "lightning", "arkade", "usdt", "bark", "bitcoin"];

export interface GhostLinkOptions {
  /** Ways of paying this chat allows. One that is off is not offered in the handshake, sent or accepted. Absent: allowed. */
  paymentMethods?: Partial<Record<PaymentMethodName, boolean>>;
  arkPaymentsSupport?: boolean;
  usdtPaymentsSupport?: boolean;
  barkPaymentsSupport?: boolean;
  /** Announce private groups (WISP 900) on the open session. Announced after the handshake, like `paired-payments`, so a full offer stays within what older apps accept. */
  groupsSupport?: boolean;
  dht?: { state?: DhtDeliveryState; save(state: DhtDeliveryState): Promise<void>; pollMs?: number };
  rtcAvailable?: boolean;
  native?: { peerDescriptors?: TransportDescriptors; peerTransports?: PairedTransport[]; peerFallback?: boolean; preferred?: PairedTransport; fallback?: boolean };
  params: LinkParams;
  pairing?: { credentials: PairingCredentials; pinPeer: (key: string, signedSignals?: boolean) => Promise<void>; verifyPeer?: (key: string) => Promise<void>; trustOnFirstUse?: boolean };
  transport: PkarrTransport;
  nick?: string;
  /** This side's profile picture (a small JPEG data URL), told to a paired peer directly. */
  avatar?: string;
  lastSeenTimestamp?: number;
  pollIntervals?: PollIntervals;
  /**
   * Open the data link on its own whenever the peer is online, instead of on
   * first use. Chat and call signaling then travel peer to peer and Pkarr is
   * only polled once a minute, which is what keeps relays happy.
   */
  autoConnect?: boolean;
  createPeerConnection: () => RTCPeerConnection;
  localFetch: LocalFetch;
  /** Everything this peer currently offers on this link. */
  getServices: () => ServiceAd[] | undefined;
  /** Web apps a paired contact may reach: told to that contact alone, on the open session, never published. */
  getPairedServices?: () => ServiceAd[];
  /** Resolves an advertised `http` service id to its local target. */
  getHostedHttpService: (id: string) => HostedHttpService | undefined;
  events?: GhostLinkEvents;
}

export class GhostLink {
  readonly session: LinkSession;
  private readonly dht: DhtDelivery | null;
  private deliveryMode: DeliveryMode;
  private securityRejected = false;
  readonly dataLink: DataLink;
  private readonly options: GhostLinkOptions;
  private channel: FrameChannel | null = null;
  private endpoints = new Map<PairedTransport, NativeEndpoint>();
  private activeBinding?: NativeBinding;
  private dialing = false;
  private connectionEpoch = 0;
  private switchAllowedUntil = 0;
  private switchAck: (() => void) | null = null;
  private readonly switcher: TransportSwitch;
  private candidate: { channel: FrameChannel; session: PairedSession; binding?: NativeBinding; reject(error: Error): void } | null = null;
  private candidateEpoch = 0;
  private rtcCandidateWaiter: { resolve(): void; reject(error: Error): void } | null = null;
  private transitionTarget?: PairedTransport;
  private transitionError?: string;
  private applicationOpen = false;
  private stopped = false;
  private peerDescriptors: TransportDescriptors;
  private peerTransports?: PairedTransport[];
  private peerFallback: boolean;
  private preferred: PairedTransport;
  private fallback: boolean;
  private paired: PairedSession | null = null;
  private pairedPending = new Map<string, number>();
  private httpHost: HttpHost | null = null;
  /** HTTP to and from shared web apps over a paired session. */
  private pairedHttp: PairedHttp | null = null;
  private httpClient: HttpClient | null = null;
  private files: FileTransfers | null = null;
  private pairedFiles: PairedFiles | null = null;
  private peerServicesOverride: ServiceAd[] | null = null;
  /** A paired peer's name arrives over the channel; nothing about it is published. */
  /** Ways of paying the contact allows, as it last said on this session; null until it does. */
  private peerPaymentMethods: Set<PaymentMethodName> | null = null;
  private peerNickOverride: string | null = null;
  /** Group protocol versions the peer announced on this session; null until it does. */
  private peerGroupVersions: number[] | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private peerAnswersPings = false;
  private unansweredPings = 0;
  private openWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private lastAutoConnectAt = 0;
  private autoConnectFailures = 0;

  constructor(options: GhostLinkOptions) {
    this.options = options;
    this.deliveryMode = options.params.deliveryMode ?? "stream";
    this.dht = options.params.profile && options.pairing && options.dht ? new DhtDelivery({
      params: options.params, mode: this.deliveryMode, state: options.dht.state, credentials: options.pairing.credentials, transport: options.transport,
      save: options.dht.save, pollMs: options.dht.pollMs, pin: key => options.pairing!.pinPeer(key, true),
      message: async message => { await options.events?.onMessage?.({ ...message, via: "pkarr" }); },
      receipt: async id => { await options.events?.onMessageReceipt?.(id); },
      changed: view => {
        options.events?.onDhtDelivery?.(view);
        if (this.streamBlocked) {
          if (this.channel || this.dialing || this.dataLink.state !== "idle") this.disconnect();
          this.emitDeliveryState();
        } else if (!this.paired) this.maybeAutoConnect(this.session.peerPresence);
      },
    }) : null;
    this.peerDescriptors = options.native?.peerDescriptors ?? {};
    this.peerTransports = options.native?.peerTransports;
    this.peerFallback = options.native?.peerFallback ?? false;
    this.preferred = options.native?.preferred ?? "webrtc/1";
    this.fallback = options.native?.fallback ?? true;
    const events = options.events ?? {};

    this.session = new LinkSession({
      params: options.params,
      transport: options.transport,
      nick: options.nick,
      lastSeenTimestamp: options.lastSeenTimestamp,
      pollIntervals: options.pollIntervals,
      getServices: options.getServices,
      events: {
        onMessages: (messages, batch) => {
          if (options.params.profile) return;
          for (const m of messages) events.onMessage?.({ ...m, via: "pkarr", batch });
        },
        onPresence: (presence) => {
          events.onPresence?.(this.mergePresence(presence));
          this.maybeAutoConnect(presence);
        },
        onPeerAck: (ack) => events.onPeerAck?.(ack),
        onCallSignal: (signal) => { if (!options.params.profile) events.onCallSignal?.(signal); },
        onRtcSignal: signal => {
          if (this.streamBlocked) return;
          const credentials = options.pairing?.credentials;
          const verified = options.params.profile ? verifyPairedSignal(signal, options.params.peerPubKeyZ32,
            this.myPubKeyZ32, credentials?.peerKey, credentials?.requireSignedSignals) : signal;
          if (verified) void this.dataLink.handleSignal(verified);
          else if (credentials?.requireSignedSignals && !this.isDataLinkOpen) {
            // Only a valid signature from another key establishes a mismatch.
            // Malformed or forged traffic cannot claim a new contact identity.
            const keyMismatch = !!credentials.peerKey && !!verifyPairedSignal(signal,
              options.params.peerPubKeyZ32, this.myPubKeyZ32, undefined, true);
            this.securityRejected = true;
            events.onPairingState?.({ status: "error", keyMismatch, error: keyMismatch
              ? "This connection uses a different participation key. The saved contact has not been replaced; use a fresh invitation for a new contact."
              : "Ignored an unauthenticated discovery signal. Keep both peers on the updated version; the saved key has not been replaced.",
            });
          }
        },
        onDiscoveryError: error => events.onDiscoveryError?.(error),
        onStatus: (status) => events.onStatus?.(status),
        onPoll: (poll) => events.onPoll?.(poll),
      },
    });

    this.dataLink = new DataLink({
      myPubKeyZ32: this.session.identity.pubKeyZ32,
      peerPubKeyZ32: options.params.peerPubKeyZ32,
      createPeerConnection: options.createPeerConnection,
      publishSignal: signal => {
        const report = (error: unknown) => {
          if (signal && options.params.profile) events.onPairingState?.({ status: "error",
            error: `Could not publish connection details: ${error instanceof Error ? error.message : "discovery unavailable"}. Reconnect to retry.` });
        };
        try {
          const signed = signal && options.params.profile && options.pairing
            ? fitSignedPairedSignal(signal, options.pairing.credentials.seedB64, this.myPubKeyZ32,
              options.params.peerPubKeyZ32, candidate => this.session.fitsRtcSignal(candidate)) : signal;
          // During migration the authenticated channel already reaches the peer.
          // Carry signed ICE signaling there instead of waiting for DHT polling.
          if (this.switcher?.pending?.choices.includes("webrtc/1") && this.channel && this.paired?.state.status === "ready") {
            if (signed) this.channel.send(JSON.stringify({ t: "paired-rtc", signal: signed }));
            return;
          }
          void this.session.setRtcSignal(signed, !!options.params.profile).catch(report);
        } catch (error) { report(error); throw error; }
      },
      setFastPoll: (fast) => this.session.setFastPoll(fast),
      onOpen: channel => {
        if (this.streamBlocked) { channel.close(); return; }
        const plan = this.switcher.pending;
        if (plan?.choices.includes("webrtc/1") && this.paired?.state.status === "ready") {
          void this.attachCandidate(channel, undefined, plan).catch(() => {});
        } else if (this.activeBinding) channel.close(); else this.attach(channel);
      },
      onClose: () => { if (!this.activeBinding) this.detach(); },
      onState: (state) => {
        if (this.activeBinding) return;
        events.onDataLinkState?.(state);
        if (state === "idle") this.rejectWaiters(new GhostlyHttpError("unreachable", "Could not connect to the peer"));
      },
    });
    this.switcher = new TransportSwitch({
      key: this.myPubKeyZ32, peerKey: options.params.peerPubKeyZ32,
      policy: () => ({ preferred: this.preferred, fallback: this.fallback, available: this.availableTransports,
        descriptors: Object.fromEntries([...this.endpoints].map(([transport, endpoint]) => [transport, endpoint.descriptor])) }),
      send: frame => {
        try { if (this.channel && this.paired?.state.status === "ready") this.channel.send(JSON.stringify(frame)); }
        catch { /* Channel closure is handled by its owner; retry uses a fresh session. */ }
      },
      peer: policy => {
        this.peerDescriptors = policy.descriptors;
        this.peerTransports = transportOrder(policy.available, policy.preferred, true);
        this.peerFallback = policy.fallback;
        void options.events?.onTransportDiscovery?.(policy.descriptors, this.peerTransports, policy.fallback).catch(() => {});
        this.emitPairingState();
      },
      state: (error, target) => { this.transitionError = error; this.transitionTarget = target; this.emitPairingState(); },
      prepare: (plan, dial) => { if (dial) void this.prepareSwitch(plan); },
      cancel: () => this.cancelCandidate(),
    });
  }

  get myPubKeyZ32(): string {
    return this.session.identity.pubKeyZ32;
  }

  get isDataLinkOpen(): boolean {
    return !this.streamBlocked && this.channel !== null && (!this.options.params.profile || (this.paired?.state.status === "ready" && this.currentTransportAllowed()));
  }

  private currentTransportAllowed(): boolean {
    const actual = this.paired?.state.transport;
    const remote = this.switcher?.peerPolicy;
    return !!actual && this.transportOffer().includes(actual) && (!remote || allowedTransports(remote).includes(actual));
  }
  private emitPairingState(): void {
    const state = this.paired?.state;
    if (!state) return;
    const blocked = state.status === "ready" && !this.currentTransportAllowed();
    const open = this.isDataLinkOpen;
    if (open !== this.applicationOpen) {
      this.applicationOpen = open;
      if (!open) this.pairedFiles?.closeAll();
      this.options.events?.onDataLinkState?.(open ? "open" : "idle");
    }
    this.options.events?.onPairingState?.({ ...state,
      ...(blocked ? { status: this.transitionError ? "error" as const : "negotiating" as const, error: this.transitionError } : {}),
      transitionTarget: this.transitionTarget, transitionError: this.transitionError,
    });
  }

  get presence(): PeerPresence {
    return this.mergePresence(this.session.peerPresence);
  }

  private get streamBlocked(): boolean { return this.deliveryMode === "dht" || this.dht?.peerMode === "dht"; }
  get textDelivery(): "stream" | "dht" | "unavailable" {
    if (this.isDataLinkOpen) return "stream";
    if (!this.dht || this.securityRejected || this.dht.view.error?.includes("key does not match")) return "unavailable";
    if (this.deliveryMode === "dht") return "dht";
    return !this.channel && !!this.options.pairing?.credentials.peerKey && !!this.dht.peerMode ? "dht" : "unavailable";
  }
  validateText(text: string, timestamp: number, id: string): string | null {
    if (this.textDelivery === "dht") return this.dht!.validate(text, timestamp, id);
    return this.canSendText ? null : "No authenticated text delivery method is available.";
  }
  get canSendText(): boolean { return this.textDelivery !== "unavailable"; }
  get dhtDelivery(): DhtDeliveryView | undefined { return this.dht?.view; }
  private emitDeliveryState(): void {
    if (!this.streamBlocked) return;
    const credentials = this.options.pairing?.credentials;
    const error = this.dht?.view.error;
    this.options.events?.onPairingState?.({ status: error ? "error" : credentials?.peerKey ? "ready" : "connecting",
      peerKey: credentials?.peerKey, code: this.dht?.comparisonCode, verified: !!credentials?.peerKey && credentials.verifiedPeerKey === credentials.peerKey, error });
  }
  async setDeliveryMode(mode: DeliveryMode): Promise<void> {
    if (!this.dht) throw new Error("DHT delivery is unavailable for this conversation.");
    this.deliveryMode = mode;
    if (mode === "dht") this.disconnect();
    await this.dht.setMode(mode);
    if (mode === "dht") {
      await this.session.stop(false);
      await Promise.allSettled([...this.endpoints.keys()].map(t => this.releaseEndpoint(t)));
    } else this.session.start();
    this.emitDeliveryState();
  }
  start(): void {
    if (this.deliveryMode !== "dht") this.session.start();
    void this.dht?.start();
  }

  async stop(announce = true): Promise<void> {
    this.stopped = true;
    await this.dht?.stop();
    this.disconnect();
    await Promise.allSettled([...this.endpoints.values()].map(endpoint => endpoint.close()));
    this.endpoints.clear();
    await this.session.stop(announce);
  }

  /** Opens the data link if needed and resolves once it is usable. */
  connect(timeoutMs = 90_000): Promise<void> {
    if (this.streamBlocked) return Promise.reject(new Error("DHT-only delivery does not open a live connection. Both peers must choose a live method first."));
    if (this.paired?.state.status === "ready") { this.switcher.retry(); return Promise.resolve(); }
    if (this.isDataLinkOpen) return Promise.resolve();
    const epoch = this.connectionEpoch;
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); },
      };
      this.openWaiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.openWaiters.indexOf(waiter);
        if (index < 0) return;
        this.openWaiters.splice(index, 1);
        reject(new GhostlyHttpError("timeout", "Timed out connecting to the peer"));
      }, timeoutMs);
      void this.dial().catch(error => {
        if (epoch !== this.connectionEpoch) return;
        this.options.events?.onPairingState?.({ status: "error", error: error instanceof Error ? error.message : String(error) });
        this.rejectWaiters(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  disconnect(): void {
    this.switcher.stop(); this.cancelCandidate();
    this.transitionTarget = this.transitionError = undefined;
    this.connectionEpoch++;
    this.dialing = false;
    const channel = this.channel;
    this.detach();
    channel?.close();
    this.dataLink.close();
    this.rejectWaiters(new GhostlyHttpError("unreachable", "Connection attempt cancelled"));
  }

  get availableTransports(): PairedTransport[] {
    return [...(this.options.rtcAvailable !== false ? ["webrtc/1" as const] : []), ...this.endpoints.keys()];
  }
  private transportOffer(): PairedTransport[] { return transportOrder(this.availableTransports, this.preferred, this.fallback); }

  registerEndpoint(endpoint: NativeEndpoint): void {
    if (this.stopped || this.deliveryMode === "dht" || !this.options.params.profile) { void endpoint.close(); return; }
    this.endpoints.set(endpoint.transport, endpoint);
    endpoint.onConnection = ({ channel, binding }) => {
      if (this.streamBlocked) { channel.close(); return; }
      const plan = this.switcher.pending;
      if (this.channel && plan?.choices.includes(binding.transport)) {
        void this.attachCandidate(channel, binding, plan).catch(() => {}); return;
      }
      if (this.channel && Date.now() < this.switchAllowedUntil) { this.switchAllowedUntil = 0; this.disconnect(); }
      if (this.stopped || this.channel || !this.transportOffer().includes(binding.transport)) { channel.close(); return; }
      this.attach(channel, binding);
    };
    endpoint.onUnavailable = () => {
      if (this.endpoints.get(endpoint.transport) !== endpoint) return;
      this.endpoints.delete(endpoint.transport);
      this.advertiseTransports(); this.options.events?.onTransportsChanged?.();
    };
    endpoint.onDescriptor = () => this.advertiseTransports();
    // A changed available offer needs a new authenticated session before native
    // transports are usable. Until then descriptors can be saved but not selected.
    this.advertiseTransports();
  }

  canReleaseEndpoint(transport: PairedTransport): boolean {
    return this.activeBinding?.transport !== transport && this.candidate?.binding?.transport !== transport && !this.dialing && !this.switcher.pending && !this.transitionTarget;
  }
  async releaseEndpoint(transport: PairedTransport): Promise<void> {
    if (!this.canReleaseEndpoint(transport)) return;
    const endpoint = this.endpoints.get(transport);
    if (!endpoint) return;
    this.endpoints.delete(transport); await endpoint.close(); this.advertiseTransports();
    this.options.events?.onTransportsChanged?.();
  }

  private advertiseTransports(): void {
    if (this.paired?.state.status !== "ready" || !this.options.params.profile) return;
    if (this.paired.peerTransportSwitchSupport) { this.switcher.changed(false); return; }
    const descriptors: TransportDescriptors = {};
    for (const endpoint of this.endpoints.values()) descriptors[endpoint.transport] = endpoint.descriptor;
    try { this.channel?.send(JSON.stringify({ t: "paired-adapters", descriptors })); } catch { /* Closing channel; exchange again on reconnect. */ }
  }

  async setTransportPreference(preferred: PairedTransport, fallback: boolean): Promise<void> {
    if (!this.options.params.profile || !this.availableTransports.includes(preferred)) throw new Error("Transport unavailable in this runtime");
    this.preferred = preferred; this.fallback = fallback;
    if (this.paired?.state.status === "ready") {
      if (!this.paired.peerTransportSwitchSupport) {
        this.transitionError = "Your contact needs an updated app to negotiate a transport change.";
        this.emitPairingState(); return;
      }
      this.switcher.changed(); this.emitPairingState(); return;
    }
    // A preference is local configuration, not an instruction to find a peer.
    // Discovery/incoming connections will use this offer when a contact arrives.
    // This also applies to a saved contact that is currently offline.
    if (!this.isDataLinkOpen) {
      // Invalidate an older, incomplete attempt. A late native dial must not
      // install a session using preferences that have since been changed.
      if (this.channel || this.dialing || this.dataLink.state !== "idle") this.disconnect();
      return;
    }
  }

  private async dial(): Promise<void> {
    if (this.streamBlocked || this.dialing || this.channel) return;
    if (!this.options.params.profile) { await this.dataLink.connect(); return; }
    this.dialing = true;
    const epoch = this.connectionEpoch;
    this.options.events?.onPairingState?.({ status: "connecting" });
    try {
      const local = this.transportOffer();
      // Cached availability is a routing hint, not permission: the fresh signed
      // PairedSession offer enforces the peer's current (possibly offline-edited) policy.
      const remembered = this.peerTransports && rankTransports(local, this.peerFallback ? this.peerTransports : this.peerTransports.slice(0, 1));
      const choices = remembered?.length ? remembered : this.peerTransports ? rankTransports(local, this.peerTransports) : local.filter(t => t === "webrtc/1");
      if (!choices.length) throw new Error("No common available transport. Initial pairing requires WebRTC on both peers.");
      let lastError: unknown;
      for (const [index, transport] of choices.entries()) {
        if (index > 0 && !(this.fallback && this.peerFallback)) break;
        if (transport === "webrtc/1") { await this.dataLink.connect(); return; }
        const endpoint = this.endpoints.get(transport);
        const descriptor = this.peerDescriptors[transport];
        if (!endpoint || !descriptor) { lastError = new Error("Peer native address unavailable; reconnect WebRTC once to exchange endpoints"); continue; }
        try {
          const { channel, binding } = await endpoint.connect(descriptor);
          if (this.stopped || epoch !== this.connectionEpoch || this.channel) { channel.close(); return; }
          this.attach(channel, binding); return;
        } catch (error) { if (epoch !== this.connectionEpoch) return; lastError = error; }
      }
      throw lastError ?? new Error("No permitted transport could connect");
    } finally { if (epoch === this.connectionEpoch) this.dialing = false; }
  }

  /** Chat goes over the data link when it is up, through Pkarr otherwise. */
  async sendMessage(text: string, timestamp = Date.now(), stableId?: string): Promise<string | null> {
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (this.textDelivery === "dht" && this.dht) return this.dht.send(trimmed, timestamp, stableId ?? toBase64Url(randomBytes(16)));
    if (this.options.params.profile && !this.isDataLinkOpen) return "Confirm the peer and connect before sending. This chat never falls back to DHT messages.";
    if (this.options.params.profile && this.channel) {
      if (utf8Encode(trimmed).length > LIMITS.maxChatMessageBytes) return "Message exceeds 16 KiB";
      if (this.pairedPending.size >= 128) this.pairedPending.delete(this.pairedPending.keys().next().value!);
      const id = stableId ?? toBase64Url(randomBytes(16));
      if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return "Invalid message ID";
      this.pairedPending.set(id, timestamp);
      try { this.channel.send(JSON.stringify({ t: "paired-message", id, ts: timestamp, m: trimmed })); return null; }
      catch { this.pairedPending.delete(id); return "The connection closed before sending. Reconnect and retry."; }
    }
    if (this.channel && trimmed.length <= LIMITS.maxChatMessageBytes / 4) {
      try {
        this.channel.send(encodeControl({ t: "m", ts: timestamp, m: trimmed }));
        return null;
      } catch {
        // fall through to Pkarr
      }
    }
    if (this.options.params.profile) return "Message could not be sent over the negotiated data link.";
    return this.session.sendMessage(trimmed, timestamp);
  }

  /** Publishes a `_call` signal; a connected peer also gets it right away over the data link. */
  async setCallSignal(signal: string | null): Promise<void> {
    this.requireLegacyCapabilities();
    if (signal && this.channel) {
      try {
        this.channel.send(encodeControl({ t: "call", s: signal }));
      } catch {
        // Pkarr still carries it
      }
    }
    await this.session.setCallSignal(signal);
  }

  /** Issues an HTTP request to a service the peer advertises. */
  async request(serviceId: string, request: ClientRequest): Promise<ClientResponse> {
    if (this.options.params.profile) {
      await this.connect();
      if (!this.pairedHttp) throw new GhostlyHttpError("closed", "Data link is closed");
      return this.pairedHttp.client.request(serviceId, request);
    }
    this.requireLegacyCapabilities();
    await this.connect();
    if (!this.httpClient) throw new GhostlyHttpError("closed", "Data link is closed");
    return this.httpClient.request(serviceId, request);
  }

  /** Payments only travel over the data link: tokens and invoices do not fit in Pkarr, and should not sit there. */
  async sendPaymentRequest(request: PaymentRequest): Promise<void> {
    await this.requirePaymentSupport();
    if (!this.channel) throw new Error("Data link is closed");
    this.channel.send(
      encodeControl({
        t: "pay-req",
        id: request.id,
        ts: request.timestamp,
        v: request.amount.value,
        u: request.amount.asset,
        memo: request.memo,
        e: request.endpoints,
        a: request.ask,
      }),
    );
  }

  /** Asks the contact for a way to pay it (an address, an invoice): its app answers with a request. */
  async sendPaymentAsk(ask: PaymentAsk): Promise<void> {
    await this.requirePaymentSupport();
    if (!this.options.params.profile) throw new Error("Paying without a request needs a paired chat");
    if (!this.channel) throw new Error("Data link is closed");
    this.channel.send(encodeControl({ t: "pay-ask", id: ask.id, ts: ask.timestamp, v: ask.amount.value, u: ask.amount.asset, m: ask.method, memo: ask.memo }));
  }

  async sendPayment(payment: Payment): Promise<void> {
    await this.requirePaymentSupport();
    if (!this.channel) throw new GhostlyHttpError("closed", "Data link is closed");
    this.channel.send(
      encodeControl({
        t: "pay",
        id: payment.id,
        ts: payment.timestamp,
        rid: payment.requestId,
        v: payment.amount.value,
        u: payment.amount.asset,
        memo: payment.memo,
        e: payment.endpoint,
      }),
    );
  }

  sendPaymentResult(result: PaymentResult): void {
    if (this.options.params.profile && !this.supportsPayments) return;
    try {
      this.channel?.send(encodeControl({ t: "pay-res", id: result.id, ok: result.ok, v: result.credited, err: result.error }));
    } catch {
      // the peer learns on reconnect that nothing came back
    }
  }

  /** Sends a file over the data link, opening it first if needed. Files never travel through Pkarr. */
  async sendFile(file: FileInfo, source: AsyncIterable<Uint8Array>): Promise<void> {
    await this.connect();
    if (this.options.params.profile) {
      if (!this.supportsFiles || !this.pairedFiles) throw new Error("This contact does not support files. Both peers need an updated Ghostly.");
      return this.pairedFiles.send(file, source);
    }
    if (!this.files) throw new GhostlyHttpError("closed", "Data link is closed");
    await this.files.send(file, source);
  }

  /** Call after the set of shared services changed. */
  async refreshServices(): Promise<void> {
    if (this.options.params.profile) { this.sendPairedServices(); return; }
    if (this.channel) {
      try {
        this.channel.send(encodeControl({ t: "svc", svc: servicesToWire(this.options.getServices() ?? []) }));
      } catch {
        // channel closing
      }
    }
    await this.session.refreshAdvertisement();
  }

  /** Only the lower key offers, so two peers coming online together do not collide. */
  private maybeAutoConnect(presence: PeerPresence): void {
    if (this.streamBlocked || !this.options.autoConnect || !presence.online || this.channel || this.dataLink.state !== "idle") return;
    if (this.myPubKeyZ32 > this.options.params.peerPubKeyZ32) return;
    const wait = Math.min(AUTO_CONNECT_RETRY_MS * 2 ** this.autoConnectFailures, AUTO_CONNECT_MAX_RETRY_MS);
    if (Date.now() - this.lastAutoConnectAt < wait) return;
    this.lastAutoConnectAt = Date.now();
    this.autoConnectFailures++;
    void this.dial().catch(() => {});
  }

  /** The name this side shows, told to a paired peer directly. */
  setNick(nick: string | undefined): void {
    this.options.nick = nick || undefined;
    this.session.setNick(nick);
    this.sendPairedNick();
  }

  /** The picture this side shows, told to a paired peer directly. Legacy chats have no room for it. */
  setAvatar(avatar: string | undefined): void {
    this.options.avatar = avatar || undefined;
    this.sendPairedAvatar();
  }

  /** Older apps drop this frame (it carries no id). An empty `a` says the picture was removed. */
  private sendPairedAvatar(): void {
    if (!this.options.params.profile || !this.channel || !this.isDataLinkOpen) return;
    try { this.channel.send(JSON.stringify({ t: "paired-avatar", a: this.options.avatar ?? "" })); } catch { /* sent again on the next session */ }
  }

  private sendPairedNick(): void {
    if (!this.options.params.profile || !this.channel || !this.isDataLinkOpen) return;
    this.channel.send(JSON.stringify({ t: "paired-nick", n: this.options.nick ?? "" }));
  }

  private mergePresence(presence: PeerPresence): PeerPresence {
    if (!this.channel) return presence;
    return { ...presence, online: true, nick: this.peerNickOverride ?? presence.nick,
      services: this.peerServicesOverride ?? presence.services };
  }

  get peerProofAdapters(): ProofAdapter[] { return this.options.events?.onPeerProof && this.isDataLinkOpen ? this.paired?.peerProofAdapters ?? [] : []; }
  get peerProofSupport(): boolean { return !!this.options.events?.onPeerProof && !!this.paired?.peerProofSupport && this.isDataLinkOpen; }

  async peerProofScope(): Promise<ProofScope> {
    const credentials = this.options.pairing?.credentials;
    if (!credentials?.peerKey || !this.paired || !this.peerProofSupport) throw new Error("Connect to a confirmed peer supporting optional proofs first");
    const paired = this.paired;
    const context = await proofHash(JSON.stringify(["ghostly-conversation", 1, [this.myPubKeyZ32, this.options.params.peerPubKeyZ32].sort()]));
    if (this.paired !== paired || !this.peerProofSupport) throw new Error("Connection changed");
    return { subject: identityFromSeedB64(credentials.seedB64).pubKeyZ32, audience: credentials.peerKey, context, session: paired.proofSession };
  }

  get proofSession(): string | undefined { return this.peerProofSupport ? this.paired?.proofSession : undefined; }

  /** Identity proofs can be exchanged now: both offers carry `identity-proof/1` and the channel is open. */
  get identitySupport(): boolean { return !!this.options.events?.onIdentityProof && !!this.paired?.identitySupport && this.isDataLinkOpen; }

  /** This side's view of the authenticated channel, for identity presentations. */
  identityScope(): IdentityScope {
    const credentials = this.options.pairing?.credentials;
    if (!credentials?.peerKey || !this.paired || !this.identitySupport) throw new Error("Connect to this contact first");
    const conversation = [this.myPubKeyZ32, this.options.params.peerPubKeyZ32].sort();
    const context = Array.from(sha256(utf8Encode(JSON.stringify(["ghostly-conversation", 1, conversation]))), b => b.toString(16).padStart(2, "0")).join("");
    return { subject: identityFromSeedB64(credentials.seedB64).pubKeyZ32, audience: credentials.peerKey, context, session: this.paired.proofSession };
  }

  sendIdentityProof(frame: object): void {
    if (!this.identitySupport || !this.channel) throw new Error("Identity proofs are unavailable on this connection");
    const data = JSON.stringify(frame);
    if (data.length > IDENTITY_MAX_FRAME) throw new Error("Identity proof too large");
    this.channel.send(data);
  }

  sendPeerProof(frame: object): void {
    if (!this.peerProofSupport || !this.channel) throw new Error("Peer proof channel unavailable");
    const data = JSON.stringify(frame);
    if (data.length > 8192) throw new Error("Proof too large");
    this.channel.send(data);
  }

  async confirmPair(code: string): Promise<void> {
    if (this.streamBlocked && this.dht?.comparisonCode) {
      const credentials = this.options.pairing!.credentials;
      if (code !== this.dht.comparisonCode) throw new Error("Compare the current code again.");
      await this.options.pairing!.verifyPeer?.(credentials.peerKey!);
      credentials.verifiedPeerKey = credentials.peerKey; this.emitDeliveryState(); return;
    }
    if (!this.paired) throw new Error("No peer is waiting for confirmation");
    await this.paired.confirm(code);
  }

  get supportsFiles(): boolean { return this.options.params.profile ? this.isDataLinkOpen && !!this.paired?.supports("files/2") : true; }
  /** This device allows the way of paying in this chat. */
  paymentEnabled(method: PaymentMethodName): boolean { return this.options.paymentMethods?.[method] !== false; }
  /** Both sides allow it. A chat from before pairing negotiates nothing: Cashu and Lightning as this device allows. */
  allowsPayment(method: PaymentMethodName): boolean {
    if (!this.paymentEnabled(method)) return false;
    if (!this.options.params.profile) return method === "cashu" || method === "lightning";
    if (!this.isDataLinkOpen || this.paired?.state.status !== "ready") return false;
    // The contact's latest word in this session wins over its handshake offer.
    return this.peerPaymentMethods ? this.peerPaymentMethods.has(method) : this.paired.peerAllowsPayment(method);
  }
  get supportsUsdtPayments(): boolean { return this.allowsPayment("usdt"); }
  get supportsArkPayments(): boolean { return this.allowsPayment("arkade"); }
  get supportsBarkPayments(): boolean { return this.allowsPayment("bark"); }
  /** On-chain: only ever through the contact's `paired-payments` list (see PaymentMethodName). */
  get supportsBitcoinPayments(): boolean { return this.allowsPayment("bitcoin"); }
  /** Payment messages flow at all: some way of paying is allowed by both sides. */
  get supportsPayments(): boolean { return PAYMENT_METHODS.some(m => this.allowsPayment(m)); }
  /** Takes effect at once, and a connected contact is told on the open session; the next handshake offers it too. */
  setPaymentMethods(methods: Partial<Record<PaymentMethodName, boolean>>): void { this.options.paymentMethods = { ...methods }; this.sendPaymentMethods(); }
  /** The apps this contact may reach, said on the open session. Older apps drop the frame (no id). */
  private sendPairedServices(): void {
    if (!this.options.params.profile || !this.channel || !this.isDataLinkOpen || this.paired?.state.status !== "ready") return;
    try { this.channel.send(JSON.stringify({ t: "paired-services", s: servicesToWire(this.options.getPairedServices?.() ?? []) })); } catch { /* sent again on the next session */ }
  }
  /** Both sides announced groups on this session and it is open. */
  get groupsSupport(): boolean { return !!this.options.groupsSupport && this.isDataLinkOpen && !!this.peerGroupVersions?.includes(1); }
  /** A `group-*` frame to the peer. Only while both sides support groups; never queued. */
  sendGroupFrame(frame: object): void {
    if (!this.groupsSupport || !this.channel) throw new Error("This contact is not connected, or needs an updated Ghostly for groups");
    const data = JSON.stringify(frame);
    if (data.length > LIMITS.maxControlFrameBytes) throw new Error("Group frame too large");
    this.channel.send(data);
  }
  /** Older apps drop this frame (it carries no id): to them this contact has no groups. */
  private sendGroupsSupport(): void {
    if (!this.options.groupsSupport || !this.options.params.profile || !this.channel || !this.isDataLinkOpen) return;
    try { this.channel.send(JSON.stringify({ t: "paired-groups", v: [1] })); } catch { /* the next session announces it */ }
  }
  /** Older apps drop this frame (it carries no id) and keep using the handshake offer. */
  private sendPaymentMethods(): void {
    if (!this.options.params.profile || !this.channel || !this.isDataLinkOpen || this.paired?.state.status !== "ready") return;
    try { this.channel.send(JSON.stringify({ t: "paired-payments", m: PAYMENT_METHODS.filter(m => this.paymentEnabled(m)) })); } catch { /* the next session offers it */ }
  }
  async requirePaymentSupport(): Promise<void> {
    if (!PAYMENT_METHODS.some(m => this.paymentEnabled(m))) throw new Error("Payments are turned off in this chat.");
    await this.connect();
    if (!this.supportsPayments) throw new Error("This contact does not support payments. Both peers need an updated Ghostly.");
  }

  private requireLegacyCapabilities(): void {
    if (this.options.params.profile) throw new Error("This experimental paired profile supports chat only.");
  }

  private cancelCandidate(): void {
    this.candidateEpoch++;
    const candidate = this.candidate;
    this.candidate = null;
    candidate?.session.stop();
    candidate?.reject(new Error("Transport change cancelled"));
    candidate?.channel.close();
    this.rtcCandidateWaiter?.reject(new Error("Transport change cancelled"));
    this.rtcCandidateWaiter = null;
    if (this.activeBinding) this.dataLink.close();
  }

  private async prepareSwitch(plan: SwitchPlan): Promise<void> {
    const epoch = ++this.candidateEpoch;
    let lastError: unknown;
    for (const transport of plan.choices) {
      if (epoch !== this.candidateEpoch || this.switcher.pending !== plan || this.stopped) return;
      if (this.paired?.state.transport === transport) { this.switcher.keep(); return; }
      try {
        await new Promise<void>((resolve, reject) => {
          let active = true;
          const timer = setTimeout(() => { active = false; reject(new Error(`${transport} did not connect in time`)); }, 8_000);
          const done = { resolve: () => { active = false; clearTimeout(timer); resolve(); }, reject: (error: Error) => { active = false; clearTimeout(timer); reject(error); } };
          if (transport === "webrtc/1") {
            this.rtcCandidateWaiter = done;
            void this.dataLink.connect().catch(done.reject);
          } else {
            const endpoint = this.endpoints.get(transport), descriptor = plan.remote.descriptors[transport];
            if (!endpoint || !descriptor) { done.reject(new Error("Peer native address unavailable")); return; }
            void endpoint.connect(descriptor).then(({ channel, binding }) => {
              if (!active || epoch !== this.candidateEpoch || this.switcher.pending !== plan) { channel.close(); return; }
              return this.attachCandidate(channel, binding, plan).then(done.resolve, done.reject);
            }).catch(done.reject);
          }
        });
        return;
      } catch (error) {
        lastError = error;
        if (epoch !== this.candidateEpoch || this.switcher.pending !== plan) return;
        const candidate = this.candidate; this.candidate = null;
        candidate?.session.stop(); candidate?.reject(new Error("Candidate failed")); candidate?.channel.close();
        this.rtcCandidateWaiter = null;
        if (transport === "webrtc/1") this.dataLink.close();
      }
    }
    if (epoch === this.candidateEpoch && this.switcher.pending === plan)
      this.switcher.fail(`Transport change failed: ${lastError instanceof Error ? lastError.message : "no permitted transport connected"}. Retry or choose another transport.`);
  }

  private attachCandidate(channel: FrameChannel, binding: NativeBinding | undefined, plan: SwitchPlan): Promise<void> {
    if (this.candidate || this.switcher.pending !== plan || !plan.choices.includes(binding?.transport ?? "webrtc/1")) {
      channel.close(); return Promise.reject(new Error("Obsolete or duplicate transport candidate"));
    }
    return new Promise<void>((resolve, reject) => this.attach(channel, binding, { plan, resolve, reject }));
  }

  private attach(channel: FrameChannel, binding?: NativeBinding, migration?: { plan: SwitchPlan; resolve(): void; reject(error: Error): void }): void {
    if (this.options.params.profile) {
      const fingerprints = this.dataLink.fingerprints;
      if ((!binding && !fingerprints) || !this.options.pairing) { channel.close(); migration?.reject(new Error("Connection binding unavailable")); return; }
      channel.onClose = () => {
        if (this.candidate?.channel === channel) { this.candidate.session.stop(); this.candidate = null; migration?.reject(new Error("Candidate connection closed")); }
        if (this.channel === channel) {
          this.rejectWaiters(new Error("The peer closed this connection. Check that both transport preferences allow a common transport, then reconnect."));
          this.detach();
        }
      };
      if (!migration) {
        this.activeBinding = binding; this.channel = channel;
        this.session.setDataLinkOpen(true);
      }
      const paired = new PairedSession(channel, {
        ...this.options.pairing,
        trustOnFirstUse: this.options.pairing.trustOnFirstUse ?? true,
        rendezvousKeys: [this.myPubKeyZ32, this.options.params.peerPubKeyZ32],
        fingerprints: fingerprints ?? undefined,
        binding, transports: migration?.plan.choices ?? this.transportOffer(), allowFallback: migration?.plan.local.fallback ?? this.fallback,
        transportSwitchSupport: true,
        proofSupport: !!this.options.events?.onPeerProof,
        identitySupport: !!this.options.events?.onIdentityProof,
        filesSupport: !!this.options.events?.onFileIncoming,
        arkPaymentsSupport: this.options.arkPaymentsSupport && this.paymentEnabled("arkade"),
        usdtPaymentsSupport: this.options.usdtPaymentsSupport && this.paymentEnabled("usdt"),
        barkPaymentsSupport: this.options.barkPaymentsSupport && this.paymentEnabled("bark"),
        cashuPaymentsSupport: this.paymentEnabled("cashu"),
        lightningPaymentsSupport: this.paymentEnabled("lightning"),
        paymentsSupport: PAYMENT_METHODS.some(m => this.paymentEnabled(m)) && !!this.options.events?.onPayment && !!this.options.events?.onPaymentRequest && !!this.options.events?.onPaymentResult,
        onState: () => { if (this.channel === channel) this.emitPairingState(); },
        onFailure: () => {
          this.securityRejected = true;
          migration?.reject(new Error(paired.state.error ?? "Candidate authentication failed"));
          channel.close(); if (this.channel === channel) this.detach();
        },
        onReady: () => {
          if (migration) {
            if (this.candidate?.channel !== channel) { paired.stop(); channel.close(); return; }
            const oldChannel = this.channel, oldPaired = this.paired, oldBinding = this.activeBinding;
            this.candidate = null;
            this.pairedFiles?.closeAll(); this.pairedFiles = null;
            this.pairedHttp?.close(); this.pairedHttp = null;
            this.channel = channel; this.paired = paired; this.activeBinding = binding;
            oldPaired?.stop(); oldChannel?.close();
            if (!oldBinding && binding) this.dataLink.close();
            this.session.setDataLinkOpen(true);
          }
          if (this.channel !== channel) return;
          this.securityRejected = false;
          const events = this.options.events ?? {};
          if (paired.supports("files/2")) this.pairedFiles = new PairedFiles(channel, {
            onIncoming: file => events.onFileIncoming?.(file) ?? null,
            onStored: events.onFileStored,
            onProgress: events.onFileProgress,
            onComplete: events.onFileComplete,
            onFailed: events.onFileFailed,
          });
          if (paired.peerTransportSwitchSupport) this.switcher.begin(paired.proofSession, paired.state.transport!);
          else this.advertiseTransports();
          this.peerPaymentMethods = null;
          this.pairedHttp?.close();
          this.pairedHttp = new PairedHttp(channel, this.options.getHostedHttpService, this.options.localFetch);
          this.emitPairingState();
          this.sendPairedNick();
          this.sendPairedAvatar();
          this.sendPaymentMethods();
          this.sendPairedServices();
          this.sendGroupsSupport();
          migration?.resolve();
          this.rtcCandidateWaiter?.resolve(); this.rtcCandidateWaiter = null;
          // The wait between attempts is for attempts that failed: a link that worked and then dropped
          // (the contact reloaded, or came back) is dialled again as soon as the contact is seen.
          this.autoConnectFailures = 0;
          this.lastAutoConnectAt = 0;
          this.startLiveness(channel);
          for (const waiter of this.openWaiters.splice(0)) waiter.resolve();
          this.options.events?.onPresence?.(this.presence);
        },
        onApplication: async data => {
          if (this.channel !== channel) return;
          // Anything from the peer shows the session is alive.
          this.unansweredPings = 0;
          if (typeof data !== "string" || data.length > 60 * 1024) return;
          let frame: Record<string, unknown>;
          try { frame = JSON.parse(data); } catch { return; }
          if (frame?.t === "paired-ping") { try { channel.send(JSON.stringify({ t: "paired-pong" })); } catch { /* closing */ } return; }
          if (frame?.t === "paired-pong") { this.peerAnswersPings = true; return; }
          if (!frame || typeof frame !== "object") return;
          if (paired.peerTransportSwitchSupport && this.switcher.handle(frame)) return;
          if (frame.t === "paired-rtc") {
            if (this.switcher.pending?.choices.includes("webrtc/1") && typeof frame.signal === "string") {
              const credentials = this.options.pairing!.credentials;
              const signal = verifyPairedSignal(frame.signal, this.options.params.peerPubKeyZ32,
                this.myPubKeyZ32, credentials.peerKey, true);
              if (signal) void this.dataLink.handleSignal(signal);
            }
            return;
          }
          if (!this.isDataLinkOpen) return;
          if (typeof frame?.t === "string" && frame.t.startsWith("pf-")) {
            if (this.supportsFiles) await this.pairedFiles?.handle(frame);
            return;
          }
          if (["pay", "pay-req", "pay-res", "pay-ask"].includes(String(frame?.t))) {
            if (this.supportsPayments) {
              const payment = decodeControl(data);
              if (payment?.t === "pay") await this.options.events?.onPayment?.({ id: payment.id, timestamp: payment.ts, requestId: payment.rid, amount: { value: payment.v, asset: payment.u }, memo: payment.memo, endpoint: payment.e });
              else if (payment?.t === "pay-req") await this.options.events?.onPaymentRequest?.({ id: payment.id, timestamp: payment.ts, amount: { value: payment.v, asset: payment.u }, memo: payment.memo, endpoints: payment.e, ask: payment.a });
              else if (payment?.t === "pay-ask") await this.options.events?.onPaymentAsk?.({ id: payment.id, timestamp: payment.ts, amount: { value: payment.v, asset: payment.u }, method: payment.m, memo: payment.memo });
              else if (payment?.t === "pay-res") await this.options.events?.onPaymentResult?.({ id: payment.id, ok: payment.ok, credited: payment.v, error: payment.err });
            }
            return;
          }
          if (typeof frame?.t === "string" && frame.t.startsWith("idp-") && this.identitySupport) {
            await this.options.events?.onIdentityProof?.(frame); return;
          }
          if (typeof frame?.t === "string" && frame.t.startsWith("proof-") && this.peerProofSupport) {
            await this.options.events?.onPeerProof?.(frame); return;
          }
          if (frame?.t === "paired-avatar") {
            const avatar = sanitizeAvatar(frame.a);
            if (avatar !== undefined) this.options.events?.onPeerAvatar?.(avatar);
            return;
          }
          if (frame?.t === "paired-nick") {
            const nick = sanitizeNick(frame.n);
            if (nick !== this.peerNickOverride) {
              this.peerNickOverride = nick ?? null;
              this.options.events?.onPresence?.(this.presence);
            }
            return;
          }
          if (frame?.t === "ph") { this.pairedHttp?.handle(frame); return; }
          if (frame?.t === "paired-services") {
            const services = servicesFromWire(frame.s);
            if (services) { this.peerServicesOverride = services; this.options.events?.onPresence?.(this.presence); }
            return;
          }
          if (frame?.t === "paired-payments") {
            // A method this app does not know yet (a newer contact) is left out, not a reason to drop the list.
            if (!Array.isArray(frame.m) || frame.m.length > 16 || !frame.m.every(m => typeof m === "string")) return;
            this.peerPaymentMethods = new Set((frame.m as string[]).filter((m): m is PaymentMethodName => PAYMENT_METHODS.includes(m as PaymentMethodName)));
            this.emitPairingState();
            return;
          }
          if (frame?.t === "paired-groups") {
            if (!Array.isArray(frame.v) || frame.v.length > 8 || !frame.v.every(v => Number.isSafeInteger(v) && v > 0)) return;
            const before = this.groupsSupport;
            this.peerGroupVersions = frame.v as number[];
            if (this.groupsSupport !== before) this.options.events?.onGroupsSupport?.(this.groupsSupport);
            return;
          }
          if (typeof frame?.t === "string" && frame.t.startsWith("group-")) {
            if (this.groupsSupport) await this.options.events?.onGroupFrame?.(frame);
            return;
          }
          if (frame?.t === "paired-reconnect") {
            this.switchAllowedUntil = Date.now() + 30_000;
            channel.send(JSON.stringify({ t: "paired-reconnect-ack" })); return;
          }
          if (frame?.t === "paired-reconnect-ack") { this.switchAck?.(); return; }
          if (frame?.t === "paired-adapters") {
            if (!frame.descriptors || typeof frame.descriptors !== "object" || JSON.stringify(frame.descriptors).length > 4096) return;
            const descriptors: TransportDescriptors = {};
            for (const transport of ["iroh/1", "hyperdht/1"] as const) {
              const value = (frame.descriptors as TransportDescriptors)[transport];
              if (value) descriptors[transport] = value;
            }
            const transports = [...(this.paired?.peerTransports ?? [])] as PairedTransport[];
            const fallback = this.paired?.peerAllowsFallback ?? false;
            await this.options.events?.onTransportDiscovery?.(descriptors, transports, fallback);
            this.peerDescriptors = descriptors; this.peerTransports = transports; this.peerFallback = fallback;
            return;
          }
          if (!frame || typeof frame.id !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(frame.id)) return;
          if (frame.t === "paired-message" && typeof frame.m === "string" &&
            utf8Encode(frame.m).length <= LIMITS.maxChatMessageBytes &&
            typeof frame.ts === "number" && Number.isSafeInteger(frame.ts) && frame.ts > 0) {
            await this.options.events?.onMessage?.({ id: frame.id, text: frame.m, timestamp: frame.ts, via: "datalink" });
            if (this.channel === channel && this.isDataLinkOpen)
              channel.send(JSON.stringify({ t: "paired-received", id: frame.id }));
          } else if (frame.t === "paired-received") {
            const timestamp = this.pairedPending.get(frame.id);
            if (timestamp !== undefined) {
              await this.options.events?.onMessageReceipt?.(frame.id);
              await this.dht?.acknowledge(frame.id);
              this.pairedPending.delete(frame.id);
            }
          }
        },
      });
      if (migration) this.candidate = { channel, session: paired, binding, reject: migration.reject };
      else this.paired = paired;
      paired.start();
      return;
    }
    this.channel = channel;
    this.autoConnectFailures = 0;
    this.lastAutoConnectAt = 0;
    this.httpClient = new HttpClient(channel);
    this.httpHost = new HttpHost(channel, this.options.getHostedHttpService, this.options.localFetch);
    const events = this.options.events ?? {};
    this.files = new FileTransfers(channel, {
      onIncoming: (file) => events.onFileIncoming?.(file) ?? null,
      onProgress: (id, transferred, direction) => events.onFileProgress?.(id, transferred, direction),
      onComplete: (id, direction) => events.onFileComplete?.(id, direction),
      onFailed: (id, reason, direction) => events.onFileFailed?.(id, reason, direction),
    });
    this.session.setDataLinkOpen(true);

    channel.onMessage = (data) => this.handleFrame(data);
    channel.send(
      encodeControl({
        t: "hello",
        v: PROTOCOL_VERSION,
        svc: servicesToWire(this.options.getServices() ?? []),
        nick: this.options.nick,
      }),
    );
    // Whatever was still waiting in Pkarr for the peer's next poll goes now.
    for (const message of this.session.takeUnacknowledged()) {
      channel.send(encodeControl({ t: "m", ts: message.t, m: message.m }));
    }
    this.options.events?.onPresence?.(this.presence);
    for (const waiter of this.openWaiters.splice(0)) waiter.resolve();
  }

  /** Pings the paired peer; a session that stopped answering is closed, so it can be dialled again. */
  private startLiveness(channel: FrameChannel): void {
    this.stopLiveness();
    this.livenessTimer = setInterval(() => {
      if (this.channel !== channel) { this.stopLiveness(); return; }
      if (this.peerAnswersPings && this.unansweredPings >= LIVENESS_MISSED_PINGS) { this.dropDeadSession(channel); return; }
      this.unansweredPings++;
      try { channel.send(JSON.stringify({ t: "paired-ping" })); } catch { this.dropDeadSession(channel); }
    }, LIVENESS_PING_MS);
  }
  private stopLiveness(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
    this.unansweredPings = 0;
    this.peerAnswersPings = false;
  }
  private dropDeadSession(channel: FrameChannel): void {
    this.stopLiveness();
    if (this.channel !== channel) return;
    // Everything of the dead session goes (channel, peer connection), as a hang-up would.
    this.disconnect();
    this.autoConnectFailures = 0;
    this.lastAutoConnectAt = 0;
    this.maybeAutoConnect(this.presence);
  }

  /**
   * Someone is here again (the chat was opened, the window came back): look now, and try at once rather
   * than after the wait between failed attempts.
   */
  wake(): void {
    this.autoConnectFailures = 0;
    this.lastAutoConnectAt = 0;
    this.session.pollNow();
    if (!this.channel) {
      // The side that does not dial makes sure the other one sees it here, fresh.
      void this.session.refreshAdvertisement();
      this.maybeAutoConnect(this.presence);
    }
  }

  private detach(): void {
    this.stopLiveness();
    const wasNative = !!this.activeBinding;
    this.applicationOpen = false;
    if (!this.candidate && !this.switcher.pending) this.switcher.stop();
    this.activeBinding = undefined;
    this.paired?.stop();
    this.paired = null;
    this.pairedPending.clear();
    this.httpHost?.closeAll();
    this.httpClient?.close();
    this.files?.closeAll();
    this.pairedFiles?.closeAll();
    this.pairedFiles = null;
    this.pairedHttp?.close();
    this.pairedHttp = null;
    this.channel = this.httpHost = this.httpClient = this.files = null;
    this.peerServicesOverride = null;
    this.peerNickOverride = null;
    if (this.peerGroupVersions) { this.peerGroupVersions = null; this.options.events?.onGroupsSupport?.(false); }
    this.session.setDataLinkOpen(false);
    if (wasNative) this.options.events?.onDataLinkState?.("idle");
    this.options.events?.onPresence?.(this.presence);
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.openWaiters.splice(0)) waiter.reject(error);
  }

  private handleFrame(data: string | Uint8Array): void {
    if (typeof data !== "string") {
      const chunk = decodeChunk(data);
      if (!chunk) return;
      if (chunk.kind === CHUNK_KIND.requestBody) this.httpHost?.handleChunk(chunk);
      else if (chunk.kind === CHUNK_KIND.responseBody) this.httpClient?.handleChunk(chunk);
      else this.files?.handleChunk(chunk);
      return;
    }

    const frame = decodeControl(data);
    if (!frame) return;
    switch (frame.t) {
      case "hello":
      case "svc": {
        const services = servicesFromWire(frame.svc);
        if (services) {
          this.peerServicesOverride = services;
          this.options.events?.onPresence?.(this.presence);
        }
        break;
      }
      case "m":
        this.options.events?.onMessage?.({ text: frame.m, timestamp: frame.ts, via: "datalink" });
        break;
      case "call":
        this.options.events?.onCallSignal?.(frame.s);
        break;
      case "req":
        this.httpHost?.handleRequest(frame);
        break;
      case "res":
        this.httpClient?.handleResponse(frame);
        break;
      case "file":
        this.files?.handleFile(frame);
        break;
      case "pay-req":
        this.options.events?.onPaymentRequest?.({
          id: frame.id,
          timestamp: frame.ts,
          amount: { value: frame.v, asset: frame.u },
          memo: frame.memo,
          endpoints: frame.e,
        });
        break;
      case "pay":
        this.options.events?.onPayment?.({
          id: frame.id,
          timestamp: frame.ts,
          requestId: frame.rid,
          amount: { value: frame.v, asset: frame.u },
          memo: frame.memo,
          endpoint: frame.e,
        });
        break;
      case "pay-res":
        this.options.events?.onPaymentResult?.({ id: frame.id, ok: frame.ok, credited: frame.v, error: frame.err });
        break;
      case "rst":
        if (frame.d === "q") this.httpHost?.handleReset(frame);
        else if (frame.d === "s") this.httpClient?.handleReset(frame);
        else this.files?.handleReset(frame);
        break;
      case "ping":
        try {
          this.channel?.send(encodeControl({ t: "pong", ts: frame.ts }));
        } catch {
          // channel closing
        }
        break;
      case "pong":
        break;
    }
  }
}
