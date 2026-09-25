import { UsdtWallet } from "./paymentAdapters/usdtWallet";
import { iceServerProblem } from "../shared/ice";
import type { UsdtPrepared } from "./paymentAdapters/usdt";
import { ArkWallet } from "./paymentAdapters/arkWallet";
import { BarkWallet } from "./paymentAdapters/barkWallet";
import { FedimintWallet } from "./paymentAdapters/fedimintWallet";
import { FedimintAdapter, type FedimintPrepared } from "./paymentAdapters/fedimint";
import { loadFedimintSdk, type FedimintSdk } from "./paymentAdapters/fedimintSdk";
import type { BarkPrepared } from "./paymentAdapters/bark";
import { SparkWallet } from "./paymentAdapters/sparkWallet";
import type { SparkPrepared } from "./paymentAdapters/spark";
import { PaymentCoordinator } from "./paymentAdapters/coordinator";
import { intentRepository } from "./paymentAdapters/persistence";
import type { ArkPrepared } from "./paymentAdapters/arkade";
import { CashuAdapter } from "./paymentAdapters/cashu";
import type { CashuPrepared } from "./wallet";
import { LightningService } from "./paymentAdapters/providers/lightningService";
import { BitcoinService, type BitcoinPrepared } from "./paymentAdapters/providers/bitcoinService";
import { CASHU_MINT_SOURCE } from "./paymentAdapters/providers/cashuMint";
import { BREEZ_SOURCE } from "./paymentAdapters/providers/breez";
import { defaultRegistry, type ProviderRegistry } from "./paymentAdapters/providers/registry";
import { onAdaptersChanged } from "../plugins/registry";
import type { ProviderHost, ProviderPlatform } from "./paymentAdapters/providers/types";
import type { EngineApi } from "../shared/rpc";
import { EXTERNAL_IDENTITIES_ENABLED } from '../shared/features';
import { IdentityProofs } from './identities';
import { NostrSocial, effectiveNostrSettings } from './nostrSocial';
import { normalizeNostrRelays } from '../nostr/relay';
import type { NostrDraft, NostrDraftRequest, NostrPublishResult } from '../nostr/types';
import { readPubkyProof } from '../proofs/storage';
import { lookupPublicProfile, currentProfileProof, PROFILE_RETRY, PROFILE_TTL, type ProfileChoice } from '../profiles/public';
import { CapsExchange, DHT_TEXT_CAPABILITY, HOLD_CAPABILITY, type CapsContent, type CapsRecord, type PairingCredentials } from "@ghostly/core";
import { fileMessageText, type PaymentRequest, type PaymentAsk, type Payment, type PaymentResult, HOLD_LIMITS, MAX_DHT_TEXT_BYTES, normalizeRelayUrl, sanitizeAvatar, PeerProofs, emptyProofLedger, emptyIdentityLedger, receivedIdentityStatus, type ProofChallenge, type ProofEvidence, type ProofAdapter, type ProofScope, type PaymentMethodName } from "@ghostly/core";
import {
  DEFAULT_RELAYS,
  GhostLink,
  emptyLinkRecords,
  DHT_TEXT_BYTES, DHT_MESSAGE_TTL, type DeliveryMode,
  GhostlyHttpError,
  HTTP_SERVICE_PROTO,
  LEGACY_SERVICES,
  LIMITS,
  RELAY_POLL_INTERVALS,
  RTC_CONFIG,
  RelayTransport,
  createChatInvite,
  createIdentity,
  decodeInviteCode,
  encodeInviteCode,
  edgeParams,
  formatLocalTarget,
  identityFromSeedB64,
  identityFromSeed,
  parseLocalTarget,
  randomBytes,
  safeBlobType,
  serviceIdFromName,
  toBase64Url,
  webLocalFetch,
  type ClientRequest,
  type ClientResponse,
  type DataLinkState,
  type FileSink,
  type HostedHttpService,
  type LinkParams,
  type LinkStatus,
  type LocalFetch,
  type PkarrTransport,
  type PollIntervals,
  type PeerPresence,
  type ServiceAd,
  type PairingProgress,
  type PairingState,
  type NativeEndpoint,
  type NativeTransport,
  type PairedTransport,
  type GroupEntryLink,
  entryParams,
} from "@ghostly/core";
import type { AttentionEvent, EngineImplementation } from "../shared/rpc";
import { fileStore, type StoredFile } from "../shared/idb";
import { fileBytes } from "../shared/fileBytes";
import { FileAppender, readStored, removeStored, storedSize, streamStored } from "../shared/storedFiles";
import { DEFAULT_MINTS, TEST_MINT, isWorthlessMint, type WalletMode } from "../shared/mints";
import type {
  EngineState,
  GroupEdgeView,
  FileTransferView,
  LinkView,
  MessageFile,
  GroupView,
  Settings,
  SettingsPatch,
  StoredLink,
  StoredMessage,
  StoredService,
  WalletView,
} from "../shared/types";
import { db } from "./db";
import { Groups } from "./groups";
import { edgeView } from "./groupEdges";
import { GroupPayments } from "./groupPayments";
import { CommunityPay, groupLinkId, parsePayLink } from "./communityPay";
import { mayReach } from "./serviceAccess";
import { Outbox } from "./outbox";
import { HoldEngine } from "./hold";
import { TransportLog } from "./transportLog";
import { S3Store } from "../backup/s3";
import type { HoldStore } from "../backup/storage";
import { PaymentDesk } from "./payments";
import { CashuWallet } from "./wallet";
import { traceJoin } from "./joinTrace";
import { DEFAULT_IROH_RELAYS, createIrohWebEndpoint, irohRelayProblem } from "../platform/irohWeb";

const DEFAULT_SETTINGS: Settings = {
  online: true,
  nick: "",
  relays: DEFAULT_RELAYS,
  iceServers: [],
  mints: [],
  mintsInitialized: false,
};

/** How many deleted ids a link remembers: enough to outlast what a peer republishes. */
const MAX_DELETED_IDS = 500;

interface LiveLink {
  /** The chat's layer-0 capability record exchange (WISP 03); paired chats only. */
  caps?: CapsExchange;
  transportErrors?: Partial<Record<PairedTransport, string>>;
  discoveryError?: string;
  proofs?: PeerProofs;
  proofError?: string;
  pairing?: PairingState;
  pairingProgress?: PairingProgress;
  stored: StoredLink;
  myPubKeyZ32: string;
  link: GhostLink | null;
  status: LinkStatus;
  dataLink: DataLinkState;
  presence: PeerPresence;
  lastMessageAt: number;
  peerAck: number;
  lastSyncAt: number;
  poll: LinkView["poll"];
  files: LinkFiles;
  /** The chat's connection story (paired chats), made from `stored.transportLog` on first use. */
  transportLog?: TransportLog;
}

/** What one peer has sent us, so it can neither fill the disk nor reuse an id. */
interface LinkFiles {
  /** Received bytes stored, plus those announced by transfers still in flight. */
  receivedBytes: number;
  /** Wire ids already used on this link, in either direction. */
  wireIds: Set<string>;
  /** Transfers in flight from the peer, by wire id. */
  incoming: Map<string, { localId: string; size: number }>;
}

function emptyLinkFiles(): LinkFiles {
  return { receivedBytes: 0, wireIds: new Set(), incoming: new Map() };
}

/** Rebuilds the per-link file bookkeeping from what is stored. */
function linkFilesFrom(linkId: string, files: StoredFile[], messages: StoredMessage[]): LinkFiles {
  const result = emptyLinkFiles();
  // Files stored before ids had a direction: the chat message says who sent them.
  const fromPeer = new Set(messages.flatMap((m) => (m.sender === "peer" && m.file ? [m.file.id] : [])));
  for (const file of files) {
    const legacy = !file.direction;
    result.wireIds.add(file.wireId ?? file.id.slice(linkId.length + 1));
    if (file.direction === "in" || (legacy && fromPeer.has(file.id))) result.receivedBytes += storedSize(file);
  }
  return result;
}

interface SpareInvite { mine: LinkParams; inviteKey: ReturnType<typeof identityFromSeedB64>; inviteCode: string; madeAt: number }
/** A spare invite is warmed again this often while it waits, and handed out only between these ages. */
const SPARE_INVITE_WARM_EVERY_MS = 4 * 60_000;
export const SPARE_INVITE_MIN_AGE_MS = 6_000;
const SPARE_INVITE_MAX_AGE_MS = 15 * 60_000;

function newLiveLink(stored: StoredLink, lastMessageAt: number, files = emptyLinkFiles()): LiveLink {
  return {
    stored,
    myPubKeyZ32: identityFromSeedB64(stored.seedB64).pubKeyZ32,
    link: null,
    status: "offline",
    dataLink: "idle",
    presence: { online: false, lastPacketAt: 0, services: null },
    lastMessageAt,
    peerAck: 0,
    lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 },
    files,
  };
}

/** What a host may replace. The defaults are what a browser can do on its own. */
const PAYMENT_METHODS: PaymentMethodName[] = ["cashu", "lightning", "arkade", "usdt", "bark", "bitcoin", "fedimint", "spark"];

export interface NodeOptions {
  nativeTransports?: Partial<Record<NativeTransport, (seedB64: string) => Promise<NativeEndpoint>>>;
  /**
   * Run Iroh in the page (web app, extension): the wasm build, relay only, on the relays in the settings
   * (WISP 102). It loads when a chat first starts an endpoint, not with the app.
   */
  irohWeb?: boolean;
  /** How to reach Pkarr. Default: HTTP relays, the only way out of a browser. */
  transport?: PkarrTransport;
  pollIntervals?: PollIntervals;
  /** How to reach a shared local web app. Default: `fetch`, which needs the app's or the browser's consent. */
  localFetch?: LocalFetch;
  /** Create and connect the Ark, Bark, Spark and USDT wallets at start. Default: on; tests without a network turn it off. */
  automaticWallets?: boolean;
  /** Where this engine runs, for the wallet providers that only work on some platforms. Default: web. */
  platform?: ProviderPlatform;
  /** The Lightning and on-chain providers on offer. Default: the registry (tests pass their own). */
  providers?: ProviderRegistry;
  /** Desktop: the Tauri commands the providers that need them call (see `ProviderHost.invoke`). */
  invoke?: ProviderHost["invoke"];
  /** The Fedimint client (tests pass a fake: the real one needs a worker and the origin-private file system). */
  fedimintSdk?: () => Promise<FedimintSdk>;
  /**
   * Whether paired chats offer `services/1`: this app serves granted local web apps and opens a contact's.
   * Default: everywhere but the web app, which can do neither (a tab has no way to reach localhost).
   */
  servicesSupport?: boolean;
}

export interface NodeEvents {
  onAttention?(event: AttentionEvent): void;
  onState(state: EngineState): void;
  onMessages(linkId: string, messages: StoredMessage[]): void;
  onCallSignal(linkId: string, signal: string): void;
}

/**
 * The Ghostly peer running in this browser: every link, the services it
 * shares, and the glue to IndexedDB. It owns nothing durable on the network;
 * when it stops, the peer is gone.
 */
/** A waiting file or request that went out: it shows like any other from now on (a file by its transfer). */
function sentNow(message: StoredMessage): StoredMessage {
  const { delivery: _delivery, deliveryError: _error, resendUntil: _until, ...sent } = message;
  return sent;
}

export class GhostlyNode implements EngineImplementation {
  private settings: Settings = DEFAULT_SETTINGS;
  private readonly transport: PkarrTransport;
  private readonly relays: RelayTransport | null;
  private readonly pollIntervals: PollIntervals;
  private readonly localFetch: LocalFetch;
  private readonly links = new Map<string, LiveLink>();
  private services: StoredService[] = [];
  private activeLinkId: string | null = null;
  private nativeQueue: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private readonly feedbackStartedAt = Date.now();
  private readonly feedbackIds = new Set<string>();
  private walletFeedbackReady = false;
  private readonly walletFeedbackIds = new Set<string>();
  private feedback(type: AttentionEvent["type"], id: string) {
    const key = type + ":" + id;
    if (this.feedbackIds.has(key)) return;
    this.feedbackIds.add(key);
    this.events.onAttention?.({type, id:key, at:Date.now()});
  }
  private messageFeedback(type: "message" | "sent", message: StoredMessage) {
    if (message.timestamp < this.feedbackStartedAt || message.file || message.paymentId || /^👋 (?:.+ )?joined$/.test(message.text)) return;
    this.feedback(type, message.linkId + ":" + message.id);
  }
  /** The next chat's keys, warmed on the network ahead of time (`takeInvite`). */
  private spare: SpareInvite | null = null;
  private spareTimer: ReturnType<typeof setTimeout> | null = null;
  /** Keys this engine warmed with an empty packet, and when. */
  private readonly warmedKeys = new Map<string, number>();
  private readonly outboxes = new Map<string, Outbox>();
  private readonly requestCounts = new Map<string, number>();
  private readonly transfers = new Map<string, FileTransferView>();
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private paymentTimer:ReturnType<typeof setTimeout>|null=null;
  /** Group links: admins read knocks, joiners knock (WISP 9xx § Entry link). */
  private groupEntryTimer: ReturnType<typeof setInterval> | null = null;
  private walletView: WalletView = { mints: [], balance: 0, history: [], feesPaid: 0 };

  private readonly usdtWallet = new UsdtWallet(() => { void this.refreshWallet(); void this.desk.reconcileUsdtReceipts().catch(()=>{}); });
  private readonly arkWallet = new ArkWallet(() => { void this.refreshWallet(); void this.desk.reconcileArkReceipts().catch(()=>{}); });
  private readonly barkWallet = new BarkWallet(() => { void this.refreshWallet(); void this.desk.reconcileBarkReceipts().catch(()=>{}); });
  private readonly fedimintWallet: FedimintWallet = new FedimintWallet({
    changed: () => void this.refreshWallet(),
    // An invoice of a chat request was paid into the federation: the request is paid.
    received: (paymentId) => void this.desk.onLightningPaid({ paymentId }),
  }, () => (this.options.fedimintSdk ?? loadFedimintSdk)());
  private readonly sparkWallet = new SparkWallet(() => { void this.refreshWallet(); void this.desk.reconcileSparkReceipts().catch(()=>{}); });
  private readonly paymentCoordinator = new PaymentCoordinator(intentRepository, [{
    method:"usdt",
    prepare:(target,amount,feeCap)=>this.usdtWallet.require().prepare(target,amount,feeCap),
    execute:(review,prepared,persist)=>this.usdtWallet.require().execute(review,prepared as UsdtPrepared,persist),
    reconcile:(review,prepared)=>this.usdtWallet.require().reconcile(review,prepared as UsdtPrepared),
  }, {
    method: "arkade",
    prepare: (target, amount, feeCap) => this.arkWallet.require().prepare(target, amount, feeCap),
    execute: (review, prepared, persist) => this.arkWallet.require().execute(review, prepared as ArkPrepared, persist),
    reconcile: (review, prepared,persist) => this.arkWallet.require().reconcile(review, prepared as ArkPrepared,persist),
  }, {
    method: "bark",
    prepare: (target, amount, feeCap) => this.barkWallet.require().prepare(target, amount, feeCap),
    execute: (review, prepared, persist) => this.barkWallet.require().execute(review, prepared as BarkPrepared, persist),
    reconcile: (review, prepared) => this.barkWallet.require().reconcile(review, prepared as BarkPrepared),
  }, {
    method: "spark",
    prepare: (target, amount, feeCap) => this.sparkWallet.require().prepare(target, amount, feeCap),
    execute: (review, prepared, persist) => this.sparkWallet.require().execute(review, prepared as SparkPrepared, persist),
    reconcile: (review, prepared) => this.sparkWallet.require().reconcile(review, prepared as SparkPrepared),
  }, {
    method:"bitcoin",
    prepare:(target,amount,feeCap)=>this.bitcoin.adapter.prepare(target,amount,feeCap),
    execute:(review,prepared,persist)=>this.bitcoin.adapter.execute(review,prepared as BitcoinPrepared,persist),
    reconcile:(review,prepared,persist)=>this.bitcoin.adapter.reconcile(review,prepared as BitcoinPrepared,persist),
    release:(review,prepared)=>this.bitcoin.adapter.release!(review,prepared as BitcoinPrepared),
  }, {
    method:"fedimint",
    prepare:(target,amount,feeCap)=>new FedimintAdapter(this.fedimintWallet,this.desk.fedimintPublisher).prepare(target,amount,feeCap),
    execute:(review,prepared,persist)=>new FedimintAdapter(this.fedimintWallet,this.desk.fedimintPublisher).execute(review,prepared as FedimintPrepared,persist),
    reconcile:(review)=>new FedimintAdapter(this.fedimintWallet,this.desk.fedimintPublisher).reconcile(review),
  }, {
    method:"cashu",
    prepare:(target,amount,feeCap)=>new CashuAdapter(this.wallet,(r,t)=>this.desk.recordCashu(r,t)).prepare(target,amount,feeCap),
    execute:(review,prepared,persist)=>new CashuAdapter(this.wallet,(r,t)=>this.desk.recordCashu(r,t)).execute(review,prepared as CashuPrepared,persist),
    reconcile:(review,prepared)=>new CashuAdapter(this.wallet,(r,t)=>this.desk.recordCashu(r,t)).reconcile(review,prepared as CashuPrepared),
  }], (review) => {
    if (review.state === "settled") this.feedback("confirmed", review.id);
    void this.refreshWallet();
  });
  /** The mints of the wallet mode in use, primary first; the others stay, for the other mode. */
  private modeMints(): string[] {
    const testnet = this.settings.walletMode === "testnet";
    return this.settings.mints.filter((mint) => isWorthlessMint(mint) === testnet);
  }
  private readonly wallet = new CashuWallet(() => this.modeMints(), {
    onChange: () => void this.refreshWallet(),
    // The mints settle their own invoices and payments; the Lightning journal learns it from here.
    onQuotePaid: (quote) => void this.lightning.reportInvoicePaid(quote.invoice, { paymentId: quote.paymentId, mint: quote.mint }),
    onMeltResolved: (melt, paid) => void this.lightning.reportPaymentResolved(melt.request, paid, { paymentId: melt.paymentId, mint: melt.mint }),
    onTestMintNeeded: async (mint) => void (await this.walletAddMint({ url: mint })),
  }, () => this.settings.mints);
  private registry?: ProviderRegistry;
  private providers() { return this.registry ??= this.options.providers ?? defaultRegistry(); }
  /** A plugin registered or left after start: the pickers show the new list. */
  private stopWatchingAdapters?: () => void;
  /** Read when a source connects, once the constructor has run. */
  private readonly providerHost = () => ({ platform: this.options.platform ?? "web" as const, cashu: this.wallet, fedimint: this.fedimintWallet, invoke: this.options.invoke });
  /** Lightning through the active source of the mode: the Cashu mints unless the person chose another. */
  private readonly lightning: LightningService = new LightningService(() => this.providers().lightning, this.providerHost, {
    changed: () => void this.refreshWallet(),
    received: (op) => void this.desk.onLightningPaid(op),
    resolved: (op, paid) => void this.desk.onLightningResolved(op, paid),
  }, CASHU_MINT_SOURCE);
  /** On-chain Bitcoin through the active source of the mode: none until the person sets one up. */
  private readonly bitcoin = new BitcoinService(() => this.providers().onchain, this.providerHost, () => { void this.refreshWallet(); void this.desk.reconcileBitcoinReceipts().catch(()=>{}); });
  private readonly desk: PaymentDesk = new PaymentDesk(this.wallet, {
    onReviewedPaymentResult:async(id)=>{await this.reconcilePayment({id});},
    onReviewedPaymentRefused:async(id,reason)=>{
      const intent=await intentRepository.get(id);
      if(intent && ["submitted","unknown"].includes(intent.review.state))await intentRepository.put({...intent,review:{...intent.review,state:"failed",error:`Refused: ${reason}. The sats came back.`}});
      this.emitState();
    },
    getLink: (linkId) => this.paymentLink(linkId),
    groupOf: (linkId) => { const stored = this.links.get(linkId)?.stored; return stored?.group && !stored.groupEntry ? stored.group : parsePayLink(linkId)?.groupId; },
    // A community has no edges to its members: one frame the whole group carries.
    groupLinks: (groupId) => this.groups.isCommunityGroup(groupId) ? [groupLinkId(groupId)] : [...this.groupEdges(groupId).values()],
    storeMessage: (message) => this.storeMessage(message),
    heldPaymentMethods: (linkId): PaymentMethodName[] | null => { const live = this.links.get(linkId); return live && this.holdingFor(live) ? this.hold.heldPaymentMethods(linkId) : null; },
    // What the contact allowed at the last session; before any, Cashu and Lightning, as a chat that negotiated nothing.
    waitingPaymentMethods: (linkId): PaymentMethodName[] | null => {
      const live = this.links.get(linkId);
      if (!live?.stored.profile || !live.link || live.link.isDataLinkOpen || live.stored.group || this.chatStopped(live)) return null;
      return (this.hold.lastPeerMethods(linkId) ?? ["cashu", "lightning"]).filter(m => m === "cashu" || m === "lightning");
    },
    holdRequest: (linkId, request, messageId) => this.hold.hold(linkId, { kind: "pay-req", id: request.id, messageId, ref: request.id, bytes: 1024, timestamp: request.timestamp }),
    onChange: () => {
      for (const payment of Object.values(this.desk.views())) {
        if (payment.kind === "payment" && payment.direction === "out" && payment.state === "settled" && payment.createdAt >= this.feedbackStartedAt) {
          this.feedback("confirmed", payment.id);
        }
      }
      void this.groupPayments.sync().catch(() => {});
      this.emitState();
    },
  }, this.arkWallet, this.usdtWallet, this.barkWallet, {
    createInvoice: (amount, paymentId) => this.lightning.createInvoice(amount, { paymentId }),
    quote: async (invoice) => { const quote = await this.lightning.quote(invoice); return { ...quote, mint: quote.source === CASHU_MINT_SOURCE ? quote.mint : undefined }; },
    pay: (quote, note, paymentId) => this.lightning.pay(quote.quote, { note, paymentId }),
    // "I paid": the source, the mints and the federations are asked now; the request is paid only once one of them saw it.
    check: async () => { await Promise.all([this.lightning.reconcile(), this.wallet.checkQuotes(), this.fedimintWallet.checkReceives()]); },
  }, this.bitcoin, this.fedimintWallet, {
    ready: () => !!this.sparkWallet.adapter,
    requestTarget: (amount, memo) => this.sparkWallet.target(amount, memo),
    received: (target, amount, since, claimed) => {
      const adapter = this.sparkWallet.adapter;
      // A request made on the other mode's wallet is looked for there, once it is back.
      return adapter && target.network === adapter.network ? adapter.received(target.address, amount, since, claimed) : Promise.resolve(undefined);
    },
    sync: async () => { await this.sparkWallet.adapter?.sync(); },
  });

