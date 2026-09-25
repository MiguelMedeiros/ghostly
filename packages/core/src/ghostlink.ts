import { DhtDelivery, type DeliveryMode, type DhtDeliveryState, type DhtDeliveryView } from "./dhtDelivery";
import { PairedFiles } from "./pairedFiles";
import { TransportSwitch, allowedTransports, type SwitchPlan } from "./transportSwitch";
import { proofHash, type ProofAdapter, type ProofScope } from "./peerProofs";
import { IDENTITY_MAX_FRAME, type IdentityScope } from "./identityProofs";
import { sha256 } from "@noble/hashes/sha2.js";
import { identityFromSeedB64 } from "./identity";
import { rankTransports, relayedTransports, transportOrder, type NativeEndpoint, type NativeBinding, type PairedTransport, type TransportDescriptors } from "./pairedTransports";
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
import { EXPECT_PEER_MS, LinkSession, type LinkStatus, type PeerPresence, type PollIntervals } from "./link";
import type { ResolvedLink } from "./records";
import { servicesFromWire, servicesToWire, type ServiceAd } from "./services";
import { PairedHttp } from "./pairedHttp";
import { CALLS_CAPABILITY, FILES_CAPABILITY, SERVICES_CAPABILITY, SESSION_CAPABILITIES_FRAME, SessionCapabilities, type SessionCapability } from "./pairedCapabilities";
import { FILE_FRAMES } from "./chatFiles";
import { PAIRED_CALL_FRAME, PairedCalls, parsePairedCallFrame } from "./pairedCalls";
import { traceLink } from "./linkTrace";
import type { PkarrTransport } from "./transport";
import { PairingTracker, type PairingProgress, type PairingRole } from "./pairingProgress";

/**
 * One link to one peer, complete: Pkarr presence and signaling, the WebRTC
 * data link, and the services multiplexed on top of it. Platform specifics
 * (how to reach Pkarr, how to create a peer connection, how to reach a local
 * HTTP server) are injected, so Desktop and Browser run the same code.
 */
/** Unanswered offers are repeated less and less often: 1.5, 3, 6, then every 12 minutes. */
/** After a failed attempt: 20 s, then doubling up to 3 min. Someone opening the chat starts it over. */
const AUTO_CONNECT_RETRY_MS = 20_000;
/** A native transport that fails this many attempts in a row is skipped for `DEMOTE_MS`, while another remains (WISP 100). */
/** Pinned over the DHT with no stream up this long after, a first pairing shows as on the DHT (WISP 400). */
export const DHT_PIN_GRACE_MS = 10_000;
export const DEMOTE_AFTER_FAILURES = 3;
export const DEMOTE_MS = 60 * 60_000;
const AUTO_CONNECT_MAX_RETRY_MS = 3 * 60_000;
/**
 * A first pairing is different: the contact is right there, having just read the invite, so an attempt
 * that did not make it in `PAIRING_ATTEMPT_MS` is given up and the next one starts after `PAIRING_RETRY_MS`
 * (doubling up to `PAIRING_MAX_RETRY_MS`), instead of the 90 s and 20 s a saved contact's reconnect waits.
 */
export const PAIRING_ATTEMPT_MS = 15_000;
export const PAIRING_RETRY_MS = 3_000;
const PAIRING_MAX_RETRY_MS = 30_000;
/** A packet published this recently is fresh enough for whoever comes back to the chat. */
const RECENTLY_PUBLISHED_MS = 5_000;
/** An inviter that sees the joiner without its offer waits this long for one before offering itself. */
export const INVITER_DIAL_GRACE_MS = 2_500;
/**
 * Liveness of a paired session: a ping this often, and the session is taken for dead after this many
 * pings in a row with nothing at all back. Counted in pings, not seconds, so a throttled background
 * tab (timers once a minute) is not mistaken for a dead peer. Only once the peer has answered a ping:
 * older apps drop the frame and must not be cut off for it.
 */
export const LIVENESS_PING_MS = 15_000;
/**
 * After a live switch the old channel stays open this long, unread, before it is closed: the contact swaps on its own
 * side a round trip later, and seeing its current channel close first would make it drop the whole session.
 */
export const SWITCH_RETIRE_MS = 3_000;
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
  /**
   * The contact chose a transport for this chat just now (its switch intent went up on the open session), or went
   * back to automatic (its intent fell to 0). Nothing new on the wire: read from the `paired-policy` it already sends.
   */
  onPeerTransportChoice?(transport: PairedTransport | "automatic"): void;
  /**
   * A switch to `target` could not connect and the session stayed where it was (both allow fallback). `reason` is
   * known on the side that dialled; the other side learns only that it did not happen.
   */
  onTransportSwitchFailed?(target: PairedTransport, reason?: string): void;
  /** A live transport switch completed: the session now runs over `to`, and nothing reconnected. */
  onTransportSwitched?(from: PairedTransport | undefined, to: PairedTransport): void;
  /** Round trip of a liveness ping on the open session, in milliseconds. */
  onRtt?(ms: number): void;
  onTransportDiscovery?(descriptors: TransportDescriptors, transports: PairedTransport[], fallback: boolean): Promise<void>;
  onPairingState?(state: PairingState): void;
  /** How far a first pairing got (`pairingProgress` option): every change, up to `live`. */
  onPairingProgress?(progress: PairingProgress): void;
  onMessage?(message: IncomingMessage): void | Promise<void>;
  onPresence?(presence: PeerPresence): void;
  /** A paired contact's profile picture, already checked; `null` when they removed it. */
  onPeerAvatar?(avatar: string | null): void;
  /**
   * The name a paired contact asked to be shown by, already checked; `null` when they have none (never set,
   * removed, or not shared). Said on every session, so what arrives here is the contact's current choice.
   */
  onPeerNick?(nick: string | null): void;
  onMessageReceipt?(id: string): void | Promise<void>;
  /**
   * What the contact's app says about held items (`hold/1`): whether it accepts them (from the handshake, or
   * a `paired-hold` frame on the session) and the highest sequence it has held for this side, if it said.
   */
  onHold?(state: { peerAllows: boolean; peerTop?: number }): void | Promise<void>;
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
  /** A files/3 frame (`FILE_FRAMES`), only while both sides agreed `files/3` on the open session. */
  onFilesFrame?(frame: Record<string, unknown>): void | Promise<void>;
  /**
   * files/3 can flow (a session agreed it and is open), or no longer can. Said again, open, after a live
   * transport switch: frames on the old channel may be lost, and offering again puts both sides in step.
   */
  onFilesSession?(open: boolean): void;
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

const PAYMENT_METHODS: PaymentMethodName[] = ["cashu", "lightning", "arkade", "usdt", "bark", "bitcoin", "fedimint", "spark"];