  /** Store-and-forward for away contacts (WISP 4xx): items sealed into this device's own storage, picked up from the contact's. */
  private holdStore: { key: string; store: HoldStore } | null = null;
  private readonly hold: HoldEngine = new HoldEngine({
    transport: undefined as unknown as PkarrTransport,
    storage: () => {
      const config = this.settings.holdStorage;
      if (!config?.s3 || !/^[a-z2-7]{16}$/.test(config.space ?? "")) return null;
      const key = JSON.stringify(config.s3);
      try { if (this.holdStore?.key !== key) this.holdStore = { key, store: new S3Store(config.s3) }; } catch { return null; }
      return { store: this.holdStore.store, space: config.space };
    },
    link: (linkId) => { const live = this.links.get(linkId); return live ? { stored: live.stored, open: live.link?.isDataLinkOpen ?? false } : undefined; },
    linkIds: () => [...this.links.keys()],
    saveHold: async (linkId, hold) => {
      await db.patchLink(linkId, { hold });
      const live = this.links.get(linkId);
      if (live) live.stored = { ...live.stored, hold };
    },
    delivery: async (linkId, messageId, state, error) => {
      await db.updateDelivery(linkId, messageId, state, error);
      const messages = await db.getMessages(linkId);
      const message = messages.find((m) => m.id === messageId);
      if (message?.file) this.transfers.set(message.file.id, state === "failed" ? { state: "failed", transferred: 0, size: message.file.size, error } : { state: "done", transferred: message.file.size, size: message.file.size });
      if (message && state !== "failed") this.messageFeedback("sent", message);
      this.events.onMessages(linkId, messages);
      this.emitState();
    },
    text: async (linkId, messageId) => (await db.getMessages(linkId)).find((m) => m.id === messageId)?.text ?? null,
    file: async (fileId) => {
      const stored = await fileStore.get(fileId);
      if (!stored?.metadata) return null;
      // A held file is at most 8 MiB: whole in memory while it is sealed.
      return { bytes: await readStored(stored, 0, storedSize(stored)), name: stored.metadata.name, size: stored.metadata.size, mime: stored.metadata.mime, voice: stored.metadata.voice };
    },
    paymentRequest: (paymentId): PaymentRequest | null => this.desk.requestFor(paymentId),
    receiveText: (linkId, message) => this.storeMessage({ linkId, id: `peer_${message.id}`, text: message.text, sender: "peer", timestamp: message.timestamp, via: "hold" }),
    receiveFile: async (linkId, wire, bytes, digest) => {
      const live = this.links.get(linkId);
      if (!live) return "unknown chat";
      if (live.files.wireIds.has(wire.wireId)) return "duplicate file id";
      if (live.files.receivedBytes + wire.size > LIMITS.maxStoredIncomingBytesPerPeer) return "no room for more files";
      const file: MessageFile = { id: `${linkId}-in-${toBase64Url(randomBytes(12))}`, name: wire.name, size: wire.size, mime: wire.mime, ...(wire.voice && { voice: wire.voice }) };
      if (live.stored.deletedIds?.includes(`peer_${wire.wireId}`)) return null;
      live.files.wireIds.add(wire.wireId);
      live.files.receivedBytes += wire.size;
      // The bytes first, then the message that shows them: a message never points at a file that is not there.
      await fileStore.put({ id: file.id, linkId, blob: new Blob([bytes as BlobPart], { type: safeBlobType(file.mime) }), createdAt: Date.now(), direction: "in", wireId: wire.wireId, digest,
        metadata: { name: wire.name, size: wire.size, mime: wire.mime, timestamp: wire.timestamp, voice: wire.voice }, transfer: { state: "done", transferred: wire.size, size: wire.size } });
      this.transfers.set(file.id, { state: "done", transferred: wire.size, size: wire.size });
      await this.storeMessage({ linkId, id: `peer_${wire.wireId}`, text: fileMessageText(file), sender: "peer", timestamp: wire.timestamp, via: "hold", file });
      return null;
    },
    receivePaymentRequest: (linkId, request) => this.desk.onPaymentRequest(linkId, request, true),
    changed: () => this.emitState(),
    // Tests shorten the lifetime to watch an item expire; nothing else reads this, and it never lengthens it.
    ttlMs: () => { try { const raw = typeof localStorage !== "undefined" ? localStorage.getItem("ghostly-test-hold-ttl") : null; const ms = raw ? Number(raw) : NaN; return Number.isFinite(ms) && ms > 0 ? ms : undefined; } catch { return undefined; } },
  });

  /** Identity proofs: this profile's, and those shared in each paired chat (WISP 300). */
  private readonly identities = new IdentityProofs({
    ledger: linkId => { const stored = this.links.get(linkId)?.stored; return stored?.profile ? stored.identities ?? emptyIdentityLedger() : undefined; },
    updateLedger: async (linkId, change) => {
      const identities = await db.updateIdentities(linkId, change);
      const live = this.links.get(linkId);
      if (live) live.stored = { ...live.stored, identities };
      void this.nostrSocial.ledgerChanged(linkId).catch(() => {});
      return identities;
    },
    channel: linkId => {
      const link = this.links.get(linkId)?.link;
      return link?.identitySupport ? { scope: () => link.identityScope(), send: frame => link.sendIdentityProof(frame) } : undefined;
    },
    keys: linkId => {
      const stored = this.links.get(linkId)?.stored;
      return { mine: stored?.participationSeed ? identityFromSeedB64(stored.participationSeed).pubKeyZ32 : undefined, theirs: stored?.pairedPeerKey };
    },
    linkIds: () => [...this.links.keys()],
    online: () => this.settings.online,
    emit: () => this.emitState(),
    publish: (seed, records) => this.transport.publish(identityFromSeed(seed), records),
    resolve: async key => (await this.transport.resolve(key))?.records ?? null,
  });

  /** The Nostr social layer (profile, follows, notes, publication) on top of verified Nostr proofs. */
  private readonly nostrSocial = new NostrSocial({
    settings: () => this.settings.nostr,
    online: () => this.settings.online,
    emit: () => this.emitState(),
    ownSubjects: () => this.identities.views().filter(p => p.provider === "nostr").map(p => p.subject),
    contactSubjects: linkId => {
      const stored = this.links.get(linkId)?.stored;
      if (!stored?.profile || !stored.identities) return [];
      const mine = stored.participationSeed ? identityFromSeedB64(stored.participationSeed).pubKeyZ32 : undefined;
      const t = Math.floor(Date.now() / 1000);
      return [...new Set(stored.identities.received.filter(r => r.binding.provider === "nostr" && receivedIdentityStatus(r, stored.pairedPeerKey, mine, t) === "verified").map(r => r.verified.subject))];
    },
    linkIds: () => [...this.links.keys()],
    readContacts: linkId => this.links.get(linkId)?.stored.nostrSocial,
    writeContacts: async (linkId, nostrSocial) => {
      const live = this.links.get(linkId);
      if (!live) return;
      await db.patchLink(linkId, { nostrSocial });
      live.stored = { ...live.stored, nostrSocial };
    },
    setDisplay: async (linkId, subject, display) => {
      const identities = await db.updateIdentities(linkId, l => ({ ...l, received: l.received.map(r => r.binding.provider === "nostr" && r.verified.subject === subject ? { ...r, display } : r) }));
      const live = this.links.get(linkId);
      if (live) live.stored = { ...live.stored, identities };
    },
  });

  /** Private groups (WISP 900): sessions, admission on contact chats, and the pairwise edges that carry them. */
  private readonly groups = new Groups({
    sendOnLink: (linkId, frame) => {
      const link = this.links.get(linkId)?.link;
      if (!link) throw new Error("You are offline");
      link.sendGroupFrame(frame);
    },
    linkReady: (linkId, version = 1) => !!this.links.get(linkId)?.link?.supportsGroupVersion(version),
    myNick: () => this.sharedNick,
    contactName: linkId => { const stored = this.links.get(linkId)?.stored; return stored?.label || stored?.peerNick || undefined; },
    edges: groupId => this.groupEdges(groupId),
    entries: groupId => {
      const entries = new Map<string, string>();
      for (const live of this.links.values()) if (live.stored.group === groupId && live.stored.groupPeer && live.stored.groupEntry) entries.set(live.stored.groupPeer, live.stored.id);
      return entries;
    },
    openEntry: (link, role, seedB64, peer) => this.openEntry(link, role, seedB64, peer),
    linkSeen: linkId => { const live = this.links.get(linkId); return !!live?.presence?.online || (!!live?.dataLink && live.dataLink !== "idle"); },
    publish: (identity, records, background) => this.transport.publish(identity, records, { background }),
    resolve: async (pubKeyZ32, background) => (await this.transport.resolve(pubKeyZ32, { background }))?.records ?? null,
    expectPeer: linkId => this.links.get(linkId)?.link?.expectPeer(),
    openEdge: (state, peer, expectPeer) => this.openEdge(state, peer, expectPeer),
    closeEdge: async linkId => {
      const live = this.links.get(linkId);
      if (!live?.stored.group) return;
      this.links.delete(linkId);
      // An entry session is over once the admission is (or was given up): nobody waits on it, so it goes
      // without a last packet saying so, which would only spend two of the relays' requests at a busy moment.
      await live.link?.stop(!live.stored.groupEntry); await live.caps?.stop();
      await db.deleteLink(linkId);
    },
    edgeNick: linkId => this.links.get(linkId)?.presence.nick || undefined,
    storeMessage: message => this.storeMessage(message),
    emit: () => this.emitState(),
    communityApp: (groupId, sender, frame) => this.communityPay.receiveApp(groupId, sender, frame),
    communityPair: (groupId, sender, payload) => this.communityPay.receivePair(groupId, sender, payload),
  });

  /**
   * Payments in community groups (WISP 9xx · Group Community § Payments): the desk pays and requests over a link
   * per member that sends through the group, sealed to that member; the group request goes to everyone at once.
   */
  private readonly communityPay: CommunityPay = new CommunityPay({
    membership: groupId => this.groups.isCommunityGroup(groupId) ? this.membership(groupId) : undefined,
    sendApp: (groupId, frame) => this.groups.sendCommunityApp(groupId, frame),
    sendPair: (groupId, to, payload) => this.groups.sendCommunityPair(groupId, to, payload),
    enabled: () => ({}),
    onPaymentRequest: (linkId, request) => this.desk.onPaymentRequest(linkId, request),
    onPaymentAsk: (linkId, ask) => this.desk.onPaymentAsk(linkId, ask),
    onPayment: (linkId, payment) => this.desk.onPayment(linkId, payment),
    onPaymentResult: (linkId, result) => this.desk.onPaymentResult(linkId, result),
    onNote: (groupId, author, frame) => this.groupPayments.receive(groupId, author, frame),
    emit: () => this.emitState(),
  });

  /** My key in an active group, and who is in it. */
  private membership(groupId: string): { me: string; members: ReadonlySet<string> } | undefined {
    const group = this.groups.views().find(g => g.id === groupId);
    return group?.status === "active" && group.myKey ? { me: group.myKey, members: new Set(group.members.map(m => m.key)) } : undefined;
  }

  /** The link payments with `linkId` go over: a chat's or an edge's, or a community member's through the group. */
  private paymentLink(linkId: string) { return this.links.get(linkId)?.link ?? this.communityPay.link(linkId); }

  /**
   * Payments in groups (WISP 9xx § Payments): the money goes over the edge to one member through the desk, like a
   * chat's; what the group sees of it goes to every member as a `group-pay` note.
   */
  private readonly groupPayments = new GroupPayments({
    payments: () => Object.values(this.desk.views()),
    edgeOf: linkId => {
      const stored = this.links.get(linkId)?.stored, pay = parsePayLink(linkId);
      if (pay?.member) return { groupId: pay.groupId, member: pay.member };
      return stored?.group && stored.groupPeer && !stored.groupEntry ? { groupId: stored.group, member: stored.groupPeer } : undefined;
    },
    // In a community, notes go to everyone at once, through the group.
    edges: groupId => this.groups.isCommunityGroup(groupId) ? new Map([["*", groupLinkId(groupId)]]) : this.groupEdges(groupId),
    membership: groupId => this.membership(groupId),
    send: (linkId, frame) => {
      const pay = parsePayLink(linkId);
      if (pay) { void this.groups.sendCommunityApp(pay.groupId, frame as Record<string, unknown>).catch(() => {}); return; }
      const link = this.links.get(linkId)?.link;
      if (!link) throw new Error("You are offline");
      link.sendGroupFrame(frame);
    },
    messages: groupId => db.getMessages(`group:${groupId}`),
    putMessage: async message => {
      await db.putMessage(message);
      this.events.onMessages(message.linkId, await db.getMessages(message.linkId));
      this.emitState();
    },
  });

  /** Member key → edge link id, for the edges of a group that exist (open or not). */
  private groupEdges(groupId: string): Map<string, string> {
    const edges = new Map<string, string>();
    for (const live of this.links.values()) if (live.stored.group === groupId && live.stored.groupPeer && !live.stored.groupEntry) edges.set(live.stored.groupPeer, live.stored.id);
    return edges;
  }

  constructor(
    private readonly events: NodeEvents,
    private readonly options: NodeOptions = {},
  ) {
    // Relays are a setting only where relays are the transport.
    this.relays = options.transport ? null : new RelayTransport();
    this.transport = options.transport ?? this.relays!;
    this.pollIntervals = options.pollIntervals ?? RELAY_POLL_INTERVALS;
    this.localFetch = options.localFetch ?? webLocalFetch;
    (this.hold as unknown as { host: { transport: PkarrTransport } }).host.transport = this.transport;
  }

  private async refreshWallet(): Promise<void> {
    const mode = this.settings.walletMode ?? "mainnet", view = await this.wallet.view();
    // The history of the mode in use: test ecash is not mixed into the story of real money, nor the reverse.
    const history = view.history.filter((tx) => !tx.mint || isWorthlessMint(tx.mint) === (mode === "testnet"));
    let waitingTestSats = 0;
    if (mode === "mainnet") for (const mint of this.settings.mints.filter(isWorthlessMint)) waitingTestSats += await this.wallet.balanceAt(mint);
    this.walletView = { ...view, mode, waitingTestSats, history, feesPaid: history.reduce((sum, tx) => sum + tx.fee, 0), ark: this.arkWallet.view, bark: this.barkWallet.view, fedimint: this.fedimintWallet.view, spark: this.sparkWallet.view, usdt: this.usdtWallet.view, lightning: this.lightning.view, bitcoin: this.bitcoin.view, intents: (await intentRepository.list()).map((saved) => saved.review) };
    for (const tx of this.walletView.history) {
      const fresh = !this.walletFeedbackIds.has(tx.id);
      this.walletFeedbackIds.add(tx.id);
      if (this.walletFeedbackReady && fresh && tx.amount > 0 && tx.timestamp >= this.feedbackStartedAt) {
        if (tx.kind === "lightning-in" || tx.kind === "ecash-in") this.feedback("coin", tx.id);
        if (tx.kind === "lightning-out") this.feedback("confirmed", tx.id);
      }
    }
    this.walletFeedbackReady = true;
    this.emitState();
  }
  private async pollPaymentStatus():Promise<void> {
    if(this.shuttingDown)return;
    try {
      for(const {review} of await intentRepository.list()){
        if(!["submitted","unknown"].includes(review.state) || (review.method==="arkade" && !this.arkWallet.adapter) || (review.method==="bark" && !this.barkWallet.adapter) || (review.method==="spark" && !this.sparkWallet.adapter) || (review.method==="usdt" && !this.usdtWallet.adapter) || (review.method==="bitcoin" && !this.bitcoin.sources.active) || (review.method==="fedimint" && !this.fedimintWallet.federation(review.provider)))continue;
        await this.reconcilePayment({id:review.id}).catch(()=>{});
      }
    } finally {if(!this.shuttingDown)this.paymentTimer=setTimeout(()=>void this.pollPaymentStatus(),10000);}
  }