export interface GhostLinkOptions {
  /** Ways of paying this chat allows. One that is off is not offered in the handshake, sent or accepted. Absent: allowed. */
  paymentMethods?: Partial<Record<PaymentMethodName, boolean>>;
  arkPaymentsSupport?: boolean;
  usdtPaymentsSupport?: boolean;
  barkPaymentsSupport?: boolean;
  /** Announce private groups (WISP 900) on the open session. Announced after the handshake, like `paired-payments`, so a full offer stays within what older apps accept. */
  groupsSupport?: boolean;
  /** Offer `hold/1`: accept items held for this side, and hold items for the contact while it is away. */
  holdSupport?: boolean;
  /** Offer `calls/1` on paired sessions: this app can place and take calls (WebRTC media and capture). */
  callsSupport?: boolean;
  /** Offer `services/1` on paired sessions: this app can serve granted local web apps and open the contact's. */
  servicesSupport?: boolean;
  /** Offer `files/3` on paired sessions: files of any size, offered, resumed and checked (`chatFiles.ts`). */
  largeFilesSupport?: boolean;
  dht?: {
    state?: DhtDeliveryState; save(state: DhtDeliveryState): Promise<void>; pollMs?: number;
    /** This side's capability-record revision, told in every envelope (WISP 03). */
    capsRev?(): number | undefined;
    /** An envelope from the contact named this revision of its capability record. */
    peerCapsRev?(rev: number): void;
    /** Whether the contact's capability record accepts DHT text; absent or unknown: it does. */
    peerAcceptsText?(): boolean;
  };
  rtcAvailable?: boolean;
  native?: { peerDescriptors?: TransportDescriptors; peerTransports?: PairedTransport[]; peerFallback?: boolean; preferred?: PairedTransport; fallback?: boolean };
  params: LinkParams;
  pairing?: { credentials: PairingCredentials; pinPeer: (key: string, signedSignals?: boolean) => Promise<void>; verifyPeer?: (key: string) => Promise<void>; trustOnFirstUse?: boolean };
  /**
   * A chat that was never paired: follow its first pairing (`onPairingProgress`), and pace its attempts
   * for a contact who is right there. `startedAt`: when the invite was made or joined.
   */
  pairingProgress?: { role: PairingRole; startedAt: number };
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
  private dhtPinGrace: ReturnType<typeof setTimeout> | null = null;
  /** Native attempts that failed in a row, and transports demoted until when (WISP 100, demotion). */
  private nativeFailures = new Map<PairedTransport, number>();
  private demotedUntil = new Map<PairedTransport, number>();
  private connectionEpoch = 0;
  private switchAllowedUntil = 0;
  private switchAck: (() => void) | null = null;
  private readonly switcher: TransportSwitch;
  private candidate: { channel: FrameChannel; session: PairedSession; binding?: NativeBinding; reject(error: Error): void } | null = null;
  private candidateEpoch = 0;
  /** Channels a switch replaced, closed after `SWITCH_RETIRE_MS` (or at once on disconnect). */
  private retiring = new Map<FrameChannel, { timer: ReturnType<typeof setTimeout>; close(): void }>();
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
  /** The contact's word on held items on this session; null until it says. */
  private peerHoldOverride: boolean | null = null;
  private peerNickOverride: string | null = null;
  /** Group protocol versions the peer announced on this session; null until it does. */
  private peerGroupVersions: number[] | null = null;
  /** What each side announced after the handshake (`paired-capabilities`): calls, services. */
  private readonly sessionCapabilities = new SessionCapabilities(() => this.offeredCapabilities());
  private readonly pairedCalls = new PairedCalls();
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private peerAnswersPings = false;
  /** When the ping awaiting its pong went, and the round trip last measured on this session. */
  private pingSentAt = 0;
  private rtt?: number;
  /** The contact's transport policy as last seen on this session, to tell its explicit choices apart. */
  private peerPolicySeen: { intent: number } | null = null;
  private unansweredPings = 0;
  private openWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  /** Set while a WebRTC attempt this side dialled is pending: the ranked transports to try if it fails. */
  private afterRtc?: { epoch: number; rest: PairedTransport[] };
  private lastAutoConnectAt = 0;
  private autoConnectFailures = 0;
  /** The peer's packet I last looked fast for its offer after (its timestamp): once per packet. */
  private offerAwaitedFor = 0;
  /** Whether the stream was blocked (DHT-only on either side) when last looked at. */
  private streamWasBlocked: boolean;
  /** The contact's latest `_rtc` signal while the stream was blocked. */
  private heldSignal: string | null = null;
  /** The link packet of a DHT-only contact its mailbox was last read early for (its timestamp): once per packet. */
  private leftDhtSeenFor = 0;
  /** The first pairing of this chat, while it is one (`pairingProgress` option, no peer key yet). */
  private readonly tracker: PairingTracker | null;
  private lastDataLinkState: DataLinkState = "idle";
  /** When an inviter first saw the joiner on the network (0: not yet). */
  private peerSeenAt = 0;

  constructor(options: GhostLinkOptions) {
    this.options = options;
    this.deliveryMode = options.params.deliveryMode ?? "stream";
    // A DHT-only invite pairs through its mailbox, not through these stages.
    this.tracker = options.pairingProgress && options.pairing && !options.pairing.credentials.peerKey && this.deliveryMode !== "dht"
      ? new PairingTracker(options.pairingProgress.role, options.pairingProgress.startedAt, progress => {
        traceLink(this.myPubKeyZ32, "progress", { stage: progress.stage, attempt: progress.attempt, peerSeen: progress.peerSeen, reason: progress.reason, retryable: progress.retryable, transport: progress.transport });
        options.events?.onPairingProgress?.(progress);
      }) : null;
    this.dht = options.params.profile && options.pairing && options.dht ? new DhtDelivery({
      params: options.params, mode: this.deliveryMode, state: options.dht.state, credentials: options.pairing.credentials, transport: options.transport,
      save: options.dht.save, pollMs: options.dht.pollMs,
      capsRev: options.dht.capsRev, peerCapsRev: options.dht.peerCapsRev, peerAcceptsText: options.dht.peerAcceptsText,
      // A first contact verified on the DHT pins the contact: the pairing is on the DHT until a stream is up.
      pin: async key => {
        await options.pairing!.pinPeer(key, true);
        if (this.isDataLinkOpen || !this.tracker || this.tracker.done) return;
        if (this.deliveryMode === "dht") { this.tracker.onDht("chosen"); return; }
        // A stream is usually a moment away: the pairing shows its steps, and ends on the DHT only if no stream
        // makes it (an attempt fails), or none is under way a little later.
        this.tracker.pinnedOverDht();
        if (!this.dhtPinGrace) this.dhtPinGrace = setTimeout(() => {
          this.dhtPinGrace = null;
          if (!this.isDataLinkOpen && this.tracker?.progress.stage !== "on-dht") this.tracker?.onDht("waiting");
        }, DHT_PIN_GRACE_MS);
      },
      message: async message => { await options.events?.onMessage?.({ ...message, via: "pkarr" }); },
      receipt: async id => { await options.events?.onMessageReceipt?.(id); },
      changed: view => {
        options.events?.onDhtDelivery?.(view);
        if (view.error?.includes("does not match")) this.dhtKeyRejected();
        this.streamBlockChanged();
        // A contact who chose DHT only (a ghostly1 code carries no mode) paired through the mailbox: the first
        // pairing ends on the DHT, chosen (WISP 400), and the stream attempt it will never answer is not a failure.
        if (this.dht?.peerMode === "dht" && options.pairing?.credentials.peerKey && this.tracker && !this.tracker.done && this.tracker.progress.reason !== "chosen") this.tracker.onDht("chosen");
        if (this.streamBlocked) {
          if (this.channel || this.dialing || this.dataLink.state !== "idle") this.disconnect();
          this.emitDeliveryState();
        } else if (!this.paired) this.maybeAutoConnect(this.session.peerPresence);
      },
    }) : null;
    this.streamWasBlocked = this.streamBlocked;
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
      // A joiner dials the moment it sees the inviter: its offer goes in its first packet.
      firstPublish: this.tracker && options.pairingProgress?.role === "joiner" ? "after-first-poll" : "at-start",
      events: {
        // The first look decided nothing to dial: say we are here now (a dial says it with its offer).
        onFirstPoll: () => { if (!this.dialing) this.session.ensureAdvertised(); },
        onMessages: (messages, batch) => {
          if (options.params.profile) return;
          for (const m of messages) events.onMessage?.({ ...m, via: "pkarr", batch });
        },
        onPresence: (presence) => {
          if (presence.online) this.tracker?.sawPeer();
          // A first contact under way: a fresh packet of the contact says its envelope is a read away.
          if (presence.online && !options.pairing?.credentials.peerKey && Date.now() - presence.lastPacketAt < EXPECT_PEER_MS) this.dht?.expect();
          events.onPresence?.(this.mergePresence(presence));
          this.peerMayHaveLeftDht(presence);
          this.maybeAutoConnect(presence);
        },
        onPublish: result => { if (result.error) this.tracker?.failed("publish", true, result.error); else this.tracker?.published(); },
        onPeerAck: (ack) => events.onPeerAck?.(ack),
        onCallSignal: (signal) => { if (!options.params.profile) events.onCallSignal?.(signal); },
        onRtcSignal: signal => {
          traceLink(this.myPubKeyZ32, "rtc-signal-in", { held: this.streamBlocked });
          // Seen once only: kept, and answered as soon as nothing blocks the stream any more.
          if (this.streamBlocked) { this.heldSignal = signal; return; }
          this.handleRtcSignal(signal);
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
          if (signal && this.tracker) {
            const kind = (JSON.parse(signal) as { t?: string }).t;
            if (kind === "o") this.tracker.offerSent(); else if (kind === "a") this.tracker.answerSent();
          }
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
        if (this.streamBlocked || this.keyStopped) { channel.close(); return; }
        const plan = this.switcher.pending;
        if (plan?.choices.includes("webrtc/1") && this.paired?.state.status === "ready") {
          void this.attachCandidate(channel, undefined, plan).catch(() => {});
        } else if (this.activeBinding) channel.close(); else this.attach(channel);
      },
      onClose: () => { if (!this.activeBinding) this.detach(); },
      onState: (state) => {
        traceLink(this.myPubKeyZ32, "datalink", { state });
        this.trackDataLink(state);
        if (this.activeBinding) return;
        events.onDataLinkState?.(state);
        if (state === "open") this.afterRtc = undefined;
        if (state !== "idle") return;
        const next = this.afterRtc;
        if (next && next.epoch === this.connectionEpoch && !this.stopped && !this.channel && !this.streamBlocked) {
          // Still inside dial() (WebRTC failed while starting): the dial loop goes on by itself.
          if (this.dialing) return;
          this.afterRtc = undefined;
          void this.dialAfterRtc(next); return;
        }
        this.afterRtc = undefined;
        this.rejectWaiters(new GhostlyHttpError("unreachable", "Could not connect to the peer"));
      },
      attemptTimeoutMs: this.tracker ? PAIRING_ATTEMPT_MS : undefined,
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
        const before = this.peerPolicySeen;
        this.peerPolicySeen = { intent: policy.intent };
        if (before && policy.intent > before.intent) options.events?.onPeerTransportChoice?.(policy.preferred);
        // Intent 0 is only ever "automatic": the contact dropped its standing choice.
        else if (before && before.intent > 0 && policy.intent === 0) options.events?.onPeerTransportChoice?.("automatic");
        this.peerDescriptors = policy.descriptors;
        this.peerTransports = transportOrder(policy.available, policy.preferred, true);
        this.peerFallback = policy.fallback;
        void options.events?.onTransportDiscovery?.(policy.descriptors, this.peerTransports, policy.fallback).catch(() => {});
        this.emitPairingState();
      },
      state: (error, target) => { this.transitionError = error; this.transitionTarget = target; this.emitPairingState(); },
      prepare: (plan, dial) => { if (dial) void this.prepareSwitch(plan); },
      cancel: () => this.cancelCandidate(),
      kept: (target, reason) => options.events?.onTransportSwitchFailed?.(target, reason),
    });
  }

  get myPubKeyZ32(): string {
    return this.session.identity.pubKeyZ32;
  }

  /** The first pairing's stages, read off the data link's states. */
  private trackDataLink(state: DataLinkState): void {
    const was = this.lastDataLinkState;
    this.lastDataLinkState = state;
    const tracker = this.tracker;
    if (!tracker || tracker.done) return;
    if (state === "answering") tracker.offerReceived();
    else if (state === "connecting" && was === "offering") tracker.answerReceived();
    else if (state === "idle") {
      if (was === "offering") tracker.failed("timeout", true);
      else if (was === "answering" || was === "connecting") tracker.failed("transport", true);
      else if (was === "open") tracker.reset();
    }
  }

  /** How far the first pairing got; absent for a chat that was paired before, or has no `pairingProgress`. */
  get pairingProgress(): PairingProgress | undefined { return this.tracker?.progress; }

  private handleRtcSignal(signal: string): void {
    const options = this.options, credentials = options.pairing?.credentials;
    const verified = options.params.profile ? verifyPairedSignal(signal, options.params.peerPubKeyZ32,
      this.myPubKeyZ32, credentials?.peerKey, credentials?.requireSignedSignals) : signal;
    if (verified) void this.dataLink.handleSignal(verified);
    else if (credentials?.requireSignedSignals && !this.isDataLinkOpen) {
      // Only a valid signature from another key establishes a mismatch.
      // Malformed or forged traffic cannot claim a new contact identity.
      const keyMismatch = !!credentials.peerKey && !!verifyPairedSignal(signal,
        options.params.peerPubKeyZ32, this.myPubKeyZ32, undefined, true);
      this.securityRejected = true;
      // Signed by another key than the one pinned (on either path): the chat stops on both layers.
      if (keyMismatch) { this.keyStopped = true; traceLink(this.myPubKeyZ32, "key-stop", { path: "signal" }); }
      this.tracker?.failed(keyMismatch ? "key-mismatch" : "rejected", false);
      options.events?.onPairingState?.({ status: "error", keyMismatch, error: keyMismatch
        ? "This connection uses a different participation key. The saved contact has not been replaced; use a fresh invitation for a new contact."
        : "Ignored an unauthenticated discovery signal. Keep both peers on the updated version; the saved key has not been replaced.",
      });
    }
  }

  /**
   * Leaving DHT-only takes both sides: each is blocked from a live link until it has seen the other one
   * leave too. The moment it is not, the link is dialled or answered at once: the wait between failed
   * attempts starts over, the contact's offer (or its presence) is looked for fast, and an offer that
   * came in while blocked is answered now instead of timing out on the contact's side (90 s, then its
   * backoff) before it offers again.
   */
  private streamBlockChanged(): void {
    const blocked = this.streamBlocked, was = this.streamWasBlocked;
    this.streamWasBlocked = blocked;
    if (blocked || !was) return;
    traceLink(this.myPubKeyZ32, "unblocked", { held: !!this.heldSignal });
    this.autoConnectFailures = 0;
    this.lastAutoConnectAt = 0;
    this.session.expectPeer();
    const held = this.heldSignal;
    this.heldSignal = null;
    if (held) this.handleRtcSignal(held);
  }

  /**
   * A DHT-only contact runs no link session, so it does not advertise itself on the link's key: a fresh
   * packet there that does is it leaving DHT-only. Its mailbox, which says so, is read now rather than at
   * the next poll.
   */
  private peerMayHaveLeftDht(presence: PeerPresence): void {
    if (!this.dht || this.dht.peerMode !== "dht" || this.deliveryMode === "dht" || !presence.online) return;
    if (Date.now() - presence.lastPacketAt >= EXPECT_PEER_MS || presence.lastPacketAt === this.leftDhtSeenFor) return;
    this.leftDhtSeenFor = presence.lastPacketAt;
    traceLink(this.myPubKeyZ32, "peer-link-packet", { age: Date.now() - presence.lastPacketAt });
    this.dht.refresh();
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
      // While layer 1 carries the chat its mailbox is read every 5 minutes; lost, at once (WISP 403).
      this.dht?.setLive(open);
      if (!open) this.pairedFiles?.closeAll();
      this.options.events?.onDataLinkState?.(open ? "open" : "idle");
    }
    this.options.events?.onPairingState?.({ ...state,
      ...(blocked ? { status: this.transitionError ? "error" as const : "negotiating" as const, error: this.transitionError } : {}),
      transitionTarget: this.transitionTarget, transitionError: this.transitionError,
    });
    this.emitFilesSession();
  }

  get presence(): PeerPresence {
    return this.mergePresence(this.session.peerPresence);
  }

  private get streamBlocked(): boolean { return this.deliveryMode === "dht" || this.dht?.peerMode === "dht"; }
  /**
   * The DHT path met a participation key other than the pinned one: a security rejection, which stops the chat
   * on both layers until the person acts (WISP 400), never a reason to fall back to the other path.
   */
  private keyStopped = false;
  private dhtKeyRejected(): void {
    if (this.keyStopped) return;
    this.keyStopped = true;
    traceLink(this.myPubKeyZ32, "key-stop", { path: "dht" });
    this.tracker?.failed("key-mismatch", false);
    if (this.channel || this.dialing || this.dataLink.state !== "idle") this.disconnect();
    this.options.events?.onPairingState?.({ status: "error", keyMismatch: true, peerKey: this.options.pairing?.credentials.peerKey,
      error: "This chat met a participation key other than your contact's. It has stopped; the saved contact has not been replaced." });
  }
  get textDelivery(): "stream" | "dht" | "unavailable" {
    if (this.isDataLinkOpen) return "stream";
    if (!this.dht || this.securityRejected || this.keyStopped || this.dht.view.error?.includes("key does not match")) return "unavailable";
    if (this.deliveryMode === "dht") return "dht";
    return !this.channel && !!this.options.pairing?.credentials.peerKey && !!this.dht.peerMode ? "dht" : "unavailable";
  }
  validateText(text: string, timestamp: number, id: string): string | null {
    if (this.textDelivery === "dht") return this.dht!.validate(text, timestamp, id);
    return this.canSendText ? null : "No authenticated text delivery method is available.";
  }
  get canSendText(): boolean { return this.textDelivery !== "unavailable"; }
  get dhtDelivery(): DhtDeliveryView | undefined { return this.dht?.view; }
  /** The chat is on screen: on the DHT its mailbox is read at the signaling pace (WISP 403, poll pace). */
  setChatActive(active: boolean): void {
    this.session.setActive(active);
    this.dht?.setActive(active);
  }
  private emitDeliveryState(): void {
    if (!this.streamBlocked) return;
    const credentials = this.options.pairing?.credentials;
    const error = this.dht?.view.error;
    this.options.events?.onPairingState?.({ status: error ? "error" : credentials?.peerKey ? "ready" : "connecting",
      peerKey: credentials?.peerKey, code: this.dht?.comparisonCode, verified: !!credentials?.peerKey && credentials.verifiedPeerKey === credentials.peerKey, error });
  }
  async setDeliveryMode(mode: DeliveryMode): Promise<void> {
    if (!this.dht) throw new Error("DHT delivery is unavailable for this conversation.");
    traceLink(this.myPubKeyZ32, "set-mode", { mode, peerMode: this.dht.peerMode, dials: this.myPubKeyZ32 < this.options.params.peerPubKeyZ32 });
    this.deliveryMode = mode;
    // Someone chose this just now: attempts that failed before are no reason to wait.
    this.autoConnectFailures = 0;
    this.lastAutoConnectAt = 0;
    if (mode === "dht") { this.disconnect(); this.heldSignal = null; }
    // The link session runs before the contact can learn the new method (from the envelope setMode publishes).
    else this.session.start();
    await this.dht.setMode(mode);
    if (mode === "dht") {
      await this.session.stop(false);
      await Promise.allSettled([...this.endpoints.keys()].map(t => this.releaseEndpoint(t)));
    }
    this.streamBlockChanged();
    this.emitDeliveryState();
  }
  start(): void {
    if (this.deliveryMode !== "dht") this.session.start();
    // A joiner has just opened the invite: the inviter is there, and its first-contact envelope is worth reading
    // at the signaling pace now (an inviter speeds up when the joiner's fresh packet shows).
    if (this.tracker && !this.tracker.done && this.options.pairingProgress?.role === "joiner") this.dht?.expect();
    void this.dht?.start();
  }

  async stop(announce = true): Promise<void> {
    this.stopped = true;
    if (this.dhtPinGrace) clearTimeout(this.dhtPinGrace);
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
        this.tracker?.failed("transport", true, error instanceof Error ? error.message : String(error));
        this.options.events?.onPairingState?.({ status: "error", error: error instanceof Error ? error.message : String(error) });
        this.rejectWaiters(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /** Closes what a switch replaced once the contact has had time to move too. */
  private retire(old: FrameChannel, also: () => void): void {
    if (this.retiring.has(old)) return;
    const close = () => { this.retiring.delete(old); old.close(); also(); };
    this.retiring.set(old, { close, timer: setTimeout(close, SWITCH_RETIRE_MS) });
  }
  private closeRetired(): void {
    for (const { timer, close } of [...this.retiring.values()]) { clearTimeout(timer); close(); }
  }

  disconnect(): void {
    this.closeRetired();
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

  /** What the contact's app can use on this link, as it last said (on the open session, or remembered). */
  get peerAvailableTransports(): PairedTransport[] | undefined {
    return this.switcher.peerPolicy?.available ?? this.peerTransports;
  }
  /** The open session goes through relays (WISP 100, "Relayed"): their hosts, this side's first. */
  get relayedPath(): { relays: string[] } | undefined {
    const transport = this.activeBinding?.transport;
    if (!transport || !this.isDataLinkOpen) return undefined;
    const local = this.localDescriptors(), remote = this.switcher.peerPolicy?.descriptors ?? this.peerDescriptors;
    if (!relayedTransports(local, remote).includes(transport)) return undefined;
    const relays: string[] = [];
    for (const descriptor of [local[transport], remote[transport]]) {
      const relay = (descriptor as { relay?: unknown } | undefined)?.relay;
      if (typeof relay !== "string") continue;
      try { const host = new URL(relay).host.replace(/\.$/, ""); if (!relays.includes(host)) relays.push(host); } catch { /* Not a URL: not shown. */ }
    }
    return { relays };
  }
  /** The round trip last measured on the open session; unknown until a ping was answered. */
  get rttMs(): number | undefined { return this.isDataLinkOpen ? this.rtt : undefined; }

  /**
   * The transports a session with this contact would cross a relay on: those either side reaches only
   * through one (a browser's HyperDHT or Iroh), per the latest descriptors both sides gave.
   */
  get relayedTransports(): PairedTransport[] {
    return relayedTransports(this.localDescriptors(), this.switcher.peerPolicy?.descriptors ?? this.peerDescriptors);
  }

  /** This side's native descriptors, for its capability record (WISP 03): what a contact dials without WebRTC first. */
  get nativeDescriptors(): TransportDescriptors {
    return Object.fromEntries([...this.endpoints].map(([transport, endpoint]) => [transport, endpoint.descriptor])) as TransportDescriptors;
  }

  /**
   * The contact's capability record named its native transports and how to dial them: a chat whose WebRTC never
   * connected can still try Iroh or HyperDHT. What a session said (fresher, transcript-bound) is not replaced.
   */
  learnPeerTransports(transports: PairedTransport[], descriptors: TransportDescriptors): void {
    let changed = false;
    for (const t of ["iroh/1", "hyperdht/1"] as const) if (descriptors[t] && !this.peerDescriptors[t]) { this.peerDescriptors = { ...this.peerDescriptors, [t]: descriptors[t] }; changed = true; }
    if (!this.peerTransports && transports.length) { this.peerTransports = transports; this.peerFallback = true; changed = true; }
    if (changed) traceLink(this.myPubKeyZ32, "record-transports", { transports });
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

  /**
   * `automatic`: this side stops choosing. Its policy still says `preferred` (the app's default) for the order
   * it dials in, but its switch intent drops to none, so the contact's explicit choice wins on the open session
   * and, without one, the current transport is kept. Never adds an unavailable adapter either way.
   */
  /**
   * `automatic`: back to the app's rule (no choice of this side's). `choice` false: the same transport with another
   * fallback (the Fallback switch), a policy change that raises no switch intent. A choice of the transport this side
   * already chose raises none either while that choice stands (see `TransportSwitch.chose`).
   */
  async setTransportPreference(preferred: PairedTransport, fallback: boolean, automatic = false, choice = true): Promise<void> {
    if (!this.options.params.profile || !this.availableTransports.includes(preferred)) throw new Error("Transport unavailable in this runtime");
    const again = this.preferred === preferred;
    this.preferred = preferred; this.fallback = fallback;
    if (this.paired?.state.status === "ready") {
      if (!this.paired.peerTransportSwitchSupport) {
        if (automatic) return;
        this.transitionError = "Your contact needs an updated app to negotiate a transport change.";
        this.emitPairingState(); return;
      }
      if (automatic) this.switcher.changed("automatic");
      else if (choice) this.switcher.chose(again);
      else this.switcher.changed(false);
      this.emitPairingState(); return;
    }
    // A choice made while offline carries no intent into the next session; going automatic clears an older one.
    if (automatic) this.switcher.changed("automatic");
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
      const relayed = relayedTransports(this.localDescriptors(), this.peerDescriptors);
      // Cached availability is a routing hint, not permission: the fresh signed
      // PairedSession offer enforces the peer's current (possibly offline-edited) policy.
      const remembered = this.peerTransports && rankTransports(local, this.peerFallback ? this.peerTransports : this.peerTransports.slice(0, 1), relayed);
      const ranked = remembered?.length ? remembered : this.peerTransports ? rankTransports(local, this.peerTransports, relayed) : local.filter(t => t === "webrtc/1");
      // A standing explicit choice goes first: the session starts where the agreement would move it anyway.
      const chosen = this.switcher.chosenTarget;
      const choices = chosen && ranked.includes(chosen) ? [chosen, ...ranked.filter(t => t !== chosen)] : ranked;
      if (!choices.length) throw new Error("No common available transport. Initial pairing requires WebRTC on both peers.");
      const fallback = this.fallback && this.peerFallback;
      let lastError: unknown;
      // A transport that keeps failing is tried last for an hour, not first on every attempt.
      const now = Date.now(), demoted = (t: PairedTransport) => (this.demotedUntil.get(t) ?? 0) > now;
      const ordered = choices.length > 1 ? [...choices.filter(t => !demoted(t)), ...choices.filter(demoted)] : choices;
      for (const [index, transport] of ordered.entries()) {
        if (index > 0 && !fallback) break;
        if (transport === "webrtc/1") {
          // WebRTC settles later (ICE can fail minutes from now): what ranks after it is where a failed attempt
          // goes, typically a relayed Iroh behind a symmetric NAT (WISP 100, "Relayed"), before the DHT floor.
          this.afterRtc = fallback && index + 1 < ordered.length ? { epoch, rest: ordered.slice(index + 1) } : undefined;
          await this.dataLink.connect();
          if (!this.afterRtc || this.dataLink.state !== "idle" || epoch !== this.connectionEpoch) return;
          this.afterRtc = undefined; continue;
        }
        const result = await this.dialNative(transport, epoch);
        if (result === true) return;
        lastError = result;
      }
      throw lastError ?? new Error("No permitted transport could connect");
    } finally { if (epoch === this.connectionEpoch) this.dialing = false; }
  }

  private localDescriptors(): TransportDescriptors {
    return Object.fromEntries([...this.endpoints].map(([transport, endpoint]) => [transport, endpoint.descriptor]));
  }

  /** True once attached (or when a newer attempt took over); the error otherwise. */
  private async dialNative(transport: PairedTransport, epoch: number): Promise<true | Error> {
    const endpoint = this.endpoints.get(transport as NativeEndpoint["transport"]);
    const descriptor = this.peerDescriptors[transport as NativeEndpoint["transport"]];
    if (!endpoint || !descriptor) return new Error("Peer native address unavailable; reconnect WebRTC once to exchange endpoints");
    try {
      const { channel, binding } = await endpoint.connect(descriptor);
      this.nativeFailures.delete(transport); this.demotedUntil.delete(transport);
      if (this.stopped || epoch !== this.connectionEpoch || this.channel) { channel.close(); return true; }
      this.attach(channel, binding); return true;
    } catch (error) {
      if (epoch !== this.connectionEpoch) return true;
      // Three failures in a row demote it for an hour (WISP 100).
      const failures = (this.nativeFailures.get(transport) ?? 0) + 1;
      if (failures >= DEMOTE_AFTER_FAILURES) { this.nativeFailures.delete(transport); this.demotedUntil.set(transport, Date.now() + DEMOTE_MS); traceLink(this.myPubKeyZ32, "demote", { transport }); }
      else this.nativeFailures.set(transport, failures);
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  /** A WebRTC attempt this side dialled ended without opening: the next ranked transports, in order. */
  private async dialAfterRtc(next: { epoch: number; rest: PairedTransport[] }): Promise<void> {
    this.dialing = true;
    try {
      let lastError: Error | undefined;
      for (const transport of next.rest) {
        if (transport === "webrtc/1") continue;
        const result = await this.dialNative(transport, next.epoch);
        if (result === true) return;
        lastError = result;
      }
      if (next.epoch === this.connectionEpoch)
        this.rejectWaiters(new GhostlyHttpError("unreachable", lastError ? `Could not connect to the peer: ${lastError.message}` : "Could not connect to the peer"));
    } finally { if (next.epoch === this.connectionEpoch) this.dialing = false; }
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
    if (this.options.params.profile) {
      // Kept until cleared, so what the session could not carry goes on the next one while still fresh.
      const frame = this.pairedCalls.set(signal);
      if (!frame) return;
      if (!this.supportsCalls || !this.channel) throw new Error(this.callsUnavailable ?? "Calls need a live connection");
      this.channel.send(JSON.stringify(frame));
      return;
    }
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
      if (!this.supportsServices) throw new GhostlyHttpError("unavailable", this.isDataLinkOpen
        ? "Your contact's app cannot share web apps in this chat, or needs an updated Ghostly" : "Shared apps need a live connection");
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

  /**
   * Only the lower key offers, so two peers coming online together do not collide. A first pairing is
   * the exception: the joiner offers, whatever its key, in the very packet that says it is here (one hop
   * less than presence, then the inviter's offer), and the inviter waits for that offer. An inviter that
   * sees the joiner but no offer for `INVITER_DIAL_GRACE_MS` (an app from before this rule) offers itself;
   * the lower-key rule settles any collision, on both sides.
   */
  private maybeAutoConnect(presence: PeerPresence): void {
    if (this.streamBlocked || this.keyStopped || !this.options.autoConnect || !presence.online || this.channel || this.dataLink.state !== "idle") return;
    // On the DHT the chat is usable: layer 1 is retried at the background pace (WISP 100), not the pairing's.
    // A pin over the DHT alone changes nothing here: the joiner still knocks and the inviter still answers.
    const pairing = !!this.tracker && !this.tracker.done && this.tracker.progress.stage !== "on-dht";
    const role = pairing ? this.options.pairingProgress?.role : undefined;
    if (role === "inviter") {
      this.peerSeenAt ||= Date.now();
      if (Date.now() - this.peerSeenAt < INVITER_DIAL_GRACE_MS) { this.session.expectPeer(); return; }
    } else if (role !== "joiner" && this.myPubKeyZ32 > this.options.params.peerPubKeyZ32) {
      // The other side dials as soon as it sees me. A packet of its that is new to me and fresh says it just
      // (re)appeared, so its offer is a poll away; an old one (a contact online for a while, as when this app
      // starts) says nothing is coming now, and looking fast for it would only spend the relays' budget.
      const fresh = Date.now() - presence.lastPacketAt < EXPECT_PEER_MS;
      if (fresh && presence.lastPacketAt !== this.offerAwaitedFor) { this.offerAwaitedFor = presence.lastPacketAt; this.session.expectPeer(); }
      return;
    }
    // A first pairing tries again sooner: the contact just read the invite and is waiting.
    const wait = pairing ? Math.min(PAIRING_RETRY_MS * 2 ** this.autoConnectFailures, PAIRING_MAX_RETRY_MS)
      : Math.min(AUTO_CONNECT_RETRY_MS * 2 ** this.autoConnectFailures, AUTO_CONNECT_MAX_RETRY_MS);
    if (Date.now() - this.lastAutoConnectAt < wait) { traceLink(this.myPubKeyZ32, "dial-backoff", { failures: this.autoConnectFailures, left: wait - (Date.now() - this.lastAutoConnectAt) }); return; }
    traceLink(this.myPubKeyZ32, "dial", { failures: this.autoConnectFailures });
    this.lastAutoConnectAt = Date.now();
    this.autoConnectFailures++;
    void this.dial().catch(() => { this.tracker?.failed("transport", true); });
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

  /** An empty `n` says there is no name to show (none set, removed, or not shared). */
  private sendPairedNick(): void {
    if (!this.options.params.profile || !this.channel || !this.isDataLinkOpen) return;
    try { this.channel.send(JSON.stringify({ t: "paired-nick", n: this.options.nick ?? "" })); } catch { /* sent again on the next session */ }
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
  /** Fedimint: only ever through the contact's `paired-payments` list, like on-chain. */
  get supportsFedimintPayments(): boolean { return this.allowsPayment("fedimint"); }
  /** Spark: like on-chain, only ever through the contact's `paired-payments` list. */
  get supportsSparkPayments(): boolean { return this.allowsPayment("spark"); }
  /** Payment messages flow at all: some way of paying is allowed by both sides. */
  get supportsPayments(): boolean { return PAYMENT_METHODS.some(m => this.allowsPayment(m)); }
  /** The contact accepts held items: its latest word on this session, else its handshake offer. */
  get peerAllowsHold(): boolean {
    if (!this.options.params.profile || !this.paired || this.paired.state.status !== "ready") return false;
    return this.peerHoldOverride ?? this.paired.peerHoldSupport;
  }
  /** Both sides offer `hold/1` on this session. */
  get supportsHold(): boolean { return !!this.options.holdSupport && this.isDataLinkOpen && this.peerAllowsHold; }
  /** The contact's own choice about one way of paying, as it last said on this session or offered in the handshake. */
  peerAllowsPayment(method: PaymentMethodName): boolean {
    if (!this.options.params.profile || !this.paired || this.paired.state.status !== "ready") return false;
    return this.peerPaymentMethods ? this.peerPaymentMethods.has(method) : this.paired.peerAllowsPayment(method);
  }
  /** Takes effect at once; a connected contact is told on the open session, and the next handshake offers it. */
  setHoldSupport(on: boolean, top?: number): void { this.options.holdSupport = on; this.sendHoldState(top); }
  /** Older apps drop this frame (it carries no id) and keep using the handshake offer. */
  private sendHoldState(top?: number): void {
    if (!this.options.params.profile || !this.channel || !this.isDataLinkOpen || this.paired?.state.status !== "ready") return;
    try { this.channel.send(JSON.stringify({ t: "paired-hold", on: !!this.options.holdSupport, ...(top !== undefined ? { top } : {}) })); } catch { /* the next session offers it */ }
  }
  /** Takes effect at once, and a connected contact is told on the open session; the next handshake offers it too. */
  setPaymentMethods(methods: Partial<Record<PaymentMethodName, boolean>>): void { this.options.paymentMethods = { ...methods }; this.sendPaymentMethods(); }
  /** The apps this contact may reach, said on the open session. Older apps drop the frame (no id). */
  private sendPairedServices(): void {
    if (!this.options.params.profile || !this.channel || !this.supportsServices || this.paired?.state.status !== "ready") return;
    try { this.channel.send(JSON.stringify({ t: "paired-services", s: servicesToWire(this.options.getPairedServices?.() ?? []) })); } catch { /* sent again on the next session */ }
  }
  private offeredCapabilities(): SessionCapability[] {
    const offered: SessionCapability[] = [];
    if (this.options.callsSupport) offered.push(CALLS_CAPABILITY);
    if (this.options.servicesSupport) offered.push(SERVICES_CAPABILITY);
    if (this.options.largeFilesSupport) offered.push(FILES_CAPABILITY);
    return offered;
  }
  /** Both sides offer `calls/1` on the open session: call signals can flow. Calls need a live session. */
  get supportsCalls(): boolean { return this.isDataLinkOpen && this.sessionCapabilities.agreed(CALLS_CAPABILITY); }
  /** Both sides offer `services/1` on the open session: shared web apps can be listed and reached. */
  get supportsServices(): boolean { return this.isDataLinkOpen && this.sessionCapabilities.agreed(SERVICES_CAPABILITY); }
  /** Both sides offer `files/3` on the open session: files of any size, offered and resumed. */
  get supportsLargeFiles(): boolean { return this.isDataLinkOpen && this.sessionCapabilities.agreed(FILES_CAPABILITY); }
  /** Whether files/3 was agreed on the session open now; kept to say when that changes. */
  private filesOpen = false;
  private emitFilesSession(again = false): void {
    const open = this.supportsLargeFiles;
    if (open === this.filesOpen && !(open && again)) return;
    this.filesOpen = open;
    this.options.events?.onFilesSession?.(open);
  }
  /** A files/3 frame to the contact, on the open session. False when files/3 cannot flow now. */
  sendFilesFrame(frame: Record<string, unknown>): boolean {
    if (!this.supportsLargeFiles || !this.channel) return false;
    try { this.channel.send(JSON.stringify(frame)); return true; } catch { return false; }
  }
  /** What each side offers on the open session, for showing why something is unavailable. `peer` is null until it says. */
  get sessionOffers(): { mine: SessionCapability[]; peer: string[] | null } {
    const known = [CALLS_CAPABILITY, SERVICES_CAPABILITY, FILES_CAPABILITY] as const;
    return { mine: this.offeredCapabilities(),
      peer: this.isDataLinkOpen && this.sessionCapabilities.peerAnnounced ? known.filter(c => this.sessionCapabilities.peerOffers(c)) : null };
  }
  /** Why a call cannot be placed in this paired chat right now, or null when it can. */
  get callsUnavailable(): string | null {
    if (!this.options.params.profile || this.supportsCalls) return null;
    if (!this.options.callsSupport) return "Calls are not available in this app";
    if (!this.isDataLinkOpen) return "Calls need a live connection";
    return this.sessionCapabilities.peerAnnounced ? "Your contact's app cannot take calls" : "Your contact needs an updated Ghostly for calls";
  }
  /** Says what this side offers on the open session. Older apps drop the frame (no id). */
  private sendSessionCapabilities(): void {
    if (!this.options.params.profile || !this.channel || !this.isDataLinkOpen) return;
    try { this.channel.send(JSON.stringify(this.sessionCapabilities.announcement())); } catch { /* said again on the next session */ }
  }
  /** The contact said what it offers: start what both sides now agree on. */
  private sessionCapabilitiesChanged(changed: SessionCapability[]): void {
    if (changed.includes(SERVICES_CAPABILITY)) {
      if (this.supportsServices) this.sendPairedServices();
      else if (this.peerServicesOverride) { this.peerServicesOverride = null; this.options.events?.onPresence?.(this.presence); }
    }
    if (changed.includes(CALLS_CAPABILITY) && this.supportsCalls && this.channel) {
      const pending = this.pairedCalls.pending();
      if (pending) try { this.channel.send(JSON.stringify(pending)); } catch { /* the next session */ }
    }
    this.emitPairingState();
  }
  /** Both sides announced groups on this session and it is open. */
  get groupsSupport(): boolean { return !!this.options.groupsSupport && this.isDataLinkOpen && !!this.peerGroupVersions?.includes(1); }
  /** Both sides announced this version of groups (1: `group-mesh/1`, 2: `group-community/1` too). */
  supportsGroupVersion(version: number): boolean { return this.groupsSupport && !!this.peerGroupVersions?.includes(version); }
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
    try { this.channel.send(JSON.stringify({ t: "paired-groups", v: [1, 2] })); } catch { /* the next session announces it */ }
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
      if (this.paired?.state.transport === transport) {
        this.switcher.keep(lastError instanceof Error ? lastError.message : undefined); return;
      }
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
        holdSupport: !!this.options.holdSupport,
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
          // Another key on the stream than the one pinned: the chat stops on both layers, the DHT's too.
          if (paired.state.keyMismatch) { this.keyStopped = true; traceLink(this.myPubKeyZ32, "key-stop", { path: "stream" }); }
          this.tracker?.failed(paired.state.keyMismatch ? "key-mismatch" : "rejected", !paired.state.keyMismatch, paired.state.error);
          migration?.reject(new Error(paired.state.error ?? "Candidate authentication failed"));
          channel.close(); if (this.channel === channel) this.detach();
        },
        onReady: () => {
          let carried: PairedFiles | null = null;
          let switched: { from?: PairedTransport; to: PairedTransport } | null = null;
          if (migration) {
            if (this.candidate?.channel !== channel) { paired.stop(); channel.close(); return; }
            const oldChannel = this.channel, oldPaired = this.paired, oldBinding = this.activeBinding;
            const from = oldPaired?.state.transport;
            this.candidate = null;
            // Transfers in flight carry on over the new channel; they end only if it cannot take files.
            const files = this.pairedFiles; this.pairedFiles = null;
            if (files && paired.supports("files/2")) { files.rebind(channel); carried = files; } else files?.closeAll();
            this.pairedHttp?.close(); this.pairedHttp = null;
            this.channel = channel; this.paired = paired; this.activeBinding = binding;
            oldPaired?.stop();
            // Off WebRTC: its peer connection goes with the channel, unless WebRTC carries the chat again by then.
            if (oldChannel) this.retire(oldChannel, () => { if (!oldBinding && this.activeBinding) this.dataLink.close(); });
            this.session.setDataLinkOpen(true);
            switched = { from, to: paired.state.transport! };
          }
          if (this.channel !== channel) return;
          this.securityRejected = false;
          const events = this.options.events ?? {};
          if (carried) this.pairedFiles = carried;
          else if (paired.supports("files/2")) this.pairedFiles = new PairedFiles(channel, {
            onIncoming: file => events.onFileIncoming?.(file) ?? null,
            onStored: events.onFileStored,
            onProgress: events.onFileProgress,
            onComplete: events.onFileComplete,
            onFailed: events.onFileFailed,
          });
          this.peerPolicySeen = null;
          if (paired.peerTransportSwitchSupport) this.switcher.begin(paired.proofSession, paired.state.transport!, !!migration);
          else this.advertiseTransports();
          this.peerPaymentMethods = null;
          this.peerHoldOverride = null;
          this.sessionCapabilities.reset();
          this.pairedHttp?.close();
          this.pairedHttp = new PairedHttp(channel, this.options.getHostedHttpService, this.options.localFetch);
          this.emitPairingState();
          this.sendPairedNick();
          this.sendPairedAvatar();
          this.sendPaymentMethods();
          this.sendSessionCapabilities();
          this.sendGroupsSupport();
          this.sendHoldState();
          void this.options.events?.onHold?.({ peerAllows: paired.peerHoldSupport });
          migration?.resolve();
          this.rtcCandidateWaiter?.resolve(); this.rtcCandidateWaiter = null;
          // The wait between attempts is for attempts that failed: a link that worked and then dropped
          // (the contact reloaded, or came back) is dialled again as soon as the contact is seen.
          this.autoConnectFailures = 0;
          this.lastAutoConnectAt = 0;
          traceLink(this.myPubKeyZ32, "paired-ready");
          this.tracker?.live(paired.state.transport);
          this.startLiveness(channel, paired.peerAnswersPings);
          for (const waiter of this.openWaiters.splice(0)) waiter.resolve();
          this.options.events?.onPresence?.(this.presence);
          if (switched) this.options.events?.onTransportSwitched?.(switched.from, switched.to);
          if (switched) this.emitFilesSession(true);
        },
        onApplication: async data => {
          if (this.channel !== channel) return;
          // Anything from the peer shows the session is alive.
          this.unansweredPings = 0;
          if (typeof data !== "string" || data.length > 60 * 1024) return;
          let frame: Record<string, unknown>;
          try { frame = JSON.parse(data); } catch { return; }
          if (frame?.t === "paired-ping") { try { channel.send(JSON.stringify({ t: "paired-pong" })); } catch { /* closing */ } return; }
          if (frame?.t === "paired-pong") {
            this.peerAnswersPings = true;
            if (this.pingSentAt) { this.rtt = Date.now() - this.pingSentAt; this.pingSentAt = 0; this.options.events?.onRtt?.(this.rtt); }
            return;
          }
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
          if (typeof frame?.t === "string" && FILE_FRAMES.has(frame.t)) {
            if (this.supportsLargeFiles) await this.options.events?.onFilesFrame?.(frame);
            return;
          }
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
            if (typeof frame.n === "string") this.options.events?.onPeerNick?.(nick ?? null);
            if (nick !== this.peerNickOverride) {
              this.peerNickOverride = nick ?? null;
              this.options.events?.onPresence?.(this.presence);
            }
            return;
          }
          if (frame?.t === SESSION_CAPABILITIES_FRAME) {
            const changed = this.sessionCapabilities.receive(frame);
            if (changed) this.sessionCapabilitiesChanged(changed);
            return;
          }
          if (frame?.t === PAIRED_CALL_FRAME) {
            const signal = this.supportsCalls ? parsePairedCallFrame(frame) : null;
            if (signal) this.options.events?.onCallSignal?.(signal);
            return;
          }
          if (frame?.t === "ph") { if (this.supportsServices) this.pairedHttp?.handle(frame); return; }
          if (frame?.t === "paired-services") {
            if (!this.supportsServices) return;
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
          if (frame?.t === "paired-hold") {
            // The contact's latest word on held items; an older app never sends it and keeps its handshake offer.
            if (typeof frame.on !== "boolean" || (frame.top !== undefined && !(Number.isSafeInteger(frame.top) && (frame.top as number) >= 0))) return;
            this.peerHoldOverride = frame.on;
            await this.options.events?.onHold?.({ peerAllows: frame.on, peerTop: frame.top as number | undefined });
            this.emitPairingState();
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

  /**
   * Pings the paired peer; a session that stopped answering is closed, so it can be dialled again. A peer
   * that said in its offer that it answers pings counts from the open; any other counts once it answered
   * one (an app that never does is never cut off for it).
   */
  private startLiveness(channel: FrameChannel, peerAnswersPings = false): void {
    this.stopLiveness();
    this.peerAnswersPings = peerAnswersPings;
    // One ping at the open, not counted as missed: the round trip is known at once, not 15 s later.
    const ping = () => { this.pingSentAt = Date.now(); channel.send(JSON.stringify({ t: "paired-ping" })); };
    if (peerAnswersPings) try { ping(); } catch { /* closing: the timer below finds out */ }
    this.livenessTimer = setInterval(() => {
      if (this.channel !== channel) { this.stopLiveness(); return; }
      if (this.peerAnswersPings && this.unansweredPings >= LIVENESS_MISSED_PINGS) { this.dropDeadSession(channel); return; }
      this.unansweredPings++;
      try { ping(); } catch { this.dropDeadSession(channel); }
    }, LIVENESS_PING_MS);
  }
  private stopLiveness(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
    this.unansweredPings = 0;
    this.peerAnswersPings = false;
    this.pingSentAt = 0;
    this.rtt = undefined;
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

  /** A link made just now for a peer that is about to show up (a group's entry session): look fast for a while. */
  expectPeer(): void {
    this.session.expectPeer();
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
      // The side that does not dial makes sure the other one sees it here, fresh — unless it just did:
      // a second packet right behind the first is one relays hold back for seconds.
      if (!this.session.publishedRecently(RECENTLY_PUBLISHED_MS)) void this.session.refreshAdvertisement();
      this.maybeAutoConnect(this.presence);
    }
  }

  private detach(): void {
    this.stopLiveness();
    const wasNative = !!this.activeBinding;
    this.applicationOpen = false;
    this.dht?.setLive(false);
    // A replacement still authenticating may yet carry the chat. Without one, the session a plan meant to move is
    // gone, and so is the plan: its dial must not go on and open a session of its own, or settle the next one.
    if (!this.candidate) { this.cancelCandidate(); this.switcher.stop(); }
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
    this.sessionCapabilities.reset();
    this.emitFilesSession();
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