  async start(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await db.getSettings()) };
    if (!this.settings.mintsInitialized) {
      this.settings = { ...this.settings, mints: [...new Set([...this.settings.mints, ...DEFAULT_MINTS])], mintsInitialized: true };
      await db.putSettings(this.settings);
    }
    this.relays?.setRelays(this.settings.relays);
    this.services = await db.getServices();
    await this.identities.load();
    this.identities.start();
    await this.nostrSocial.load();
    await this.arkWallet.start();
    await this.barkWallet.start();
    await this.fedimintWallet.start();
    await this.sparkWallet.start();
    await this.usdtWallet.start();
    await this.arkWallet.setMode(this.settings.walletMode ?? "mainnet");
    await this.barkWallet.setMode(this.settings.walletMode ?? "mainnet");
    await this.fedimintWallet.setMode(this.settings.walletMode ?? "mainnet");
    await this.sparkWallet.setMode(this.settings.walletMode ?? "mainnet");
    await this.usdtWallet.setMode(this.settings.walletMode ?? "mainnet");
    await this.lightning.start(this.settings.walletMode ?? "mainnet");
    await this.bitcoin.start(this.settings.walletMode ?? "mainnet");
    await this.desk.start();
    await this.refreshWallet();
    this.wallet.start();
    this.stopWatchingAdapters ??= onAdaptersChanged(() => { if (!this.shuttingDown) { this.lightning.refreshOffered(); this.bitcoin.refreshOffered(); } });

    const history = new Map<string, StoredMessage[]>();
    for (const stored of await db.getLinks()) {
      const messages = stored.group ? [] : await db.getMessages(stored.id);
      const storedFiles = stored.group ? [] : await fileStore.listForLink(stored.id);
      for (const file of storedFiles) if (file.transfer) this.transfers.set(file.id,
        file.transfer.state === "transferring" ? { ...file.transfer, state: "failed", error: "Transfer interrupted. Retry when connected." } : file.transfer);
      const files = linkFilesFrom(stored.id, storedFiles, messages);
      this.links.set(stored.id, newLiveLink(stored, messages[messages.length - 1]?.timestamp ?? 0, files));
      history.set(stored.id, messages);
      if (stored.profile && !stored.group) await this.outboxFor(stored.id).recover();
    }
    // Groups know their edges from the links above, and may add or drop some before anything dials.
    await this.groups.load();
    if (this.settings.online) for (const [linkId, messages] of history) {
      if (!this.links.has(linkId)) continue;
      this.startLink(linkId, messages);
      if (!this.links.get(linkId)?.stored.group) void this.refreshPublicProfiles({ linkId }).catch(() => {});
    }
    this.emitState();
    if (this.settings.online) { this.hold.start(); this.startGroupEntries(); this.prepareSpare(); }
    void this.pollPaymentStatus().catch(()=>{});
    // Federations joined before: opened (and the notes a contact sent that an interruption left unredeemed, redeemed).
    void this.fedimintWallet.ensureReady().then(() => this.desk.resumeFedimint());
    // The Lightning and Bitcoin sources the person set up (the Cashu mints need no network to connect).
    void this.lightning.recover().then(() => this.lightning.ensureReady());
    void this.bitcoin.ensureReady();
    // Every profile has its wallets ready to receive without any setup; they connect in the background.
    if (this.options.automaticWallets !== false) {
      void this.arkWallet.ensureReady();
      void this.barkWallet.ensureReady();
      void this.sparkWallet.ensureReady();
      void this.usdtWallet.ensureReady();
    }
  }

  /** Tells every peer we are leaving. Best effort: the browser may already be closing. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if(this.paymentTimer)clearTimeout(this.paymentTimer);
    if (this.spareTimer) clearTimeout(this.spareTimer);
    this.stopGroupEntries();
    this.stopWatchingAdapters?.();
    this.identities.stop();
    this.nostrSocial.stop();
    await this.arkWallet.stop();
    await this.barkWallet.stop();
    await this.fedimintWallet.stop();
    await this.sparkWallet.stop();
    await this.usdtWallet.stop();
    await this.lightning.stop();
    await this.bitcoin.stop();
    await this.nativeQueue;
    await this.hold.stop();
    await Promise.allSettled([...this.outboxes.values()].map(outbox => outbox.stop()));
    await Promise.allSettled([...this.links.values()].map(async (live) => { await live.link?.stop(true); await live.caps?.stop(); }));
  }

  getState(): EngineState {
    const groups = this.groups.views();
    return {
      settings: this.settings,
      transport: { ...this.transport.describe(), ...(this.options.irohWeb ? { iroh: { relays: this.irohRelays, defaults: [...DEFAULT_IROH_RELAYS] } } : {}) },
      // Group edges are links the engine runs, not chats anyone sees.
      links: [...this.links.values()].filter((live) => !live.stored.group).map((live) => this.viewOf(live)).sort((a, b) => b.createdAt - a.createdAt),
      services: this.services
        .map((s) => ({ ...s, requests: this.requestCounts.get(s.id) ?? 0 }))
        .sort((a, b) => a.createdAt - b.createdAt),
      transfers: Object.fromEntries(this.transfers),
      wallet: this.walletView,
      payments: this.desk.views(),
      identityProofs: this.identities.views(),
      nostr: this.nostrSocial.state(),
      edges: [...[...this.links.values()].filter(live => live.stored.group && !live.stored.groupEntry).map(live => this.viewOf(live)), ...this.communityPayViews(groups)],
      groups: groups.map(group => ({ ...group, members: group.members.map(member => {
        const edge = member.me ? undefined : this.edgeView(group.id, member.key);
        return edge ? { ...member, edge } : member;
      }) })),
    };
  }

  /** Community members payments go to (or came from), as links the payment bubbles and the composer look up by key. */
  private communityPayViews(groups: GroupView[]): LinkView[] {
    const withPayments = new Map<string, Set<string>>();
    for (const p of Object.values(this.desk.views())) {
      const at = parsePayLink(p.linkId);
      if (at?.member) { const set = withPayments.get(at.groupId) ?? new Set<string>(); set.add(at.member); withPayments.set(at.groupId, set); }
    }
    return groups.filter(g => g.profile === "community" && g.status === "active" && g.myKey)
      .flatMap(g => this.communityPay.views(g.id, g.myKey!, g.members.map(m => m.key), withPayments.get(g.id) ?? new Set()));
  }

  /** The payment composer opened on a member of a community: ask what they take, if they did not say lately. */
  async groupPaymentHello({ groupId, member }: { groupId: string; member: string }): Promise<void> {
    if (!this.groups.isCommunityGroup(groupId) || !this.membership(groupId)?.members.has(member)) return;
    await this.communityPay.hello(groupId, member).catch(() => {});
  }

  /** The edge of a group toward one member, as the group page shows it: what carries it and when the member was last heard. */
  private edgeView(groupId: string, member: string): GroupEdgeView | undefined {
    for (const live of this.links.values()) if (live.stored.group === groupId && live.stored.groupPeer === member && !live.stored.groupEntry) return edgeView(live);
    return undefined;
  }

  getMessages(linkId: string): Promise<StoredMessage[]> {
    return db.getMessages(linkId);
  }

  // -- links ---------------------------------------------------------------

  async createLink(): Promise<{ linkId: string; inviteCode: string }> {
    const { mine, inviteCode } = this.takeInvite();
    return { linkId: await this.addLink(mine, inviteCode), inviteCode };
  }

  /**
   * The next chat's keys, made and warmed ahead of time. The first packet under a key nobody has heard of
   * takes the network seconds (the DHT's iterative lookup before the store, on the relays' side too, and
   * a relay refuses to replace a packet it is still putting); a packet under a key it knows lands in
   * under a second. So the engine keeps one invite ready with both its keys warmed with empty packets
   * (`emptyLinkRecords`), and makes the next one the moment this one is taken.
   */
  takeInvite(): { mine: LinkParams; inviteCode: string } {
    // A spare warmed seconds ago is worse than fresh keys: the network is still putting its first packet,
    // and a second one under the key meanwhile is refused by relays and DHT alike (for ~4 s).
    const age = this.spare ? Date.now() - this.spare.madeAt : 0;
    const spare = this.spare && age >= SPARE_INVITE_MIN_AGE_MS && age < SPARE_INVITE_MAX_AGE_MS ? this.spare : this.makeSpare();
    if (spare === this.spare) { this.spare = null; this.prepareSpare(); }
    return { mine: spare.mine, inviteCode: spare.inviteCode };
  }

  private makeSpare(): SpareInvite {
    // A ghostly1 invite (WISP 801): `mine` keeps the participation seed whose public key the code carries.
    const { mine, invite, inviteCode } = createChatInvite();
    return { mine, inviteKey: identityFromSeedB64(invite.seedB64), inviteCode, madeAt: Date.now() };
  }

  /** One invite warmed and waiting, warmed again every so often while it waits (the relays forget). */
  private prepareSpare(): void {
    if (this.shuttingDown || !this.settings.online) return;
    if (!this.spare) this.spare = this.makeSpare();
    const spare = this.spare;
    for (const identity of [identityFromSeedB64(spare.mine.seedB64), spare.inviteKey]) {
      this.warmedKeys.set(identity.pubKeyZ32, Date.now());
      void this.transport.publish(identity, emptyLinkRecords()).catch(() => {});
    }
    if (this.spareTimer) clearTimeout(this.spareTimer);
    this.spareTimer = setTimeout(() => { this.spareTimer = null; if (this.spare === spare) this.prepareSpare(); }, SPARE_INVITE_WARM_EVERY_MS);
  }

  async joinLink({ inviteCode }: { inviteCode: string }): Promise<{ linkId: string }> {
    const params = decodeInviteCode(inviteCode);
    if (!params) throw new Error("That does not look like a Ghostly invite");
    const existing = [...this.links.values()].find((l) => l.stored.seedB64 === params.seedB64);
    if (existing) {
      if (existing.stored.profile !== params.profile) throw new Error("Invitation profile does not match the stored link");
      return { linkId: existing.stored.id };
    }
    return { linkId: await this.addLink(params) };
  }

  async ensureLink({ inviteCode, participationSeedB64, ...params }: LinkParams & { inviteCode?: string }): Promise<{ linkId: string }> {
    // The inviter's own participation seed never travels in a code: checked here, then carried past the round trip.
    if (participationSeedB64 !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(participationSeedB64)) throw new Error("Invalid participation seed");
    const checked = decodeInviteCode(encodeInviteCode(params));
    if (!checked) throw new Error("That does not look like a Ghostly invite");
    const existing = [...this.links.values()].find((l) => l.stored.seedB64 === checked.seedB64);
    if (existing) {
      if (existing.stored.profile !== checked.profile) throw new Error("Invitation profile does not match the stored link");
      return { linkId: existing.stored.id };
    }
    return { linkId: await this.addLink({ ...checked, ...(participationSeedB64 ? { participationSeedB64 } : {}) }, inviteCode) };
  }

  private profileRequests = new Map<string, Promise<void>>();
  async choosePublicProfile({ linkId, choice }: { linkId: string; choice: ProfileChoice }): Promise<void> {
    if (!EXTERNAL_IDENTITIES_ENABLED) throw new Error('External identities are unavailable in this release');
    if (!['auto','ghostly','nostr','pubky-import','keet-import','pubky-storage'].includes(choice)) throw new Error('Unknown profile choice');
    const live = this.links.get(linkId); if (!live) return;
    await db.patchLink(linkId,{profileChoice:choice}); live.stored={...live.stored,profileChoice:choice};this.emitState();
    if(choice!=='ghostly') void this.refreshPublicProfiles({linkId}).catch(()=>{});
  }
  async refreshPublicProfiles({ linkId, force = false }: { linkId: string; force?: boolean }): Promise<void> {
    if (!EXTERNAL_IDENTITIES_ENABLED) return;
    const existing=this.profileRequests.get(linkId); if(existing)return existing;
    const task=this.loadPublicProfiles(linkId,force).finally(()=>this.profileRequests.delete(linkId));
    this.profileRequests.set(linkId,task); return task;
  }
  private async loadPublicProfiles(linkId: string, force: boolean): Promise<void> {
    if (!EXTERNAL_IDENTITIES_ENABLED) return;
    const live=this.links.get(linkId);if(!live || !this.settings.online || live.stored.profileChoice==='ghostly')return;
    const mine=live.myPubKeyZ32;
    // Participation, not rendezvous, is the proof audience.
    const audience=live.stored.participationSeed ? identityFromSeedB64(live.stored.participationSeed).pubKeyZ32 : mine;
    for(const proof of live.stored.peerProofs?.remote ?? []) {
      if(!currentProfileProof(proof,live.stored.pairedPeerKey,audience))continue;
      const {adapter,externalKey:key}=proof.challenge;
      const old=live.stored.publicProfiles?.find(p=>p.adapter===adapter && p.key===key);
      if(old && Date.now()-(old.checkedAt ?? old.fetchedAt) < (!force && (old.name || old.avatar) ? PROFILE_TTL : PROFILE_RETRY))continue;
      const result=await lookupPublicProfile(adapter,key);
      if(this.links.get(linkId)!==live || live.stored.profileChoice==='ghostly' || !(live.stored.peerProofs?.remote ?? []).some(r=>r.challenge.adapter===adapter && r.challenge.externalKey===key && currentProfileProof(r,live.stored.pairedPeerKey,audience)))continue;
      // Keep a successful local copy during outages; never replace it with a miss.
      const saved=result.source==='unavailable' && old ? {...old,checkedAt:result.fetchedAt} : result;
      const publicProfiles=[...(live.stored.publicProfiles??[]).filter(p=>p.adapter!==adapter),saved].slice(-4);
      await db.patchLink(linkId,{publicProfiles});live.stored={...live.stored,publicProfiles};this.emitState();
    }
  }

  private async proofsFor(linkId: string): Promise<PeerProofs> {
    if (!EXTERNAL_IDENTITIES_ENABLED) throw new Error("External identities are unavailable in this release");
    const live = this.links.get(linkId);
    if (!live?.link) throw new Error("Peer is offline");
    const scope = await live.link.peerProofScope();
    if (!live.proofs) this.createProofManager(live, scope);
    return live.proofs!;
  }

  private createProofManager(live: LiveLink, initial: ProofScope): void {
    live.proofs = new PeerProofs({
      readStorage: readPubkyProof,
      scope: () => {
        const session = live.link?.proofSession;
        if (!session || live.stored.pairedPeerKey !== initial.audience) throw new Error("Authenticated proof channel unavailable");
        return { ...initial, session };
      },
      supports: adapter => live.link?.peerProofAdapters.includes(adapter) ?? false,
      send: frame => {
        if (!live.link) throw new Error("Peer is offline");
        live.link.sendPeerProof(frame);
      },
      storage: {
        read: () => live.stored.peerProofs ?? emptyProofLedger(),
        update: async change => {
          const peerProofs = await db.updatePeerProofs(live.stored.id, change);
          live.stored = { ...live.stored, peerProofs }; this.emitState();
          void this.refreshPublicProfiles({ linkId: live.stored.id }).catch(() => {});
        },
      },
      onError: error => { live.proofError = error; this.emitState(); },
    });
  }

  async preparePeerProof({ linkId, externalKey, adapter }: { linkId: string; externalKey: string; adapter?: ProofAdapter }): Promise<ProofChallenge> {
    return (await this.proofsFor(linkId)).prepare(externalKey, adapter);
  }
  async submitPeerProof({ linkId, challenge, event }: { linkId: string; challenge: ProofChallenge; event: ProofEvidence }): Promise<void> {
    await (await this.proofsFor(linkId)).submit(challenge, event);
    if (challenge.adapter === 'pubky-storage') {
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const record = this.links.get(linkId)?.stored.peerProofs?.local.find(r => r.event.id === event.id);
        if (record?.status === 'accepted') return;
        if (!record || record.status !== 'pending') throw new Error('Pubky proof was cancelled');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await (await this.proofsFor(linkId)).withdraw('pubky-storage');
      throw new Error('Contact did not confirm the Pubky file. Reconnect and try again.');
    }
  }
  async withdrawPeerProof({ linkId, adapter }: { linkId: string; adapter?: ProofAdapter }): Promise<void> {
    await (await this.proofsFor(linkId)).withdraw(adapter);
  }

  // -- identity proofs ------------------------------------------------------

  beginIdentityProof(params: { provider: string; subject: string; validityDays?: number }) { return this.identities.begin(params); }
  completeIdentityProof(params: { draftId: string; evidence: unknown }) { return this.identities.complete(params); }
  cancelIdentityProof(params: { draftId: string }): void { this.identities.cancel(params); }
  removeIdentityProof(params: { id: string }): Promise<void> { return this.identities.remove(params); }
  shareIdentityProof(params: { linkId: string; id: string }): Promise<void> { return this.identities.share(params); }
  withdrawIdentityProof(params: { linkId: string; id: string }): Promise<void> { return this.identities.withdraw(params); }
  recheckIdentityProof(params: { linkId: string; id: string }): Promise<void> { return this.identities.recheck(params); }
  lookupIdentityDisplay(params: { linkId: string; id: string }): Promise<void> {
    // A Nostr profile comes through the social layer, from the relays the person configured.
    const r = this.links.get(params.linkId)?.stored.identities?.received.find(x => x.id === params.id);
    if (r?.binding.provider === "nostr") return this.nostrSocial.loadContact({ linkId: params.linkId, subject: r.verified.subject, what: "profile" });
    return this.identities.lookupDisplay(params);
  }
  nostrLoadContact(params: { linkId: string; subject: string; what: "profile" | "follows" | "notes"; more?: boolean }): Promise<void> { return this.nostrSocial.loadContact(params); }
  nostrForgetContact(params: { linkId: string; subject: string }): Promise<void> { return this.nostrSocial.forgetContact(params); }
  nostrLoadOwn(params: { subject: string }): Promise<void> { return this.nostrSocial.loadOwn(params); }
  nostrDraft(params: NostrDraftRequest): Promise<NostrDraft> { return this.nostrSocial.draft(params); }
  nostrPublish(params: { draftId: string; event: unknown }): Promise<NostrPublishResult> { return this.nostrSocial.publish(params); }

  async confirmPair({ linkId, code }: { linkId: string; code: string }): Promise<void> {
    const link = this.links.get(linkId)?.link;
    if (!link) throw new Error("Peer is offline");
    await link.confirmPair(code);
  }

  pollNow({ linkId }: { linkId: string }): void {
    this.links.get(linkId)?.link?.session.pollNow();
  }

  removeLink({ linkId }: { linkId: string }): void {
    const live = this.links.get(linkId);
    if (!live) return;
    void this.outboxes.get(linkId)?.stop();
    this.outboxes.delete(linkId);
    void live.link?.stop(true); void live.caps?.stop();
    this.links.delete(linkId);
    this.identities.forget(linkId);
    this.nostrSocial.forgetLink(linkId);
    this.hold.forgetLink(linkId);
    void db.deleteLink(linkId);
    void this.desk.forgetLink(linkId);
    this.emitState();
  }

  renameLink({ linkId, label }: { linkId: string; label: string }): void {
    const live = this.links.get(linkId);
    if (!live) return;
    live.stored = { ...live.stored, label: label.trim().slice(0, 48) || undefined };
    void db.patchLink(linkId, { label: live.stored.label });
    this.emitState();
  }

  setActiveLink({ linkId }: { linkId: string | null }): void {
    this.activeLinkId = linkId;
    if (linkId) void this.ensureNativeEndpoints(linkId);
    // With automatic profiles on, a stale Nostr profile is refreshed when the chat is opened.
    if (linkId && this.settings.nostr?.autoLoadProfiles) void this.nostrSocial.ledgerChanged(linkId).catch(() => {});
    if (linkId) this.hold.wake(linkId);
    for (const [id, live] of this.links) live.link?.session.setActive(id === linkId);
    // Opening a chat is someone wanting to talk: reconnect now, not after the wait between attempts.
    if (linkId) this.links.get(linkId)?.link?.wake();
    // The chat on screen carries its connection story in the state.
    this.emitState();
  }

  /** The window or tab is back in front: every chat looks now, and dropped ones reconnect at once. */
  wake(): void {
    for (const live of this.links.values()) live.link?.wake();
    this.hold.wake();
    // A wallet source that could not be reached at start-up (no network yet, a server asleep) tries again.
    this.lightning.sources.wake();
    this.bitcoin.sources.wake();
  }

  exportLinks() {
    return [...this.links.values()].filter(({ stored }) => !stored.group).map(({ stored }) => ({
      profile: stored.profile,
      deliveryMode: stored.deliveryMode,
      seedB64: stored.seedB64,
      peerPubKeyZ32: stored.peerPubKeyZ32,
      encKeyB64: stored.encKeyB64,
      createdAt: stored.createdAt,
      inviteCode: stored.inviteCode,
      label: stored.label,
    }));
  }

  async sendMessage(params: { linkId: string; text: string; timestamp?: number }): Promise<{ error: string | null; refused?: boolean }> {
    const { linkId, text } = params;
    const live = this.links.get(linkId);
    if (!live?.link) return { error: "You are offline" };
    const trimmed = text.trim();
    if (!trimmed) return { error: null };

    const timestamp = params.timestamp ?? Date.now();
    if (live.stored.profile) return this.sendChatText(live, trimmed, timestamp);
    const via = live.link.isDataLinkOpen ? "datalink" : "pkarr";
    // What the DHT cannot carry is refused before it is kept: it must not show as sent.
    const bytes = new TextEncoder().encode(trimmed).length;
    if (!(live.link.isDataLinkOpen && trimmed.length <= LIMITS.maxChatMessageBytes / 4) && bytes > MAX_DHT_TEXT_BYTES)
      return { error: `Message too large for DHT (${bytes} bytes, max ${MAX_DHT_TEXT_BYTES}). Try a shorter message or share a link instead.`, refused: true };
    await this.storeMessage({ linkId, id: `me_${timestamp}`, text: trimmed, sender: "me", timestamp, via });
    const error = await live.link.sendMessage(trimmed, timestamp);
    if (!error) this.messageFeedback("sent", {linkId, id:`me_${timestamp}`, text:trimmed, sender:"me", timestamp, via});
    // The data link is reliable and ordered: sent means delivered.
    if (!live.stored.profile && !error && via === "datalink" && timestamp > live.peerAck) {
      live.peerAck = timestamp;
      this.emitState();
    }
    return { error };
  }

  /**
   * Text in a chat (WISP 400): over layer 1 while live; on the DHT floor when it fits 256 bytes; held when
   * both sides allow it; otherwise kept as `waiting` ("Sends when live") and sent by itself, in order, once
   * the chat can carry it. Only what must never wait, or a security stop, is refused.
   */
  private async sendChatText(live: LiveLink, trimmed: string, timestamp: number): Promise<{ error: string | null; refused?: boolean }> {
    const { link } = live, linkId = live.stored.id;
    if (!link) return { error: "You are offline" };
    const bytes = new TextEncoder().encode(trimmed).length;
    if (bytes > LIMITS.maxChatMessageBytes) return { error: `Message exceeds ${LIMITS.maxChatMessageBytes} UTF-8 bytes.` };
    const stop = this.chatStopped(live);
    if (stop) return { error: stop };
    const wireId = toBase64Url(randomBytes(16)), id = `me_${wireId}`;
    const delivery = link.isDataLinkOpen ? "stream" : link.textDelivery === "dht" ? "dht" : "unavailable";
    if (delivery === "stream" || (delivery === "dht" && bytes <= DHT_TEXT_BYTES)) {
      const validationError = link.validateText(trimmed, timestamp, wireId);
      if (!validationError) {
        await this.storeMessage({ linkId, id, wireId, text: trimmed, sender: "me", timestamp, via: delivery === "dht" ? "pkarr" : "datalink", delivery: "sending" });
        await this.outboxFor(linkId).transmit(id);
        // The durable row carries delivery errors and an explicit retry action.
        return { error: null };
      }
      if (/Payment tokens|does not match/.test(validationError)) return { error: validationError, refused: true };
    }
    if (this.holdingFor(live) && bytes <= HOLD_LIMITS.maxTextBytes) {
      // Longer than the DHT carries, and both sides allow held items: it waits in this device's storage, sealed for them.
      await this.storeMessage({ linkId, id, wireId, text: trimmed, sender: "me", timestamp, via: "hold", delivery: "sending" });
      // The durable row carries the outcome; the promise only says whether it could start.
      void this.hold.hold(linkId, { kind: "text", id: wireId, messageId: id, bytes, timestamp }).catch(() => {});
      return { error: null };
    }
    const reason = delivery === "dht" && bytes <= DHT_TEXT_BYTES ? "Waits for the text before it to be confirmed."
      : delivery === "dht" ? `Longer than the ${DHT_TEXT_BYTES} bytes the DHT carries: it is sent when you are live.`
      : "Sent when your contact is reachable.";
    await this.storeMessage({ linkId, id, wireId, text: trimmed, sender: "me", timestamp, via: "datalink", delivery: "waiting", deliveryError: reason });
    await this.outboxFor(linkId).wait(id, reason);
    return { error: null };
  }

  /** A chat stopped by a security rejection (a participation key other than the pinned one): nothing goes until the person acts. */
  private chatStopped(live: LiveLink): string | null {
    const error = live.link?.dhtDelivery?.error;
    if (live.pairing?.keyMismatch) return live.pairing.error ?? "This chat stopped: your contact's key changed.";
    if (error?.includes("does not match")) return error;
    return null;
  }

  async retryMessage({ linkId, messageId }: { linkId: string; messageId: string }): Promise<void> {
    const live = this.links.get(linkId);
    if (!live?.stored.profile) throw new Error("Retry is only available for paired chat messages");
    const message = (await db.getMessages(linkId)).find((m) => m.id === messageId);
    if (message?.via === "hold") {
      // Its item again if it is still known; held anew (a fresh sequence, the same message id) if it was dropped.
      if (await this.hold.retry(linkId, messageId)) return;
      if (!this.holdingFor(live)) throw new Error("Held messages need S3 storage (Profile → Backups) and a contact that allows them.");
      await db.updateDelivery(linkId, messageId, "sending");
      this.events.onMessages(linkId, await db.getMessages(linkId));
      const item = message.file ? { kind: "file" as const, id: message.file.id.slice(`${linkId}-out-`.length), ref: message.file.id, bytes: message.file.size }
        : message.paymentId ? { kind: "pay-req" as const, id: message.paymentId, ref: message.paymentId, bytes: 1024 }
        : { kind: "text" as const, id: message.wireId ?? messageId.replace(/^me_/, ""), bytes: new TextEncoder().encode(message.text).length };
      await this.hold.hold(linkId, { ...item, messageId, timestamp: message.timestamp });
      return;
    }
    await this.outboxFor(linkId).transmit(messageId, { manual: true });
  }

  /** The contact is away, and both sides chose to hold what is sent meanwhile (WISP 4xx). */
  private holdingFor(live: LiveLink): boolean {
    // Holding dials nobody: it works in DHT only too (WISP 4xx, revision 0.2).
    return !!live.stored.profile && !!live.link && !live.link.isDataLinkOpen && this.hold.canHold(live.stored.id);
  }

  /** Store-and-forward in one chat: offered in the handshake, told to a connected contact at once. */
  async setChatHold({ linkId, enabled }: { linkId: string; enabled: boolean }): Promise<void> {
    const live = this.links.get(linkId);
    if (!live?.stored.profile || typeof enabled !== "boolean") throw new Error("Held messages need a paired chat");
    await this.hold.setEnabled(linkId, enabled);
    live.link?.setHoldSupport(enabled, live.stored.hold?.outSeq);
    this.capsChanged(linkId);
    this.emitState();
  }

  private outboxFor(linkId: string): Outbox {
    let outbox = this.outboxes.get(linkId);
    if (!outbox) {
      outbox = new Outbox({
        read: () => db.getMessages(linkId),
        update: async (id, delivery, error, extra) => {
          await db.updateDelivery(linkId, id, delivery, error, extra);
          const messages = await db.getMessages(linkId);
          if (delivery === "sent" || delivery === "delivered") {
            const message = messages.find(item => item.id === id);
            if (message) this.messageFeedback("sent", message);
          }
          this.events.onMessages(linkId, messages);
        },
      }, message => this.links.get(linkId)?.link?.sendMessage(message.text, message.timestamp, message.wireId)
        ?? Promise.resolve("You are offline. It is sent again once you are back."), message => message.via === "pkarr" ? DHT_MESSAGE_TTL : 20_000, message => {
        const pending = this.links.get(linkId)?.stored.dhtDeliveryState?.pending;
        return message.via === "pkarr" && pending && pending.message[0] === message.wireId ? pending.expires : undefined;
      }, { resender: {
        // Only while the chat can carry it: a live link, or the DHT path with nothing else awaiting a receipt.
        // In a live chat, what already went through the DHT fallback waits for the live link.
        ready: message => {
          const live = this.links.get(linkId), link = live?.link;
          if (message.via === "pkarr" && live?.stored.deliveryMode !== "dht" && link?.textDelivery !== "stream") return false;
          return !!link?.canSendText && !!message.wireId && !link.validateText(message.text, message.timestamp, message.wireId);
        },
        requeueExpired: () => this.links.get(linkId)?.stored.deliveryMode !== "dht",
        via: message => {
          const delivery = this.links.get(linkId)?.link?.textDelivery;
          return delivery === "dht" ? "pkarr" : delivery === "stream" ? "datalink" : message.via;
        },
        // The contact stays away and both sides allow held items: store-and-forward takes it, under the same id.
        divert: async message => {
          const live = this.links.get(linkId), bytes = new TextEncoder().encode(message.text).length;
          if (!live || !this.holdingFor(live) || !message.wireId || message.file || message.paymentId || bytes > HOLD_LIMITS.maxTextBytes) return false;
          await db.updateDelivery(linkId, message.id, "sending", undefined, { via: "hold", resendUntil: undefined });
          this.events.onMessages(linkId, await db.getMessages(linkId));
          void this.hold.hold(linkId, { kind: "text", id: message.wireId, messageId: message.id, bytes, timestamp: message.timestamp }).catch(() => {});
          return true;
        },
      } });
      this.outboxes.set(linkId, outbox);
    }
    return outbox;
  }

  /**
   * Forgets one message here: its row, the bytes of the file it carried, and
   * its id, so the peer republishing it does not bring it back. Nothing goes
   * out on the wire — the peer keeps its own copy.
   */
  deleteMessage({ linkId, messageId }: { linkId: string; messageId: string }): void {
    const live = this.links.get(linkId);
    if (!live) return;
    live.stored = {
      ...live.stored,
      deletedIds: [...(live.stored.deletedIds ?? []), messageId].slice(-MAX_DELETED_IDS),
    };
    void db.patchLink(linkId, { deletedIds: live.stored.deletedIds });
    void this.hold.forget(linkId, messageId).catch(() => {});

    void (async () => {
      const message = (await db.getMessages(linkId)).find((m) => m.id === messageId);
      // A request that never left (waiting for live) is withdrawn with its message: the next session must not send it.
      if (message?.paymentId && message.delivery === "waiting") await this.desk.withdraw(message.paymentId).catch(() => {});
      if (message?.file) {
        const stored = await fileStore.get(message.file.id);
        // Only what the peer sent counts against the room it has here.
        if (stored && (stored.direction === "in" || (!stored.direction && message.sender === "peer"))) {
          live.files.receivedBytes = Math.max(0, live.files.receivedBytes - storedSize(stored));
        }
        await removeStored(message.file.id);
        this.transfers.delete(message.file.id);
      }
      await db.deleteMessage(linkId, messageId);
      const messages = await db.getMessages(linkId);
      live.lastMessageAt = messages[messages.length - 1]?.timestamp ?? 0;
      this.events.onMessages(linkId, messages);
      this.emitState();
    })();
  }

  /** Local id of a file we send: the id on the wire is ours too, but lives in its own key space. */
  private static outgoingFileId(linkId: string, wireId: string): string {
    return `${linkId}-out-${wireId}`;
  }

  sendFile({ linkId, file, timestamp }: { linkId: string; file: MessageFile; timestamp: number }): void {
    const live = this.links.get(linkId);
    const fail = (error: string) => {
      const transfer = { state: "failed" as const, transferred: 0, size: file.size, error };
      this.transfers.set(file.id, transfer);
      void fileStore.updateTransfer(file.id, transfer).catch(() => {});
      this.emitState();
    };
    if (!live?.link) return fail("You are offline");
    if (this.transfers.get(file.id)?.state === "transferring") return;
    const wireId = file.id.slice(`${linkId}-out-`.length);
    if (file.id !== GhostlyNode.outgoingFileId(linkId, wireId)) return fail("Invalid file id");
    if (!live.link.supportsFiles && this.holdingFor(live)) {
      // The contact is away: the file waits in this device's storage, sealed for them.
      if (file.size > HOLD_LIMITS.maxBundleBytes - 4096) return fail(`A file held for an away contact is at most ${Math.round(HOLD_LIMITS.maxBundleBytes / 1024 / 1024)} MB`);
      live.files.wireIds.add(wireId);
      this.transfers.set(file.id, { state: "transferring", transferred: 0, size: file.size });
      void this.storeMessage({ linkId, id: `me_${timestamp}`, text: fileMessageText(file), sender: "me", timestamp, via: "hold", delivery: "sending", file })
        .then(() => this.hold.hold(linkId, { kind: "file", id: wireId, messageId: `me_${timestamp}`, ref: file.id, bytes: file.size, timestamp })).catch(() => {});
      return;
    }
    if (!live.link.supportsFiles && live.stored.profile && !live.link.isDataLinkOpen) {
      // Not live and nothing holds it: it waits here, with a cancel, and goes when the chat is live (WISP 500).
      if (this.chatStopped(live)) return fail(this.chatStopped(live)!);
      live.files.wireIds.add(wireId);
      void this.storeMessage({ linkId, id: `me_${timestamp}`, text: fileMessageText(file), sender: "me", timestamp, via: "datalink", file,
        delivery: "waiting", deliveryError: "Sent when you are live." });
      return;
    }
    if (!live.link.supportsFiles) return fail("Connect to an updated peer to send files");
    live.files.wireIds.add(wireId);
    void this.storeMessage({
      linkId,
      id: `me_${timestamp}`,
      text: fileMessageText(file),
      sender: "me",
      timestamp,
      via: "datalink",
      file,
    });
    this.transferFile(live, file, wireId, timestamp, fail);
  }

  /** The file of a stored message goes over the open session. */
  private transferFile(live: LiveLink, file: MessageFile, wireId: string, timestamp: number, fail: (error: string) => void): void {
    const { link } = live;
    if (!link) return fail("You are offline");
    this.transfers.set(file.id, { state: "transferring", transferred: 0, size: file.size });
    void (async () => {
      const stored = await fileStore.get(file.id);
      if (!stored) return fail("The file is gone");
      await fileStore.updateTransfer(file.id, { state: "transferring", transferred: 0, size: file.size });
      // Read a step at a time, wherever the bytes are: never the whole file at once.
      const source = streamStored(stored);
      await link.sendFile(
        { id: wireId, name: file.name, size: file.size, mime: file.mime, timestamp, ...(file.voice && { voice: file.voice }) },
        source,
      );
    })().catch((error) => fail(error instanceof Error ? error.message : String(error)));
  }

  /**
   * The chat is live: what waited for it goes now, in the order it was written. A file for an app that turns
   * out not to take files fails with that reason instead of waiting forever (WISP 03).
   */
  private async sendWaiting(linkId: string): Promise<void> {
    const live = this.links.get(linkId);
    if (!live?.link?.isDataLinkOpen) return;
    const waiting = (await db.getMessages(linkId)).filter(m => m.sender === "me" && m.delivery === "waiting" && (m.file || m.paymentId))
      .sort((a, b) => a.timestamp - b.timestamp);
    for (const message of waiting) {
      if (message.file) {
        if (!live.link.supportsFiles) { await db.updateDelivery(linkId, message.id, "failed", "Your contact's app cannot receive files."); continue; }
        const file = message.file, wireId = file.id.slice(`${linkId}-out-`.length);
        await db.putMessage(sentNow(message));
        this.transferFile(live, file, wireId, message.timestamp, error => {
          this.transfers.set(file.id, { state: "failed", transferred: 0, size: file.size, error });
          this.emitState();
        });
      } else {
        // The desk's replay has sent every pending request of this chat on the open session.
        if (live.link.supportsPayments) await db.putMessage(sentNow(message));
        else await db.updateDelivery(linkId, message.id, "failed", "Your contact's app cannot receive payment requests.");
      }
    }
    if (waiting.length) this.events.onMessages(linkId, await db.getMessages(linkId));
  }

  private receiveFile(
    linkId: string,
    wire: { id: string; name: string; size: number; mime: string; timestamp: number; voice?: MessageFile["voice"] },
  ): FileSink | string {
    const files = this.links.get(linkId)?.files;
    if (!files) return "refused";
    // A known id could only be a replay or an attempt to pass for a file we already have.
    if (files.wireIds.has(wire.id)) return "duplicate file id";
    if (files.receivedBytes + wire.size > LIMITS.maxStoredIncomingBytesPerPeer) return "no room for more files";

    // The local id is ours, never the peer's: whatever it announces cannot replace a stored file.
    const file: MessageFile = { ...wire, id: `${linkId}-in-${toBase64Url(randomBytes(12))}` };
    files.wireIds.add(wire.id);
    files.receivedBytes += wire.size;
    files.incoming.set(wire.id, { localId: file.id, size: wire.size });
    let cancelled = false;
    // The bytes go to storage as they arrive, in order: never gathered whole in memory.
    const appender = fileBytes().then((bytes) => new FileAppender(bytes, file.id));
    let writing: Promise<void> = appender.then(() => {});
    const discard = () => appender.then((a) => a.bytes.remove(file.id)).catch(() => {});
    this.transfers.set(file.id, { state: "transferring", transferred: 0, size: file.size });
    const messageStored = this.storeMessage({
      linkId,
      id: `peer_${wire.timestamp}`,
      text: fileMessageText(file),
      sender: "peer",
      timestamp: wire.timestamp,
      via: "datalink",
      file: { id: file.id, name: file.name, size: file.size, mime: file.mime, ...(file.voice && { voice: file.voice }) },
    });
    void messageStored.catch(() => {});
    return {
      write: (chunk) => (writing = writing.then(async () => { if (!cancelled) await (await appender).append(chunk); })),
      // The message keeps the announced type for display; the bytes are served as something inert.
      close: async (digest?: string) => {
        await messageStored;
        await writing;
        if (cancelled) throw new Error("Transfer cancelled");
        const live = this.links.get(linkId);
        // Deleted while it was still arriving: the bytes have nowhere to land, and give their room back.
        if (live?.stored.deletedIds?.includes(`peer_${wire.timestamp}`)) {
          await discard();
          throw new Error("The receiving message was deleted");
        }
        const written = await appender;
        await written.close();
        await fileStore.put({
          id: file.id,
          linkId,
          bytes: written.bytes.kind,
          createdAt: Date.now(),
          direction: "in",
          wireId: wire.id,
          digest,
          metadata: { name: wire.name, size: wire.size, mime: wire.mime, timestamp: wire.timestamp, voice: wire.voice },
        });
        if (cancelled) { await removeStored(file.id); throw new Error("Transfer cancelled"); }
      },
      abort: () => { cancelled = true; void writing.then(discard, discard); },
    };
  }

  /** Maps a wire id from the data link to the local id; an incoming file that ended is settled here. */
  private localFileId(linkId: string, wireId: string, direction: "in" | "out", settled?: { failed: boolean }): string | undefined {
    if (direction === "out") return GhostlyNode.outgoingFileId(linkId, wireId);
    const files = this.links.get(linkId)?.files;
    const entry = files?.incoming.get(wireId);
    if (!files || !entry) return undefined;
    if (settled) {
      files.incoming.delete(wireId);
      // Only what was not kept gives its room back.
      if (settled.failed) { files.receivedBytes -= entry.size; files.wireIds.delete(wireId); }
    }
    return entry.localId;
  }

  private fileProgress(fileId: string | undefined, transferred: number): void {
    if (!fileId) return;
    const transfer = this.transfers.get(fileId);
    if (!transfer || transfer.state !== "transferring") return;
    transfer.transferred = transferred;
    this.emitState(250);
  }

  private fileSettled(fileId: string | undefined, error?: string): void {
    if (!fileId) return;
    const transfer = this.transfers.get(fileId);
    if (!transfer) return;
    this.transfers.set(fileId, error ? { ...transfer, state: "failed", error } : { ...transfer, state: "done", transferred: transfer.size });
    const state = this.transfers.get(fileId)!;
    void fileStore.updateTransfer(fileId, state).catch(() => {});
    this.emitState();
  }

  async setDeliveryMode({ linkId, mode }: { linkId: string; mode: DeliveryMode }): Promise<void> {
    const live = this.links.get(linkId);
    if (!live?.stored.profile || !live.link || (mode !== "stream" && mode !== "dht")) throw new Error("Delivery method unavailable.");
    await db.patchLink(linkId, { deliveryMode: mode });
    live.stored = { ...live.stored, deliveryMode: mode };
    await live.link.setDeliveryMode(mode);
    if (mode === "stream") await this.ensureNativeEndpoints(linkId);
    this.observeTransport(linkId);
    this.emitState();
  }

  /**
   * `chosen`: a choice from the chat's Connection menu, a row in its timeline even when it names the transport already
   * set. Left out (the RPC), only a change of transport is: the Fallback switch sends the same preference again, and
   * is neither a row nor a switch intent.
   */
  async setTransportPreference({ linkId, preferred, fallback }: { linkId: string; preferred: PairedTransport; fallback: boolean }, chosen?: boolean): Promise<void> {
    const live = this.links.get(linkId);
    if (!live?.stored.profile || !live.link?.availableTransports.includes(preferred) || typeof fallback !== "boolean") throw new Error("Transport unavailable");
    chosen ??= live.stored.preferredTransport !== preferred;
    const patch = { preferredTransport: preferred, transportFallback: fallback };
    await db.patchLink(linkId, patch);
    live.stored = { ...live.stored, ...patch }; this.emitState();
    const log = chosen ? this.transportLogOf(live) : undefined;
    if (log?.chose("you", preferred, Date.now())) this.saveTransportLog(live, log);
    // Not a choice (the Fallback switch): no switch intent on the wire either, or it could beat the contact's.
    await live.link.setTransportPreference(preferred, fallback, false, chosen);
  }

  /**
   * One chat's connection, chosen from its menu: a transport both sides can use (it overrides the app's rule for
   * this chat, and is remembered for the next reconnect), `auto` to go back to the app's rule, or `dht` for DHT only
   * (WISP 400: it travels as the DHT envelope's mode; either side choosing it keeps both off the live link). Choosing
   * anything else while on DHT only leaves it first. Fallback stays as it was. A live session moves over without
   * reconnecting; if the new transport fails, it stays where it was.
   */
  async setChatTransport({ linkId, transport }: { linkId: string; transport: PairedTransport | "auto" | "dht" }): Promise<void> {
    const live = this.links.get(linkId);
    if (transport === "dht") { await this.setDeliveryMode({ linkId, mode: "dht" }); return; }
    if (live?.stored.deliveryMode === "dht") {
      // The choice is recorded first, so the line that says the chat left DHT only names it. The native adapters
      // were released with DHT only: the preference reaches the link once they are back.
      const preferredTransport = transport === "auto" ? undefined : transport;
      live.stored = { ...live.stored, preferredTransport };
      await db.patchLink(linkId, { preferredTransport });
      await this.setDeliveryMode({ linkId, mode: "stream" });
    }
    if (transport !== "auto") {
      // A choice on the wire too; out of DHT only, the log leaves the row to the one that says so (it names it).
      await this.setTransportPreference({ linkId, preferred: transport, fallback: live?.stored.transportFallback ?? true }, true);
      return;
    }
    if (!live?.stored.profile || !live.link) throw new Error("Transport unavailable");
    const patch = { preferredTransport: undefined, transportFallback: undefined };
    await db.patchLink(linkId, patch);
    live.stored = { ...live.stored, ...patch }; this.emitState();
    const log = this.transportLogOf(live);
    if (log?.chose("you", "automatic", Date.now())) this.saveTransportLog(live, log);
    // The app's rule: WebRTC first where there is one (Linux WebKitGTK has none), fallback on.
    const available = live.link.availableTransports;
    await live.link.setTransportPreference(available.includes("webrtc/1") ? "webrtc/1" : available[0], true, true);
  }

  /** The chat's connection story, for paired chats (not group edges). */
  private transportLogOf(live: LiveLink): TransportLog | undefined {
    if (!live.stored.profile || live.stored.group) return undefined;
    if (live.transportLog) return live.transportLog;
    const log = live.transportLog = new TransportLog(live.stored.transportLog, live.stored.transportHistory);
    // Rows an older release stored by its rules (every restart and reconnect): kept by today's, messages untouched.
    if (log.compacted) this.saveTransportLog(live, log);
    return log;
  }

  /** Looks at the chat's link and adds a line to its story when the transport changed. */
  private observeTransport(linkId: string): void {
    const live = this.links.get(linkId), log = live && this.transportLogOf(live);
    if (!live || !log || !live.link || this.shuttingDown) return;
    const pairing = live.pairing;
    const changed = log.observe({
      live: live.dataLink === "open" && pairing?.status === "ready" && !!pairing.transport && live.link.isDataLinkOpen,
      transport: pairing?.transport,
      text: this.holdingFor(live) ? "hold" : live.link.textDelivery,
      dhtOnly: live.stored.deliveryMode === "dht",
      peerDhtOnly: live.link.dhtDelivery?.peerMode === "dht",
      preferred: live.stored.preferredTransport,
      transitionError: pairing?.transitionError,
      transitionTarget: pairing?.transitionTarget,
      error: pairing?.status === "error" ? pairing.error : undefined,
    }, Date.now());
    if (changed) this.saveTransportLog(live, log);
  }

  private saveTransportLog(live: LiveLink, log: TransportLog): void {
    const transportLog = log.entries.map(e => ({ ...e })), transportHistory = log.history.map(e => ({ ...e }));
    live.stored = { ...live.stored, transportLog, transportHistory };
    void db.patchLink(live.stored.id, { transportLog, transportHistory }).catch(() => {});
    this.emitState();
  }

  /** Which ways of paying one chat allows. */
  async setChatPaymentMethods({ linkId, methods }: { linkId: string; methods: Partial<Record<PaymentMethodName, boolean>> }): Promise<void> {
    const live = this.links.get(linkId);
    if (!live || !methods || Object.entries(methods).some(([m, on]) => !PAYMENT_METHODS.includes(m as PaymentMethodName) || typeof on !== "boolean")) throw new Error("Chat not found");
    const paymentMethods = { ...live.stored.paymentMethods, ...methods };
    await db.patchLink(linkId, { paymentMethods });
    live.stored = { ...live.stored, paymentMethods };
    // A connected contact is told on the open session; nothing reconnects.
    live.link?.setPaymentMethods(paymentMethods);
    this.capsChanged(linkId);
    this.emitState();
  }

  async connect({ linkId }: { linkId: string }): Promise<void> {
    const link = this.links.get(linkId)?.link;
    if (!link) throw new Error("You are offline. Go online before reconnecting.");
    await this.ensureNativeEndpoints(linkId);
    await link.connect();
  }

  disconnect({ linkId }: { linkId: string }): void {
    this.links.get(linkId)?.link?.disconnect();
  }

  // -- private groups --------------------------------------------------------

  async createGroup({ name, profile }: { name: string; profile?: "community" | "mesh" }): Promise<{ groupId: string }> {
    if (typeof name !== "string" || !name.trim()) throw new Error("Give the group a name");
    return { groupId: await this.groups.create(name.trim().slice(0, 48), profile === "mesh" ? "mesh" : "community") };
  }
  inviteToGroup({ groupId, linkId }: { groupId: string; linkId: string }): Promise<void> {
    if (!this.links.get(linkId)?.stored.profile || this.links.get(linkId)?.stored.group) throw new Error("Invite a paired contact");
    return this.groups.invite(groupId, linkId);
  }
  acceptGroupInvitation({ groupId }: { groupId: string }): Promise<void> { return this.groups.accept(groupId); }
  declineGroupInvitation({ groupId }: { groupId: string }): Promise<void> { return this.groups.decline(groupId); }
  async enableGroupLink({ groupId, reset }: { groupId: string; reset?: boolean }): Promise<{ link: string }> { return { link: await this.groups.enableLink(groupId, reset === true) }; }
  disableGroupLink({ groupId }: { groupId: string }): Promise<void> { return this.groups.disableLink(groupId); }
  async joinGroupByLink({ link }: { link: string }): Promise<{ groupId: string }> {
    if (typeof link !== "string") throw new Error("This is not a link to a group");
    if (!this.settings.online) throw new Error("Go online to join a group");
    return { groupId: await this.groups.joinByLink(link) };
  }
  sendGroupMessage({ groupId, text }: { groupId: string; text: string }): Promise<{ error: string | null }> {
    if (typeof text !== "string") return Promise.resolve({ error: "Nothing to send" });
    return this.groups.send(groupId, text);
  }
  groupMessages({ groupId }: { groupId: string }): Promise<StoredMessage[]> { return this.groups.messages(groupId); }
  leaveGroup({ groupId }: { groupId: string }): Promise<void> { return this.groups.leave(groupId); }
  removeGroupMember({ groupId, key }: { groupId: string; key: string }): Promise<void> { return this.groups.remove(groupId, key); }
  makeGroupAdmin({ groupId, key }: { groupId: string; key: string }): Promise<void> { return this.groups.makeAdmin(groupId, key); }
  rotateGroup({ groupId }: { groupId: string }): Promise<void> { return this.groups.rotate(groupId); }
  setGroupPicture({ groupId, picture }: { groupId: string; picture: string | null }): Promise<void> { return this.groups.setPicture(groupId, picture); }
  forgetGroup({ groupId }: { groupId: string }): Promise<void> { return this.groups.forget(groupId); }

  setCallSignal({ linkId, signal }: { linkId: string; signal: string | null }): void {
    void this.links.get(linkId)?.link?.setCallSignal(signal);
  }

  setFastPoll({ linkId, fast }: { linkId: string; fast: boolean }): void {
    this.links.get(linkId)?.link?.session.setFastPoll(fast);
  }

  /** Used by the viewer: a request to a service some peer shares with us. */
  async request(peerPubKeyZ32: string, serviceId: string, request: ClientRequest): Promise<ClientResponse> {
    const live = [...this.links.values()].find((l) => l.stored.peerPubKeyZ32 === peerPubKeyZ32);
    if (!live) throw new GhostlyHttpError("unknown-peer", "You have no link to this peer");
    if (!live.link) throw new GhostlyHttpError("offline", "Ghostly is offline");
    return live.link.request(serviceId, request);
  }

  // -- wallet and payments --------------------------------------------------

  async walletAddMint({ url, primary }: { url: string; primary?: boolean }): Promise<{ url: string; name: string }> {
    const mint = await this.wallet.checkMint(url);
    const others = this.settings.mints.filter((m) => m !== mint.url);
    const known = others.length !== this.settings.mints.length;
    if (primary) await this.updateSettings({ settings: { mints: [mint.url, ...others] } });
    else if (!known) await this.updateSettings({ settings: { mints: [...others, mint.url] } });
    await this.refreshWallet();
    return mint;
  }

  /**
   * Every wallet switches together: Cashu shows the mints of the mode (Testnet brings the public test
   * mint), Ark and USDT open this mode's wallet and park the other one. Nothing is replaced or lost.
   */
  async walletSetMode({ mode }: { mode: WalletMode }): Promise<void> {
    if (mode !== "mainnet" && mode !== "testnet") throw new Error("Unknown wallet mode");
    const mints = mode === "testnet" && !this.settings.mints.some(isWorthlessMint) ? [...this.settings.mints, TEST_MINT] : this.settings.mints;
    await this.updateSettings({ settings: { walletMode: mode, mints } });
    // Queued behind whatever the wallets are doing (a new wallet on a slow network): the switch answers at
    // once, and each wallet follows in order, so switching back and forth ends on the last choice.
    const followed = Promise.all([this.arkWallet.setMode(mode), this.barkWallet.setMode(mode), this.fedimintWallet.setMode(mode), this.sparkWallet.setMode(mode), this.usdtWallet.setMode(mode), this.lightning.setMode(mode), this.bitcoin.setMode(mode)]).then(() => this.refreshWallet());
    void followed.then(() => { void this.fedimintWallet.ensureReady(); void this.lightning.ensureReady(); void this.bitcoin.ensureReady(); }, () => {});
    if (this.options.automaticWallets !== false) void followed.then(() => { void this.arkWallet.ensureReady(); void this.barkWallet.ensureReady(); void this.sparkWallet.ensureReady(); void this.usdtWallet.ensureReady(); }, () => {});
    // Names, fees and limits of this mode's mints (a mint just added has none yet).
    for (const mint of this.modeMints()) void this.wallet.checkMint(mint).then(() => this.refreshWallet(), () => {});
    await this.refreshWallet();
  }

  async walletSetPrimaryMint({ url }: { url: string }): Promise<void> {
    if (!this.settings.mints.includes(url)) return;
    await this.updateSettings({ settings: { mints: [url, ...this.settings.mints.filter((m) => m !== url)] } });
    await this.refreshWallet();
  }

  async walletRemoveMint({ url }: { url: string }): Promise<void> {
    if ((await this.wallet.balanceAt(url)) > 0) throw new Error("Move your sats out of this mint before removing it");
    await this.updateSettings({ settings: { mints: this.settings.mints.filter((m) => m !== url) } });
    await this.refreshWallet();
  }

  /** `via: "cashu"`: ecash straight from the mints (the Cashu card). Otherwise the active Lightning source. */
  async walletReceiveLightning({ amount, via }: { amount: number; via?: "cashu" }) {
    if (via === "cashu") {
      const quote = await this.wallet.receiveLightning(amount);
      return { quote: quote.quote, invoice: quote.invoice, expiresAt: quote.expiresAt, source: CASHU_MINT_SOURCE };
    }
    const created = await this.lightning.createInvoice(amount);
    return { quote: created.paymentHash, invoice: created.invoice, expiresAt: created.expiresAt, paymentHash: created.paymentHash, source: created.source };
  }

  walletQuoteInvoice({ invoice, via }: { invoice: string; via?: "cashu" }) {
    return via === "cashu" ? this.wallet.quoteInvoice(invoice) : this.lightning.quote(invoice);
  }

  async walletPayQuote({ quote, mint, note }: { quote: string; mint: string; note?: string }) {
    // A quote of the Lightning source, or a melt quote the Cashu card asked the mints for.
    return { paid: this.lightning.hasQuote(quote) ? await this.lightning.pay(quote, { note }) : await this.wallet.payQuote(quote, mint, note) };
  }

  /** A Lightning address or LNURL (LUD-16, LUD-06): resolved here, in the engine, so every platform fetches the same way. */
  lnurlResolve({ text }: { text: string }) { return this.lightning.resolveDestination(text); }
  lnurlInvoice({ id, amount, comment }: { id: string; amount: number; comment?: string }) { return this.lightning.destinationInvoice(id, amount, comment); }

  checkPayment(params: { linkId: string; paymentId: string }) { return this.desk.checkPayment(params); }

  /** Makes a provider this mode's Lightning source, with the values of its form (secrets are sealed). */
  async lightningSetSource({ providerId, values }: { providerId: string; values: Record<string, string> }) { await this.lightning.sources.set(providerId, values); await this.refreshWallet(); }
  /** Back to the default source, the Cashu mints. */
  async lightningClearSource() { await this.lightning.sources.clear(); await this.refreshWallet(); }
  async lightningRetrySource() { await this.lightning.sources.retryNow(); await this.refreshWallet(); }
  async lightningReconfigureSource({ values }: { values: Record<string, string> }) { await this.lightning.sources.reconfigure(values); await this.refreshWallet(); }
  async lightningRefresh() { await this.lightning.sources.refresh(); await this.lightning.reconcile(); }
  async bitcoinSetSource({ providerId, values }: { providerId: string; values: Record<string, string> }) { await this.bitcoin.sources.set(providerId, values); await this.refreshWallet(); }
  async bitcoinClearSource() { await this.bitcoin.sources.clear(); await this.refreshWallet(); }
  async bitcoinRetrySource() { await this.bitcoin.sources.retryNow(); await this.refreshWallet(); }
  async bitcoinReconfigureSource({ values }: { values: Record<string, string> }) { await this.bitcoin.sources.reconfigure(values); await this.refreshWallet(); }
  async bitcoinReceiveAddress() { const address = await this.bitcoin.receiveAddress(); await this.refreshWallet(); return address; }
  bitcoinRefresh() { return this.bitcoin.sources.refresh(); }

  walletInspectCashu({ text }: { text: string }) {
    return { inspection: this.wallet.inspect(text) };
  }

  async walletReceiveToken({ token }: { token: string }) {
    const { amount } = await this.wallet.receiveToken(token.trim());
    return { amount };
  }

  walletExport() {
    return this.wallet.exportTokens();
  }

  usdtCreate(params:Parameters<EngineApi["usdtCreate"]>[0]) {return this.usdtWallet.create(params);}
  usdtUnlock(params:{password:string}) {return this.usdtWallet.unlock(params.password);}
  usdtReveal(params:{password?:string}) {return this.usdtWallet.reveal(params.password);}
  usdtLock() {return this.usdtWallet.lock();}
  usdtRefresh() {return this.usdtWallet.refresh();}
  usdtGetTestTokens() {return this.usdtWallet.getTestTokens();}
  usdtExportBackup(params:{password:string}) {return this.usdtWallet.exportBackup(params.password);}
  async usdtRestoreBackup(params:{text:string;password:string}) {await this.usdtWallet.restoreBackup(params.text,params.password);await this.usdtWallet.ensureReady();}
  arkCreate(params: Parameters<EngineApi["arkCreate"]>[0]) { return this.arkWallet.create(params); }
  arkUnlock(params: { password: string }) { return this.arkWallet.unlock(params.password); }
  arkLock() { return this.arkWallet.lock(); }
  arkBackup(params: { password?: string }) { return this.arkWallet.backup(params.password); }
  arkExportBackup(params:{password:string}) { return this.arkWallet.exportBackup(params.password); }
  async arkRestoreBackup(params:{text:string;password:string}) { await this.arkWallet.restoreBackup(params.text,params.password); await this.arkWallet.ensureReady(); }
  arkRefresh() { return this.arkWallet.refresh(); }
  arkRecover() { return this.arkWallet.recover(); }
  barkCreate(params: Parameters<EngineApi["barkCreate"]>[0]) { return this.barkWallet.create(params); }
  barkBackup() { return this.barkWallet.backup(); }
  barkExportBackup(params: { password: string }) { return this.barkWallet.exportBackup(params.password); }
  async barkRestoreBackup(params: { text: string; password: string }) { await this.barkWallet.restoreBackup(params.text, params.password); await this.barkWallet.ensureReady(); }
  barkRefresh() { return this.barkWallet.refresh(); }
  fedimintPreview(params: { invite: string }) { return this.fedimintWallet.preview(params.invite); }
  async fedimintJoin(params: { invite: string; recover?: boolean }) { const joined = await this.fedimintWallet.join(params.invite, { recover: !!params.recover }); void this.lightning.ensureReady(); return joined; }
  fedimintLeave(params: { federation: string }) { return this.fedimintWallet.leave(params.federation); }
  fedimintRefresh() { return this.fedimintWallet.refresh(); }
  async fedimintSpendNotes(params: { federation: string; amount: number }) { const { notes, operationId } = await this.fedimintWallet.spendNotes(params.federation, params.amount); return { notes, operation: operationId }; }
  fedimintReceiveNotes(params: { notes: string }) { return this.fedimintWallet.receiveNotes(params.notes); }
  fedimintInvoice(params: { federation: string; amount: number; memo?: string }) { return this.fedimintWallet.createInvoice(params.federation, params.amount, params.memo ?? "").then(({ invoice }) => ({ invoice })); }
  fedimintTakeBack(params: { federation: string; operation: string }) { return this.fedimintWallet.takeBack(params.federation, params.operation); }
  fedimintBackup() { return this.fedimintWallet.backup(); }
  fedimintExportBackup(params: { password: string }) { return this.fedimintWallet.exportBackup(params.password); }
  fedimintRestoreBackup(params: { text: string; password: string }) { return this.fedimintWallet.restoreBackup(params.text, params.password); }
  fedimintRestorePhrase(params: { mnemonic: string; invites: string[] }) { return this.fedimintWallet.restorePhrase(params.mnemonic, params.invites); }
  barkBoard() { return this.barkWallet.board(); }
  /** Testnet's Spark wallet is made by itself; this makes Mainnet's (with a Breez API key) or restores from a phrase. */
  async sparkCreate(params: Parameters<EngineApi["sparkCreate"]>[0]) { await this.sparkWallet.create(params); }
  async sparkBackup() { const { mnemonic, network } = await this.sparkWallet.backup(); return { mnemonic, network }; }
  sparkExportBackup(params: { password: string }) { return this.sparkWallet.exportBackup(params.password); }
  async sparkRestoreBackup(params: { text: string; password: string; apiKey?: string }) { await this.sparkWallet.restoreBackup(params.text, params.password, params.apiKey); await this.sparkWallet.ensureReady(); }
  sparkRefresh() { return this.sparkWallet.refresh(); }
  /**
   * One seed for both: the Spark wallet of this mode becomes the Breez Lightning source too. The SDK is shared (same
   * seed, same storage), so there is one wallet and one balance behind the Spark and Lightning cards.
   */
  async sparkUseForLightning() {
    const { mnemonic, apiKey } = await this.sparkWallet.backup();
    await this.lightning.sources.set(BREEZ_SOURCE, { mnemonic, ...(apiKey ? { apiKey } : {}) });
    await this.refreshWallet();
  }
  async preparePayment(params: Parameters<EngineApi["preparePayment"]>[0]) {
    if (params.linkId) {
      const link=this.paymentLink(params.linkId); if(!link)throw new Error("The peer is offline");
      // Whom the link pays: the chat's contact, or the community member it names.
      const payee=this.links.get(params.linkId)?.stored.peerPubKeyZ32 ?? parsePayLink(params.linkId)?.member ?? "";
      await link.requirePaymentSupport();
      if(params.target.method==="cashu" && !link.allowsPayment("cashu"))throw new Error("Cashu is off in this chat");
      if(params.target.method==="usdt" && !link.supportsUsdtPayments)throw new Error("This peer does not support USDT payments");
      if(params.target.method==="arkade" && !link.supportsArkPayments)throw new Error("This peer does not support Ark payments");
      if(params.target.method==="bark" && !link.supportsBarkPayments)throw new Error("This peer does not support Bark payments");
      if(params.target.method==="bitcoin" && !link.supportsBitcoinPayments)throw new Error("This peer does not take on-chain Bitcoin in this chat");
      if(params.target.method==="fedimint" && !link.supportsFedimintPayments)throw new Error("This peer does not take Fedimint in this chat");
      if(params.target.method==="spark" && !link.supportsSparkPayments)throw new Error("This peer does not take Spark in this chat");
      const request=params.requestId ? this.desk.payment(params.requestId) : undefined;
      if(params.requestId){
        if(!request || request.linkId!==params.linkId || request.direction!=="in" || request.state!=="pending" || request.amount!==params.amount)throw new Error("Payment review does not match the authenticated request");
        if(params.target.method!=="cashu" ? JSON.stringify(request.target)!==JSON.stringify(params.target) : !!request.target || params.target.address!==request.id || !request.mints?.includes(params.target.provider))throw new Error("Selected method or mint does not match the authenticated request");
        if(request.lightningPending || Object.values(this.desk.views()).some(p=>p.kind==="payment" && p.requestId===request.id && p.linkId===params.linkId && !["failed","reclaimed"].includes(p.state)))throw new Error("This request already has a payment; reconcile it instead");
      } else if(params.target.method!=="cashu" || !payee || params.target.address!==payee)throw new Error("Destination does not match the authenticated peer");
      params={...params,payee};
    }
    if(params.target.method==="cashu" && !params.linkId)throw new Error("Select a Cashu chat request first");
    if(params.target.method==="fedimint" && !params.requestId)throw new Error("Fedimint ecash is paid on a contact's request in a chat");
    const memo=typeof params.memo==="string" ? params.memo.trim().slice(0,140) || undefined : undefined;
    return this.paymentCoordinator.prepare(params.target,params.amount,params.feeCap,{payee:params.payee,linkId:params.linkId,requestId:params.requestId,memo});
  }
  async approvePayment(params: {id:string}) {
    const intent=await intentRepository.get(params.id);
    if(intent?.review.linkId) {
      const link=this.paymentLink(intent.review.linkId);
      if(!link || (intent.review.method==="arkade" && !link.supportsArkPayments))throw new Error("Reconnect the data link before approving. Your review was saved.");
      if(intent.review.method==="usdt" && !link.supportsUsdtPayments)throw new Error("Reconnect a peer supporting USDT before approving");
      if(intent.review.method==="bark" && !link.supportsBarkPayments)throw new Error("Reconnect a peer supporting Bark before approving");
      if(intent.review.method==="bitcoin" && !link.supportsBitcoinPayments)throw new Error("Reconnect a peer taking on-chain Bitcoin before approving");
      if(intent.review.method==="fedimint" && !link.supportsFedimintPayments)throw new Error("Reconnect a peer taking Fedimint before approving");
      if(intent.review.method==="spark" && !link.supportsSparkPayments)throw new Error("Reconnect a peer taking Spark before approving");
      if(intent.review.method==="cashu" && !link.allowsPayment("cashu"))throw new Error("Cashu is off in this chat");
      await link.requirePaymentSupport();
      if (intent.review.requestId) {
        const request = this.desk.payment(intent.review.requestId);
        if (!request || request.state !== "pending" || request.lightningPending) throw new Error("This request is no longer awaiting payment. Check its status before spending.");
      }
    }
    const review=await this.paymentCoordinator.approve(params.id);
    await this.desk.confirmReviewedCashu(review);
    if(review.state==="settled")await this.desk.recordArk(review).catch(()=>{});
    await this.desk.recordBark(review).catch(()=>{});
    await this.desk.recordBitcoin(review).catch(()=>{});
    await this.desk.recordSpark(review).catch(()=>{});
    await this.desk.recordUsdt(review).catch(()=>{});
    await this.arkWallet.refresh();await this.barkWallet.refresh();await this.sparkWallet.refresh();await this.usdtWallet.refresh();return review;
  }
  async reconcilePayment(params: {id:string}) {
    const review=await this.paymentCoordinator.reconcile(params.id);
    await this.desk.confirmReviewedCashu(review);
    if(review.state==="settled")await this.desk.recordArk(review).catch(()=>{});
    await this.desk.recordBark(review).catch(()=>{});
    await this.desk.recordBitcoin(review).catch(()=>{});
    await this.desk.recordSpark(review).catch(()=>{});
    await this.desk.recordUsdt(review).catch(()=>{});
    await this.arkWallet.refresh();await this.barkWallet.refresh();await this.sparkWallet.refresh();await this.usdtWallet.refresh();return review;
  }
  cancelPayment(params: {id:string}) { return this.paymentCoordinator.cancel(params.id); }

  sendPayment(params: { linkId: string; amount: number; memo?: string; timestamp: number }) {
    const live = this.links.get(params.linkId);
    // Ecash is a bearer token: it is never held for an away contact, only a request for it is.
    if (live && this.holdingFor(live)) throw new Error("Ecash is not held for an away contact. Send a request instead, or wait until they are back.");
    return this.desk.send(params);
  }

  requestPayment(params: { linkId: string; amount: number; memo?: string; timestamp: number; method?: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin" | "fedimint" | "spark"; rail?: "cashu" | "lightning" }) {
    return this.desk.request({ linkId: params.linkId, amount: params.amount, memo: params.memo, timestamp: params.timestamp, method: params.method,
      ...(params.rail === "cashu" || params.rail === "lightning" ? { rail: params.rail } : {}) });
  }

  /** A request any member of a group may pay, once (WISP 9xx § Payments). */
  requestGroupPayment(params: { groupId: string; amount: number; memo?: string; timestamp: number; rail: "cashu" | "lightning" }) {
    const group = this.groups.views().find(g => g.id === params.groupId);
    if (group?.status !== "active") throw new Error("You are not in this group");
    if (group.members.length < 2) throw new Error("Nobody else is in the group yet");
    return this.desk.requestFromGroup(params);
  }

  /** Paying on a card without a request (Ark, Bark, Spark, USDT, on-chain): the contact's app answers with one. */
  askToPay(params: { linkId: string; amount: number; method: "arkade" | "usdt" | "bark" | "bitcoin" | "spark" | "fedimint"; memo?: string; timestamp: number }) {
    if (params.method !== "arkade" && params.method !== "usdt" && params.method !== "bark" && params.method !== "bitcoin" && params.method !== "fedimint" && params.method !== "spark") throw new Error("Only Ark, Bark, Spark, USDT, on-chain Bitcoin and Fedimint are paid this way");
    return this.desk.ask(params);
  }

  payRequest(params: { linkId: string; paymentId: string; via?: "lightning"; maxFee?: number }) {
    return this.desk.payRequest(params);
  }

  reclaimPayment({ paymentId }: { paymentId: string }) {
    return this.desk.reclaim(paymentId);
  }

  // -- services ------------------------------------------------------------

  addService({ name, target }: { name: string; target: string }): { serviceId: string } {
    const cleanName = name.trim().slice(0, 48);
    if (!cleanName) throw new Error("Give the service a name");
    const normalized = formatLocalTarget(parseLocalTarget(target));
    const service: StoredService = {
      id: serviceIdFromName(
        cleanName,
        this.services.map((s) => s.id),
      ),
      name: cleanName,
      target: normalized,
      enabled: true,
      createdAt: Date.now(),
    };
    this.services.push(service);
    void db.putService(service);
    this.servicesChanged();
    return { serviceId: service.id };
  }

  removeService({ serviceId }: { serviceId: string }): void {
    this.services = this.services.filter((s) => s.id !== serviceId);
    void db.deleteService(serviceId);
    this.servicesChanged();
  }

  setServiceShared({ serviceId, peerPubKeyZ32, shared }: { serviceId: string; peerPubKeyZ32: string; shared: boolean }): void {
    const service = this.services.find((s) => s.id === serviceId);
    if (!service) return;
    const granted = new Set(service.sharedWith ?? []);
    if (shared) granted.add(peerPubKeyZ32); else granted.delete(peerPubKeyZ32);
    if (granted.size === (service.sharedWith?.length ?? 0) && [...granted].every(k => service.sharedWith?.includes(k))) return;
    service.sharedWith = [...granted];
    void db.putService(service);
    this.servicesChanged();
  }

  setServiceEnabled({ serviceId, enabled }: { serviceId: string; enabled: boolean }): void {
    const service = this.services.find((s) => s.id === serviceId);
    if (!service || service.enabled === enabled) return;
    service.enabled = enabled;
    void db.putService(service);
    this.servicesChanged();
  }

  // -- settings ------------------------------------------------------------

  /** The name contacts are told: none while this profile does not share it. */
  private get sharedNick(): string | undefined { return this.settings.shareProfile === false ? undefined : this.settings.nick || undefined; }
  private get sharedAvatar(): string | undefined { return this.settings.shareProfile === false ? undefined : this.settings.avatar || undefined; }

  async updateSettings({ settings: patch }: { settings: SettingsPatch }): Promise<void> {
    const { nostr, ...rest } = patch;
    const settings: Partial<Settings> = rest;
    const wasOnline = this.settings.online;
    // Checked before anything changes: a relay list with no relay, or a TURN server a browser rejects,
    // would leave this peer unreachable or without WebRTC.
    for (const server of settings.iceServers ?? []) { const problem = iceServerProblem(server); if (problem) throw new Error(problem); }
    if (settings.avatar !== undefined && settings.avatar !== "" && typeof sanitizeAvatar(settings.avatar) !== "string") throw new Error("Use a small JPEG picture");
    if (settings.relays && this.relays && !settings.relays.some((relay) => normalizeRelayUrl(relay))) throw new Error("Enter at least one relay address (https://…)");
    if (settings.irohRelays) {
      if (settings.irohRelays.length > 4) throw new Error("Use at most four Iroh relays");
      for (const relay of settings.irohRelays) { const problem = irohRelayProblem(relay); if (problem) throw new Error(problem); }
    }
    const irohRelaysChanged = settings.irohRelays !== undefined && JSON.stringify(settings.irohRelays) !== JSON.stringify(this.settings.irohRelays ?? []);
    // Of the Nostr settings, only what the patch names changes; the rest stays as stored (or the defaults).
    if (nostr) {
      const current = effectiveNostrSettings(this.settings.nostr);
      settings.nostr = { relays: normalizeNostrRelays(nostr.relays ?? current.relays), autoLoadProfiles: (nostr.autoLoadProfiles ?? current.autoLoadProfiles) === true, publish: (nostr.publish ?? current.publish) === true };
    }
    this.settings = { ...this.settings, ...settings };
    if (!this.settings.irohRelays?.length) delete this.settings.irohRelays;
    if (irohRelaysChanged) void this.rehomeIroh();
    if (settings.relays) {
      this.relays?.setRelays(settings.relays);
      if (this.relays) this.settings.relays = this.relays.describe().relays;
    }
    await db.putSettings(this.settings);

    if (settings.avatar !== undefined) {
      if (!this.settings.avatar) delete this.settings.avatar;
      await db.putSettings(this.settings);
    }
    if (settings.shareProfile !== undefined) {
      if (settings.shareProfile !== false) delete this.settings.shareProfile;
      await db.putSettings(this.settings);
    }
    // Contacts connected now are told at once, the others on their next session.
    if (settings.avatar !== undefined || settings.shareProfile !== undefined) {
      for (const live of this.links.values()) live.link?.setAvatar(this.sharedAvatar);
    }
    if (settings.nick !== undefined || settings.shareProfile !== undefined) {
      // GhostLink tells a paired peer directly; a legacy one still reads the record.
      for (const live of this.links.values()) live.link?.setNick(this.sharedNick);
      // A chat that is not live learns the name from the capability record.
      this.capsChanged();
    }
    if (settings.holdStorage !== undefined) {
      if (!this.settings.holdStorage) delete this.settings.holdStorage;
      await db.putSettings(this.settings);
      this.hold.storageChanged();
    }
    if (wasOnline && !this.settings.online) {
      await Promise.allSettled(
        [...this.links.values()].map(async (live) => {
          await live.link?.stop(true); await live.caps?.stop(); live.caps = undefined;
          live.link = null;
          live.status = "offline";
          live.dataLink = "idle";
        }),
      );
    } else if (!wasOnline && this.settings.online) {
      for (const live of this.links.values()) this.startLink(live.stored.id, await db.getMessages(live.stored.id));
      this.hold.start();
      this.startGroupEntries();
      this.prepareSpare();
    }
    if (wasOnline && !this.settings.online) this.stopGroupEntries();
    if (wasOnline && !this.settings.online) await this.hold.stop();
    this.emitState();
  }

  // -- internals -----------------------------------------------------------

  private async addLink({ participationSeedB64, ...params }: LinkParams, inviteCode?: string): Promise<string> {
    const stored: StoredLink = {
      id: identityFromSeedB64(params.seedB64).pubKeyZ32.slice(0, 16),
      ...params,
      // The inviter's key is the one its ghostly1 code carries; the joiner's is fresh.
      ...(params.profile ? { participationSeed: participationSeedB64 ?? createIdentity().seedB64 } : {}),
      createdAt: Date.now(),
      inviteCode,
    };
    this.links.set(stored.id, newLiveLink(stored, 0));
    try { await db.putLink(stored); }
    catch (error) { this.links.delete(stored.id); throw error; }
    if (this.settings.online) this.startLink(stored.id, []);
    // The other side is due any moment: the joiner's inviter is polling for this very moment and its offer
    // (or its answer) is a poll away; an inviter's contact is reading the invite right now more often than
    // not. Both look fast for a while, as a group's entry session does.
    if (params.profile) this.links.get(stored.id)?.link?.expectPeer();
    if (params.profile && inviteCode && this.settings.online) this.warmInviteKey(inviteCode);
    this.emitState();
    return stored.id;
  }

  /**
   * The first packet under a key nobody has heard of takes the network seconds (the DHT's iterative
   * lookup before the store, on every relay's side too); the next one under a known key lands in under a
   * second. The invite holds the contact's link key, so the inviter puts an empty packet there now: when
   * the contact joins, minutes later, their first packet replaces a known one. The packet says nothing
   * (no services, no messages) and the link session reads it as no packet at all.
   */
  private warmInviteKey(inviteCode: string): void {
    const invite = decodeInviteCode(inviteCode);
    if (!invite) return;
    try {
      const identity = identityFromSeedB64(invite.seedB64);
      // Warmed ahead of time (`takeInvite`): another empty packet now would only be one the relays queue.
      if (Date.now() - (this.warmedKeys.get(identity.pubKeyZ32) ?? 0) < SPARE_INVITE_MAX_AGE_MS) return;
      this.warmedKeys.set(identity.pubKeyZ32, Date.now());
      void this.transport.publish(identity, emptyLinkRecords()).catch(() => {});
    } catch { /* a malformed invite warms nothing */ }
  }

  /** What this peer advertises. Chat, voice and video are what Ghostly always offered. */
  /** A contact is only told about the services it was granted. */
  private advertisedServices(peerPubKeyZ32: string): ServiceAd[] {
    return [
      ...LEGACY_SERVICES,
      ...this.services
        .filter((s) => mayReach(s, peerPubKeyZ32))
        .map((s): ServiceAd => ({ id: s.id, type: "http", name: s.name, proto: HTTP_SERVICE_PROTO })),
    ];
  }

  /** The only place a service id turns into a URL. Disabled or unknown ids do not resolve. */
  /**
   * The authorization, on the side that serves. Filtering the advertisement is
   * not enough: a contact that saw an id once, or guessed one, would still be
   * served. This is the check that decides.
   */
  private hostedService(id: string, peerPubKeyZ32: string): HostedHttpService | undefined {
    const service = this.services.find((s) => s.id === id);
    if (!service || !mayReach(service, peerPubKeyZ32)) return undefined;
    try {
      const target = parseLocalTarget(service.target);
      this.requestCounts.set(id, (this.requestCounts.get(id) ?? 0) + 1);
      this.emitState();
      return { id, target };
    } catch {
      return undefined;
    }
  }

  /** The edge of a group toward one member: a paired link pinned to that member's key, carrying group frames and nothing else. */
  private async openEdge(state: { id: string; seedB64: string }, peer: string, expectPeer = false): Promise<string> {
    const me = identityFromSeedB64(state.seedB64);
    const params = edgeParams(state.id, me.seed, me.pubKeyZ32, peer);
    const id = identityFromSeedB64(params.seedB64).pubKeyZ32.slice(0, 16);
    if (this.links.has(id)) return id;
    const stored: StoredLink = { id, ...params, participationSeed: state.seedB64, pairedPeerKey: peer, requireSignedSignals: true,
      peerTrust: { version: 1, verifiedKey: peer }, group: state.id, groupPeer: peer, createdAt: Date.now() };
    this.links.set(id, newLiveLink(stored, 0));
    try { await db.putLink(stored); }
    catch (error) { this.links.delete(id); throw error; }
    if (this.settings.online) this.startLink(id, []);
    if (expectPeer) this.links.get(id)?.link?.expectPeer();
    return id;
  }

  /**
   * An entry session of a group's link: a paired link derived like an edge, from the entry key and
   * the joiner's member key, pinned to the other one in advance. It carries the admission and nothing else.
   */
  private async openEntry(link: GroupEntryLink, role: "host" | "guest", seedB64: string, peer: string): Promise<string> {
    const me = identityFromSeedB64(seedB64);
    const params = entryParams(link, me.seed, me.pubKeyZ32, peer);
    const id = identityFromSeedB64(params.seedB64).pubKeyZ32.slice(0, 16);
    if (this.links.has(id)) return id;
    const stored: StoredLink = { id, ...params, participationSeed: seedB64, pairedPeerKey: peer, requireSignedSignals: true,
      peerTrust: { version: 1, verifiedKey: peer }, group: link.g, groupPeer: peer, groupEntry: role, createdAt: Date.now() };
    this.links.set(id, newLiveLink(stored, 0));
    try { await db.putLink(stored); }
    catch (error) { this.links.delete(id); throw error; }
    if (this.settings.online) this.startLink(id, []);
    // The other side is due any moment (the admin's app answers a knock in seconds): look fast meanwhile.
    this.links.get(id)?.link?.expectPeer();
    return id;
  }

  private startGroupEntries(): void {
    if (this.groupEntryTimer || this.shuttingDown) return;
    this.groupEntryTimer = setInterval(() => void this.groups.tick().catch(() => {}), 1_000);
  }
  private stopGroupEntries(): void {
    if (this.groupEntryTimer) clearInterval(this.groupEntryTimer);
    this.groupEntryTimer = null;
  }

  private startEdge(linkId: string): void {
    const live = this.links.get(linkId);
    if (!live || live.link) return;
    const { stored } = live;
    const group = stored.group!, peer = stored.groupPeer!, entry = !!stored.groupEntry;
    const role = stored.groupEntry ?? "edge";
    let seen = false;
    live.pairing = { status: "connecting" };
    live.link = new GhostLink({
      // An edge carries payments with its member (WISP 9xx § Payments), as a chat does; an entry session does not.
      paymentMethods: entry ? { cashu: false, lightning: false, arkade: false, usdt: false, bark: false, bitcoin: false, fedimint: false, spark: false } : stored.paymentMethods,
      arkPaymentsSupport: !entry,
      usdtPaymentsSupport: !entry,
      barkPaymentsSupport: !entry,
      params: stored,
      rtcAvailable: typeof RTCPeerConnection !== "undefined",
      // Pinned in advance to the member the roster names: there is nothing to trust on first use.
      pairing: { credentials: { seedB64: stored.participationSeed!, peerKey: peer, requireSignedSignals: true, verifiedPeerKey: peer },
        pinPeer: async key => { if (key !== peer) throw new Error("Not the member this edge belongs to"); }, trustOnFirstUse: false },
      transport: this.transport,
      nick: this.sharedNick,
      pollIntervals: this.pollIntervals,
      autoConnect: true,
      createPeerConnection: () =>
        new RTCPeerConnection({ iceServers: [...(RTC_CONFIG.iceServers ?? []), ...this.settings.iceServers.filter((server) => !iceServerProblem(server))] }),
      localFetch: this.localFetch,
      getServices: () => [{ id: "chat", type: "chat" }],
      getHostedHttpService: () => undefined,
      groupsSupport: true,
      events: {
        // An entry session carries the admission frames a contact chat would; an edge, the group's own, and what the group sees of payments.
        onGroupFrame: frame => entry ? this.groups.handleContactFrame(linkId, frame)
          : (frame as { t?: unknown }).t === "group-pay" ? this.groupPayments.receive(group, peer, frame) : this.groups.handleEdgeFrame(group, peer, frame),
        onGroupsSupport: supported => {
          if (supported) traceJoin(group, "link.ready", { role });
          if (supported) {
            if (entry) this.groups.entryReady(group, linkId, peer);
            else { this.groups.edgeReady(group, peer, linkId); void this.groupPayments.edgeReady(group, linkId).catch(() => {}); }
          }
          this.emitState();
        },
        ...(entry ? {} : {
          onPaymentRequest: (request: PaymentRequest) => this.desk.onPaymentRequest(linkId, request),
          onPaymentAsk: (ask: PaymentAsk) => this.desk.onPaymentAsk(linkId, ask),
          onPayment: (payment: Payment) => this.desk.onPayment(linkId, payment),
          onPaymentResult: (result: PaymentResult) => this.desk.onPaymentResult(linkId, result),
        }),
        onPresence: presence => {
          if (presence.online && !seen) { seen = true; traceJoin(group, "link.presence", { role }); }
          if (presence.lastPacketAt !== live.presence.lastPacketAt) traceJoin(group, "link.packet", { role, packetAt: presence.lastPacketAt });
          live.presence = presence; if (!entry) this.groups.edgeNick(group, peer, presence.nick); this.emitState(); },
        onPairingState: state => { live.pairing = state; this.emitState(); },
        onDataLinkState: state => {
          traceJoin(group, `link.${state}`, { role });
          // The last moment the member was reachable on it: when it opens, and when it stops being open.
          if (state === "open" || live.dataLink === "open") live.lastSyncAt = Date.now();
          // Payments with this member that did not get through go again, never twice.
          if (state === "open" && !entry) void this.desk.replay(linkId).catch(() => {});
          live.dataLink = state;
          if (state !== "open" && live.pairing?.status !== "error") live.pairing = { status: "connecting" };
          this.emitState();
        },
        onStatus: status => { live.status = status; this.emitState(); },
        onDiscoveryError: error => { live.discoveryError = error ?? undefined; this.emitState(); },
      },
    });
    traceJoin(group, "link.start", { role });
    live.link.start();
  }

  private startLink(linkId: string, messages: StoredMessage[]): void {
    const live = this.links.get(linkId);
    if (!live || live.link) return;
    const { stored } = live;
    if (stored.group) return this.startEdge(linkId);
    if (stored.profile) live.pairing = { status: "connecting" };
    const lastSeenTimestamp = messages.reduce(
      (max, m) => (m.sender === "peer" && m.via === "pkarr" ? Math.max(max, m.timestamp) : max),
      0,
    );

    // One set of credentials for the link and its capability record: a pin by either is seen by both.
    const credentials: PairingCredentials | undefined = stored.profile && stored.participationSeed ? {
      seedB64: stored.participationSeed, peerKey: stored.pairedPeerKey, requireSignedSignals: stored.requireSignedSignals,
      verifiedPeerKey: stored.peerTrust ? stored.peerTrust.verifiedKey : stored.pairedPeerKey, expectedPeerKey: stored.peerParticipationKeyZ32 } : undefined;
    live.link = new GhostLink({
      paymentMethods: stored.paymentMethods,
      holdSupport: !!stored.hold?.enabled,
      arkPaymentsSupport: true,
      usdtPaymentsSupport: true,
      barkPaymentsSupport: true,
      params: stored,
      rtcAvailable: typeof RTCPeerConnection !== "undefined",
      // Call media is a WebRTC connection of its own, whatever carries the chat: no WebRTC, no calls (Linux WebKitGTK).
      callsSupport: typeof RTCPeerConnection !== "undefined",
      servicesSupport: this.options.servicesSupport ?? (this.options.platform ?? "web") !== "web",
      dht: stored.profile ? { state: stored.dhtDeliveryState, save: async state => {
        await db.patchLink(linkId, { dhtDeliveryState: state });
        live.stored = { ...live.stored, dhtDeliveryState: state };
      } } : undefined,
      native: { peerDescriptors: stored.peerDescriptors, peerTransports: stored.peerTransports,
        peerFallback: stored.peerFallback, preferred: stored.preferredTransport, fallback: stored.transportFallback },
      pairing: credentials ? {
        credentials,
        verifyPeer: async key => {
          await db.verifyPeer(stored.id, key);
          live.stored = { ...live.stored, peerTrust: { version: 1, verifiedKey: key, verifiedAt: Date.now() } };
          this.emitState();
        },
        pinPeer: async (key, signedSignals) => {
          if (live.stored.pairedPeerKey && live.stored.pairedPeerKey !== key) throw new Error("Already paired");
          // A ghostly1 invite named the inviter: anyone else holding a copy of it cannot answer as them.
          if (live.stored.peerParticipationKeyZ32 && live.stored.peerParticipationKeyZ32 !== key) throw new Error("Not the key this invite named");
          const previous = live.stored;
          live.stored = { ...live.stored, peerTrust: live.stored.peerTrust ?? { version: 1, verifiedKey: live.stored.pairedPeerKey }, pairedPeerKey: key, requireSignedSignals: live.stored.requireSignedSignals || signedSignals, inviteCode: undefined };
          try { await db.pinPeer(stored.id, key, signedSignals); }
          catch (error) { live.stored = previous; throw error; }
          // Pinned just now (not a later session or envelope confirming the same key): the record is sealed
          // anew for the contact alone, and the contact's is read.
          if (!previous.pairedPeerKey) { void live.caps?.update().catch(() => {}); live.caps?.refresh(true); }
        },
      } : undefined,
      // A chat never paired: the one who made the invite still holds it; the one who joined does not.
      pairingProgress: stored.profile && stored.participationSeed && !stored.pairedPeerKey
        ? { role: stored.inviteCode ? "inviter" : "joiner", startedAt: stored.createdAt } : undefined,
      transport: this.transport,
      nick: this.sharedNick,
      avatar: this.sharedAvatar,
      lastSeenTimestamp,
      pollIntervals: this.pollIntervals,
      autoConnect: true,
      createPeerConnection: () =>
        new RTCPeerConnection({ iceServers: [...(RTC_CONFIG.iceServers ?? []), ...this.settings.iceServers.filter((server) => !iceServerProblem(server))] }),
      localFetch: this.localFetch,
      getServices: () => stored.profile ? [{ id: "chat", type: "chat" }] : this.advertisedServices(stored.peerPubKeyZ32),
      // A paired contact learns only the apps granted to it, on the open session; nothing is published.
      getPairedServices: () => this.advertisedServices(stored.peerPubKeyZ32).filter((service) => service.type === "http"),
      getHostedHttpService: (id) => this.hostedService(id, stored.peerPubKeyZ32),
      // Private groups are announced on paired chats; their admission frames arrive here.
      groupsSupport: !!stored.profile,
      events: {
        onPairingProgress: progress => { live.pairingProgress = progress; this.emitState(); },
        onGroupFrame: stored.profile ? frame => this.groups.handleContactFrame(linkId, frame) : undefined,
        onGroupsSupport: () => this.emitState(),
        onDhtDelivery: () => { if (stored.profile && !stored.group) void this.outboxes.get(linkId)?.flush().catch(() => {}); this.observeTransport(linkId); this.emitState(); },
        onHold: (state) => this.hold.peerSaid(linkId, state),
        onPeerProof: EXTERNAL_IDENTITIES_ENABLED ? async frame => { await (await this.proofsFor(linkId)).receive(frame); } : undefined,
        onIdentityProof: stored.profile ? frame => this.identities.frame(linkId, frame) : undefined,
        onTransportsChanged: () => this.emitState(),
        onPeerTransportChoice: transport => { const log = this.transportLogOf(live); if (log?.chose("contact", transport, Date.now())) this.saveTransportLog(live, log); },
        onTransportSwitched: () => {
          // Frames of the old channel may have been cut short: what the contact has not confirmed goes again at
          // once over the new one (it acknowledges a repeated id without showing it twice), and so do payments.
          if (stored.profile && !stored.group) void this.outboxFor(linkId).flush({ reopened: true }).catch(() => {});
          void this.desk.replay(linkId).catch(() => {});
          this.observeTransport(linkId);
        },
        onTransportSwitchFailed: (target, reason) => {
          const log = this.transportLogOf(live);
          if (log?.switchFailed(target, reason ?? "It did not connect", Date.now())) this.saveTransportLog(live, log);
        },
        onRtt: ms => { const log = this.transportLogOf(live); if (log?.rtt(ms)) this.saveTransportLog(live, log); else this.emitState(); },
        onDiscoveryError: error => { live.discoveryError = error ?? undefined; this.emitState(); },
        onTransportDiscovery: async (peerDescriptors, peerTransports, peerFallback) => {
          const patch = { peerDescriptors, peerTransports, peerFallback };
          await db.patchLink(linkId, patch);
          live.stored = { ...live.stored, ...patch }; this.emitState();
        },
        onPairingState: state => {
          live.pairing = state;
          if (state.status === "ready") this.identities.ready(linkId); else this.identities.closed(linkId);
          // What the contact allows is remembered for requests held while it is away.
          if (state.status === "ready" && live.link) void this.hold.rememberPeerMethods(linkId, PAYMENT_METHODS.filter(m => live.link!.peerAllowsPayment(m))).catch(() => {});
          if (EXTERNAL_IDENTITIES_ENABLED && state.status === "ready") void this.proofsFor(linkId).then(p => p.resendWithdrawals()).catch(() => {});
          else live.proofs?.stop();
          this.observeTransport(linkId);
          this.emitState();
        },
        onStatus: (status) => {
          live.status = status;
          if (status === "online") live.lastSyncAt = Date.now();
          this.emitState();
        },
        onPoll: ({ polling, nextInMs }) => {
          live.poll = { polling, nextAt: Date.now() + nextInMs, interval: nextInMs || live.poll.interval };
          this.emitState();
        },
        onMessageReceipt: id => this.outboxFor(linkId).received(id),
        onPeerAck: (ack) => {
          if (stored.profile) return;
          if (ack === live.peerAck) return;
          live.peerAck = ack;
          this.emitState();
        },
        onDataLinkState: (state) => {
          const was = live.dataLink;
          live.dataLink = state;
          if (state === "open") {
            void this.desk.replay(linkId).catch(() => {}).then(() => this.sendWaiting(linkId)).catch(() => {});
            this.identities.ready(linkId);
          }
          if (state !== "open") { live.proofs?.stop(); this.identities.closed(linkId); }
          if (stored.profile && live.stored.deliveryMode !== "dht" && state !== "open") void this.outboxFor(linkId).disconnected().catch(() => {});
          // Dropped to the DHT: what the contact's app accepts there is read again (WISP 03).
          if (state !== "open" && was === "open") live.caps?.refresh();
          // Back live: what the contact has not confirmed goes again at once, under the same ids.
          if (stored.profile && !stored.group && state === "open") void this.outboxFor(linkId).flush({ reopened: true }).catch(() => {});
          if (stored.profile && state !== "open" && live.pairing?.status !== "error") live.pairing = { status: "connecting" };
          this.observeTransport(linkId);
          this.emitState();
        },
        onPeerAvatar: (avatar) => {
          if ((avatar ?? undefined) === live.stored.peerAvatar) return;
          live.stored = { ...live.stored, peerAvatar: avatar ?? undefined };
          void db.patchLink(linkId, { peerAvatar: avatar ?? undefined });
          this.emitState();
        },
        // A paired contact says its name on every session, and an empty one when it has none to show.
        onPeerNick: (nick) => {
          if ((nick ?? "") === live.stored.peerNick) return;
          live.stored = { ...live.stored, peerNick: nick ?? "" };
          void db.patchLink(linkId, { peerNick: nick ?? "" });
          this.emitState();
        },
        onPresence: (presence) => {
          live.presence = presence;
          // A legacy contact's name is in its record; a paired one's comes only from `onPeerNick`.
          if (!stored.profile && presence.nick && presence.nick !== live.stored.peerNick) {
            live.stored = { ...live.stored, peerNick: presence.nick };
            void db.patchLink(linkId, { peerNick: presence.nick });
          }
          this.emitState();
        },
        onMessage: (message) => {
          if (live.stored.inviteCode) {
            live.stored = { ...live.stored, inviteCode: undefined };
            void db.patchLink(linkId, { inviteCode: undefined });
          }
          return this.storeMessage({
            linkId,
            id: `peer_${message.id ?? message.timestamp}`,
            text: message.text,
            sender: "peer",
            timestamp: message.timestamp,
            via: message.via,
            nick: message.nick,
          });
        },
        onCallSignal: (signal) => this.events.onCallSignal(linkId, signal),
        // Each way of paying is checked where it is used: what this chat does not allow is dropped or refused.
        onPaymentRequest: (request) => this.desk.onPaymentRequest(linkId, request),
        onPaymentAsk: (ask) => this.desk.onPaymentAsk(linkId, ask),
        onPayment: (payment) => this.desk.onPayment(linkId, payment),
        onPaymentResult: (result) => this.desk.onPaymentResult(linkId, result),
        onFileStored: async wire => {
          const stored = (await fileStore.listForLink(linkId)).find(file => file.direction === "in" && file.wireId === wire.id);
          if (!stored?.digest || !stored.metadata) return undefined;
          if (stored.metadata.name !== wire.name || stored.metadata.size !== wire.size || stored.metadata.mime !== wire.mime || stored.metadata.timestamp !== wire.timestamp) return undefined;
          return stored.digest;
        },
        onFileIncoming: (file) => this.receiveFile(linkId, file),
        onFileProgress: (id, transferred, direction) =>
          this.fileProgress(this.localFileId(linkId, id, direction), transferred),
        onFileComplete: (id, direction) =>
          this.fileSettled(this.localFileId(linkId, id, direction, { failed: false })),
        onFileFailed: (id, reason, direction) =>
          this.fileSettled(this.localFileId(linkId, id, direction, { failed: true }), reason),
      },
    });
    const link = live.link;
    link.start(); this.emitState();
    if (credentials && !stored.group) {
      live.caps = new CapsExchange({
        params: stored, credentials, transport: this.transport, state: stored.capsState,
        local: () => this.capsContent(linkId),
        save: async state => { await db.patchLink(linkId, { capsState: state }); live.stored = { ...live.stored, capsState: state }; },
        changed: record => this.peerCapsChanged(linkId, record),
      });
      live.caps.start();
    }
    // Unused invites need discovery, not two native listeners. Saved contacts
    // retain background listeners within the real native capacity.
    if (stored.deliveryMode !== "dht" && (stored.pairedPeerKey || this.activeLinkId === linkId)) void this.ensureNativeEndpoints(linkId).then(() => {
      if (live.link === link && stored.peerTransports && stored.preferredTransport !== "webrtc/1" && live.myPubKeyZ32 < stored.peerPubKeyZ32)
        void link.connect().catch(() => {});
    });
  }

  /**
   * What this side's capability record says in a chat (WISP 03): the layer-0 capabilities (`dht-text/1`,
   * `hold/1` when Hold messages is on), what layer 1 would carry as this chat allows it, and the shared name.
   * Only what the other side needs to decide what to send, hold or queue: the whole offer does not fit 1,000 bytes.
   */
  private capsContent(linkId: string): CapsContent {
    const live = this.links.get(linkId);
    const methods = live?.stored.paymentMethods ?? {};
    const cashu = methods.cashu !== false, lightning = methods.lightning !== false;
    let name = this.sharedNick ?? "";
    while (new TextEncoder().encode(name).length > 64) name = [...name].slice(0, -1).join("");
    return {
      versions: [1],
      transports: live?.link?.availableTransports ?? ["webrtc/1"],
      capabilities: ["chat/1", DHT_TEXT_CAPABILITY, ...(live?.stored.hold?.enabled ? [HOLD_CAPABILITY] : []), "files/2",
        ...(cashu || lightning ? ["payments/1"] : []), ...(cashu ? ["payments-cashu/1"] : []), ...(lightning ? ["payments-lightning/1"] : [])],
      extensions: ["ping/1"],
      descriptors: {},
      name,
    };
  }

  /** Something the capability record carries changed here: every chat publishes its record anew if it differs. */
  private capsChanged(linkId?: string): void {
    for (const live of linkId ? [this.links.get(linkId)] : this.links.values()) void live?.caps?.update().catch(() => {});
  }

  /**
   * The contact's capability record changed. While no session is open it is the contact's latest word on its
   * name, on held items and on the ways of paying it takes: a chat that never went live still shows a name,
   * can hold, and can have requests wait for it. An open session's own word stays authoritative.
   */
  private peerCapsChanged(linkId: string, record: CapsRecord): void {
    const live = this.links.get(linkId);
    if (!live || live.link?.isDataLinkOpen) return;
    if (record.name !== (live.stored.peerNick ?? "")) {
      live.stored = { ...live.stored, peerNick: record.name };
      void db.patchLink(linkId, { peerNick: record.name });
    }
    void this.hold.peerSaid(linkId, { peerAllows: record.capabilities.includes(HOLD_CAPABILITY) });
    const methods = (["cashu", "lightning"] as const).filter(m => record.capabilities.includes(`payments-${m}/1`));
    void this.hold.rememberPeerMethods(linkId, methods).catch(() => {});
    this.emitState();
  }

  /** The native transports this engine runs: the host's, and Iroh's browser build where it runs in the page. */
  private get nativeFactories(): Partial<Record<NativeTransport, (seedB64: string) => Promise<NativeEndpoint>>> {
    return {
      ...this.options.nativeTransports,
      ...(this.options.irohWeb ? { "iroh/1": (seedB64: string) => createIrohWebEndpoint(seedB64, { relays: this.irohRelays }) } : {}),
    };
  }
  private get irohRelays(): string[] { return this.settings.irohRelays?.length ? this.settings.irohRelays : [...DEFAULT_IROH_RELAYS]; }

  /** New Iroh relays: idle endpoints move now; one carrying a chat keeps its relay until that session ends. */
  private async rehomeIroh(): Promise<void> {
    if (!this.options.irohWeb) return;
    for (const [linkId, live] of this.links) {
      const link = live.link;
      if (!link?.availableTransports.includes("iroh/1") || !link.canReleaseEndpoint("iroh/1")) continue;
      await link.releaseEndpoint("iroh/1");
      void this.ensureNativeEndpoints(linkId);
    }
  }

  private ensureNativeEndpoints(linkId: string): Promise<void> {
    const expected = this.links.get(linkId)?.link;
    const operation = this.nativeQueue.then(async () => {
      const live = this.links.get(linkId), link = live?.link;
      if (this.shuttingDown || !live?.stored.profile || live.stored.group || live.stored.deliveryMode === "dht" || !link || link !== expected) return;
      for (const [transport, factory] of Object.entries(this.nativeFactories)) {
        const key = transport as NativeTransport;
        if (!factory || link.availableTransports.includes(key)) continue;
        live.transportErrors ??= {};
        try {
          // The native SDKs each allow eight listeners. Reclaim an idle listener
          // only for the selected chat, never an established native connection.
          const owners = [...this.links.values()].filter(other => other.link?.availableTransports.includes(key));
          if (owners.length >= 8) {
            const victim = this.activeLinkId === linkId ? owners
              .filter(other => other !== live && other.stored.id !== this.activeLinkId && other.link?.canReleaseEndpoint(key))
              .sort((a, b) => a.lastMessageAt - b.lastMessageAt)[0] : undefined;
            if (!victim) throw new Error("All eight native connection slots are in use. Disconnect a native connection in another chat, then reopen this chat or press Reconnect.");
            await victim.link!.releaseEndpoint(key);
            victim.transportErrors ??= {};
            victim.transportErrors[key] = "Listener released for another chat. Open this chat to restore it; your messages and transport identity are saved.";
          }
          if (this.shuttingDown || live.link !== link) return;
          const seed = live.stored.transportSeeds?.[key] ?? createIdentity().seedB64;
          const transportSeeds = { ...live.stored.transportSeeds, [key]: seed };
          await db.patchLink(linkId, { transportSeeds });
          live.stored = { ...live.stored, transportSeeds };
          const endpoint = await factory(seed);
          if (this.shuttingDown || live.stored.deliveryMode === "dht" || live.link !== link || !this.links.has(linkId)) { await endpoint.close(); return; }
          link.registerEndpoint(endpoint);
          delete live.transportErrors[key];
        } catch (error) {
          live.transportErrors[key] = error instanceof Error ? error.message : "Native adapter could not start. Reopen this chat to retry.";
        }
      }
      this.emitState();
    });
    this.nativeQueue = operation.catch(() => {});
    return operation;
  }

  private async storeMessage(message: StoredMessage): Promise<void> {
    // A payment with a member lands in the group's history, from that member, under an id of the edge's own.
    const edge = this.links.get(message.linkId)?.stored;
    if (edge?.group && edge.groupPeer && !edge.groupEntry)
      message = { ...message, linkId: `group:${edge.group}`, id: `${edge.id}:${message.id}`, ...(message.sender === "peer" ? { member: edge.groupPeer } : {}) };
    // …and one with a member of a community, which has no edge: its link through the group names them.
    const pay = parsePayLink(message.linkId);
    if (pay?.member) message = { ...message, linkId: `group:${pay.groupId}`, id: `${message.linkId}:${message.id}`, ...(message.sender === "peer" ? { member: pay.member } : {}) };
    const live = this.links.get(message.linkId);
    // The peer republishes what it sent for a few minutes: what was deleted here stays deleted.
    if (live?.stored.deletedIds?.includes(message.id)) return;
    if (!(await db.addMessage(message))) return;
    if (message.sender === "peer") this.messageFeedback("message", message);
    if (live) live.lastMessageAt = Math.max(live.lastMessageAt, message.timestamp);
    this.events.onMessages(message.linkId, await db.getMessages(message.linkId));
    this.emitState();
  }

  private servicesChanged(): void {
    for (const live of this.links.values()) void live.link?.refreshServices();
    this.emitState();
  }

  private viewOf(live: LiveLink): LinkView {
    const { stored, presence } = live;
    return {
      id: stored.id,
      identities: this.identities.linkView(stored.id, live.link?.identitySupport ?? false),
      nostr: this.nostrSocial.linkView(stored.id),
      profile: stored.profile,
      pairing: live.pairing,
      pairingProgress: live.pairingProgress ?? live.link?.pairingProgress,
      discoveryError: live.discoveryError,
      peerVerified: !!stored.pairedPeerKey && (stored.peerTrust ? stored.peerTrust.verifiedKey === stored.pairedPeerKey : true),
      capabilities: this.capabilitiesOf(live),
      hold: this.hold.view(stored.id),
      paymentMethods: Object.fromEntries(PAYMENT_METHODS.map(m => [m, stored.paymentMethods?.[m] !== false])) as Record<PaymentMethodName, boolean>,
      groups: live.link?.groupsSupport ?? false,
      sessionOffers: stored.profile ? live.link?.sessionOffers : undefined,
      callsUnavailable: !stored.profile ? undefined : live.link ? live.link.callsUnavailable : "Calls need a live connection",
      participationKey: stored.participationSeed ? identityFromSeedB64(stored.participationSeed).pubKeyZ32 : undefined,
      peerParticipationKey: stored.pairedPeerKey,
      publicProfiles: EXTERNAL_IDENTITIES_ENABLED ? stored.publicProfiles : undefined,
      profileChoice: EXTERNAL_IDENTITIES_ENABLED ? stored.profileChoice : undefined,
      peerProofSupport: EXTERNAL_IDENTITIES_ENABLED && (live.link?.peerProofSupport ?? false),
      peerProofAdapters: EXTERNAL_IDENTITIES_ENABLED ? live.link?.peerProofAdapters ?? [] : [],
      peerProofs: EXTERNAL_IDENTITIES_ENABLED && stored.peerProofs ? { local: stored.peerProofs.local, remote: stored.peerProofs.remote } : undefined,
      proofError: EXTERNAL_IDENTITIES_ENABLED ? live.proofError : undefined,
      availableTransports: live.link?.availableTransports,
      deliveryMode: live.stored.deliveryMode ?? "stream",
      dhtDelivery: live.link?.dhtDelivery,
      canSendText: (live.link?.canSendText ?? false) || this.holdingFor(live),
      textDelivery: this.holdingFor(live) ? "hold" : live.link?.textDelivery ?? "unavailable",
      transportErrors: live.transportErrors,
      preferredTransport: live.stored.preferredTransport ?? "webrtc/1",
      transportFallback: live.stored.transportFallback ?? true,
      transportAutomatic: live.stored.preferredTransport === undefined,
      peerTransports: live.link?.peerAvailableTransports,
      transportRttMs: live.link?.rttMs,
      transportRelayed: live.link?.relayedPath,
      transportLive: live.transportLog?.liveNow(),
      // The whole story only for the chat on screen: every state push carries every link.
      transportLog: stored.id === this.activeLinkId && stored.profile && !stored.group ? stored.transportLog ?? [] : undefined,
      transportHistory: stored.id === this.activeLinkId && stored.profile && !stored.group ? stored.transportHistory ?? [] : undefined,
      myPubKeyZ32: live.myPubKeyZ32,
      peerPubKeyZ32: stored.peerPubKeyZ32,
      label: stored.label,
      peerNick: stored.peerNick,
      peerAvatar: stored.peerAvatar,
      inviteCode: stored.inviteCode,
      createdAt: stored.createdAt,
      status: live.status,
      dataLink: live.dataLink,
      peerOnline: presence.online,
      peerLastSeenAt: presence.lastPacketAt,
      peerServices: presence.services,
      lastMessageAt: live.lastMessageAt,
      peerAck: live.peerAck,
      lastSyncAt: live.lastSyncAt,
      poll: live.poll,
    };
  }

  /** What this chat can do right now: on the open session, or held for an away contact (text, files and requests only). */
  private capabilitiesOf(live: LiveLink): NonNullable<LinkView["capabilities"]> {
    const link = live.link;
    if (!this.holdingFor(live)) return { files: link?.supportsFiles ?? false, payments: link?.supportsPayments ?? false,
      calls: link?.supportsCalls ?? false, services: link?.supportsServices ?? false,
      methods: Object.fromEntries(PAYMENT_METHODS.map(m => [m, link?.allowsPayment(m) ?? false])) as Record<PaymentMethodName, boolean> };
    const held = this.hold.heldPaymentMethods(live.stored.id) ?? [];
    const methods = Object.fromEntries(PAYMENT_METHODS.map(m => [m, held.includes(m) && (link?.paymentEnabled(m) ?? false)])) as Record<PaymentMethodName, boolean>;
    return { files: true, payments: Object.values(methods).some(Boolean), methods, calls: false, services: false };
  }

  /** State changes arrive in bursts; the UI gets one snapshot per tick. */
  private emitState(delayMs = 50): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.events.onState(this.getState());
    }, delayMs);
  }
}
