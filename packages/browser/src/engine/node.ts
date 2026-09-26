import { UsdtWallet, usdtMode } from "./paymentAdapters/usdtWallet";
import { iceServerProblem } from "../shared/ice";
import type { UsdtPrepared } from "./paymentAdapters/usdt";
import { ArkWallet, arkMode } from "./paymentAdapters/arkWallet";
import { BARK_MAINNET_UNAVAILABLE, BarkWallet, barkDefaults, barkMode } from "./paymentAdapters/barkWallet";
import { FEDIMINT_MAINNET, FEDIMINT_MAINNET_UNAVAILABLE, FedimintWallet } from "./paymentAdapters/fedimintWallet";
import { FedimintAdapter, type FedimintPrepared } from "./paymentAdapters/fedimint";
import { loadFedimintSdk, type FedimintSdk } from "./paymentAdapters/fedimintSdk";
import type { BarkPrepared } from "./paymentAdapters/bark";
import { SparkWallet, sparkMode, sparkNetworkFor } from "./paymentAdapters/sparkWallet";
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
import { setOwnDidSource } from '../proofs/providers/did';
import { ProfileDid } from './did';
import { NostrSocial, effectiveNostrSettings } from './nostrSocial';
import { PublicProfiles, type ProfileSubject } from './publicProfiles';
import { normalizeNostrRelays } from '../nostr/relay';
import type { NostrDraft, NostrDraftRequest, NostrLookupRequest, NostrLookupResult, NostrPublishResult } from '../nostr/types';
import { readPubkyProof } from '../proofs/storage';
import { lookupPublicProfile, currentProfileProof, PROFILE_RETRY, PROFILE_TTL, type ProfileChoice } from '../profiles/public';
import { TEST_USDT_FAUCET_AMOUNT, receivedTimestamp, WALLET_NETWORKS, walletNetworkOf, type GroupMention, type PaymentNetworks, type PaymentReview, type PaymentTarget, type WalletNetwork } from "@ghostly/core";
import { ModeChanged, networkLabel, WrongNetworkError } from "./paymentAdapters/modeGate";
import { assertConfirmedReal, createTiming, SPARK_MAINNET_NOT_YET, WALLET_NAMES, createFailure, crossNetwork, paymentNetwork, paymentNetworksOf, walletInstances } from "./paymentAdapters/walletInstances";
import { migrateWalletNetworks } from "./paymentAdapters/walletNetworks";
import { perNetwork, type PerNetwork } from "./paymentAdapters/perNetwork";
import { CapsExchange, DHT_TEXT_CAPABILITY, HOLD_CAPABILITY, TRANSPORTS, automaticTransport, capsDescriptors, dialDescriptors, type CapsContent, type CapsRecord, type PairingCredentials } from "@ghostly/core";
import { fileMessageText, parseLinkPreview, pairedMessageFrame, type LinkPreview, type PaymentRequest, type PaymentAsk, type Payment, type PaymentResult, HOLD_LIMITS, MAX_DHT_TEXT_BYTES, normalizeRelayUrl, sanitizeAvatar, PeerProofs, emptyProofLedger, emptyIdentityLedger, receivedIdentityStatus, type ProofChallenge, type ProofEvidence, type ProofAdapter, type ProofScope, type PaymentMethodName } from "@ghostly/core";
import {
  DEFAULT_RELAYS,
  currentRelays,
  GhostLink,
  utf8Encode,
  type IncomingMessage,
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
  inviteOwnership,
  OwnInviteError,
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
import { FileDesk } from "./fileDesk";
import { DEFAULT_MINTS, TEST_MINT, mintNetwork } from "../shared/mints";
import type {
  EngineState,
  GroupEdgeView,
  FileTransferView,
  LinkView,
  MessageDetails,
  MessageDetailsView,
  MessageFile,
  MessageSend,
  GroupView,
  Settings,
  SettingsPatch,
  StoredLink,
  StoredMessage,
  StoredService,
  NetworkWalletsView,
  WalletAwaitingView,
  WalletCreate,
  WalletRemove,
  WalletTestCoins,
  TestCoinsResult,
  WalletInstanceView,
  WalletOffer,
  WalletTx,
  WalletType,
  WalletView,
} from "../shared/types";
import { WALLET_TYPES } from "../shared/types";
import { removalRisksFunds, walletRemoval } from "../shared/walletRemoval";
import { walletAwaiting } from "./walletAwaiting";
import type { WalletRemoval } from "../shared/walletRemoval";
import { TEST_COINS_SATS, faucetError } from "./paymentAdapters/testCoins";
import { composeDetails, fileWire, pathSnapshot, withSend, type PathSnapshot } from "./messageDetails";
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
import { DEFAULT_HYPERDHT_RELAY, hyperdhtRelayProblem } from "../shared/hyperdhtRelay";
import { traceJoin } from "./joinTrace";
import { DEFAULT_IROH_RELAYS, createIrohWebEndpoint, irohRelayProblem } from "../platform/irohWeb";

/** How long a chat waits before listening again after its HyperDHT relay went away. */
const RELAY_RETRY_MS = 30_000;

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
  /** A group's entry session whose admission is done: it closes once its data link does (`GroupsHost.entryDone`). */
  entryDone?: boolean;
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
    // files/3 transfers count in the file desk, which knows which were taken without asking.
    if (file.wire3) continue;
    if (file.direction === "in" || (legacy && fromPeer.has(file.id))) result.receivedBytes += storedSize(file);
  }
  return result;
}

interface SpareInvite { mine: LinkParams; inviteKey: ReturnType<typeof identityFromSeedB64>; inviteCode: string; madeAt: number }
/** A spare invite is warmed again this often while it waits, and handed out only between these ages. */
const SPARE_INVITE_WARM_EVERY_MS = 4 * 60_000;
export const SPARE_INVITE_MIN_AGE_MS = 6_000;
const SPARE_INVITE_MAX_AGE_MS = 15 * 60_000;

/** How long a removal waits for a wallet's rail to claim what was already paid to it (tests shorten it). */
export const removalTiming = { claimMs: 30_000 };

/** Why a removal needs the person's confirmation: what it holds, what it still waits for, and what confirming means. */
function lossRefusal(label: string, removal: WalletRemoval): string {
  const { held, awaiting } = removal;
  const holds = held === "unknown" ? `Ghostly could not read what the ${label} wallet holds.` : held.empty ? "" : `The ${label} wallet holds ${held.text}.`;
  const listed = awaiting.slice(0, 3).map((i) => i.text.charAt(0).toLowerCase() + i.text.slice(1)).join("; ") + (awaiting.length > 3 ? `; and ${awaiting.length - 3} more` : "");
  const waits = awaiting.length ? `${holds ? " It" : `The ${label} wallet`} still waits for money: ${listed}.` : "";
  const lost = holds && awaiting.length
    ? `${held === "unknown" ? "anything in it becomes" : "they become"} unreachable without its backup, and that what is paid to it afterwards is lost,`
    : holds ? `${held === "unknown" ? "anything in it becomes" : "they become"} unreachable without its backup`
    : "what is paid to it after it is removed is lost";
  return `${holds}${waits} Confirm that ${lost} to remove it.`;
}

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
  /**
   * The native transports this app runs itself (the Desktop: Iroh and HyperDHT over its sidecars). Default: a
   * browser's, which is HyperDHT through the relay in `Settings.hyperdhtRelay`, when one is set.
   */
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
  private feedback(type: AttentionEvent["type"], id: string, linkId?: string, mention = false) {
    const key = type + ":" + id;
    if (this.feedbackIds.has(key)) return;
    this.feedbackIds.add(key);
    this.events.onAttention?.({type, id:key, at:Date.now(), ...(linkId ? {linkId} : {}), ...(mention ? {mention:true} : {})});
  }
  private messageFeedback(type: "message" | "sent", message: StoredMessage) {
    if (message.timestamp < this.feedbackStartedAt || message.file || message.paymentId || /^👋 (?:.+ )?joined$/.test(message.text)) return;
    this.feedback(type, message.linkId + ":" + message.id, message.linkId, type === "message" && !!message.mentioned);
  }
  /** The next chat's keys, warmed on the network ahead of time (`takeInvite`). */
  private spare: SpareInvite | null = null;
  private spareTimer: ReturnType<typeof setTimeout> | null = null;
  /** Keys this engine warmed with an empty packet, and when. */
  private readonly warmedKeys = new Map<string, number>();
  private readonly outboxes = new Map<string, Outbox>();
  private readonly requestCounts = new Map<string, number>();
  private readonly transfers = new Map<string, FileTransferView>();
  /** files/3 in every chat: offers, resumable transfers, checked by digest (WISP 501 rev 0.3). */
  private readonly fileDesk = new FileDesk({
    send: (linkId, frame) => this.links.get(linkId)?.link?.sendFilesFrame(frame) ?? false,
    receivedBytes: (linkId) => this.links.get(linkId)?.files.receivedBytes ?? 0,
    wireIds: (linkId) => this.links.get(linkId)?.files.wireIds,
    deleted: (linkId, messageId) => !!this.links.get(linkId)?.stored.deletedIds?.includes(messageId),
    storeMessage: (message) => this.storeMessage(message),
    transfers: this.transfers,
    changed: (delayMs) => this.emitState(delayMs),
    settled: (linkId, fileId, record) => void this.noteFileEnd(linkId, fileId, record.state === "done" ? undefined : record.error ?? record.state),
  });
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private paymentTimer:ReturnType<typeof setTimeout>|null=null;
  /** Group links: admins read knocks, joiners knock (WISP 9xx § Entry link). */
  private groupEntryTimer: ReturnType<typeof setInterval> | null = null;
  private walletView: WalletView = { mints: [], balance: 0, history: [], feesPaid: 0 };

  /**
   * Every wallet twice, one per network (real money, test coins), both open at once. Nothing is parked: a payment
   * goes through the wallet of its own network, and a wallet of one network never pays for the other.
   */
  private readonly usdtWallets = perNetwork((network) => new UsdtWallet(network, () => { void this.refreshWallet(); void this.desk.reconcileUsdtReceipts().catch(()=>{}); }));
  private readonly arkWallets = perNetwork((network) => new ArkWallet(network, () => { void this.refreshWallet(); void this.desk.reconcileArkReceipts().catch(()=>{}); }));
  private readonly barkWallets = perNetwork((network) => new BarkWallet(network, () => { void this.refreshWallet(); void this.desk.reconcileBarkReceipts().catch(()=>{}); }));
  private readonly fedimintWallets = perNetwork((network) => new FedimintWallet(network, {
    changed: () => void this.refreshWallet(),
    // An invoice of a chat request was paid into the federation: the request is paid.
    received: (paymentId) => void this.desk.onLightningPaid({ paymentId }),
  }, () => (this.options.fedimintSdk ?? loadFedimintSdk)()));
  private readonly sparkWallets = perNetwork((network) => new SparkWallet(network, () => { void this.refreshWallet(); void this.desk.reconcileSparkReceipts().catch(()=>{}); }));
  /** What a call naming no network acts on (a caller from before wallets had their own): Mainnet. */
  private net(network?: WalletNetwork): WalletNetwork { return network === "testnet" ? "testnet" : "mainnet"; }
  /** The Fedimint wallet that joined this federation, whichever network it is on. */
  private fedimintOf(federation: string | undefined): FedimintWallet | undefined { return federation ? WALLET_NETWORKS.map((n) => this.fedimintWallets[n]).find((w) => w.federation(federation)) : undefined; }
  /**
   * Every way of paying through the wallet of the payment's own network: the target's chain says which. A
   * network with no wallet refuses, so a test wallet never settles a request for real money.
   */
  private readonly paymentCoordinator = new PaymentCoordinator(intentRepository, [{
    method:"usdt",
    prepare:(target,amount,feeCap)=>this.onNetworkOf(this.usdtWallets,"USDT",target).require().prepare(target,amount,feeCap),
    execute:(review,prepared,persist)=>this.onNetworkOf(this.usdtWallets,"USDT",review).require().execute(review,prepared as UsdtPrepared,persist),
    reconcile:(review,prepared)=>this.onNetworkOf(this.usdtWallets,"USDT",review).require().reconcile(review,prepared as UsdtPrepared),
  }, {
    method: "arkade",
    prepare: (target, amount, feeCap) => this.onNetworkOf(this.arkWallets,"Ark",target).require().prepare(target, amount, feeCap),
    execute: (review, prepared, persist) => this.onNetworkOf(this.arkWallets,"Ark",review).require().execute(review, prepared as ArkPrepared, persist),
    reconcile: (review, prepared,persist) => this.onNetworkOf(this.arkWallets,"Ark",review).require().reconcile(review, prepared as ArkPrepared,persist),
  }, {
    method: "bark",
    prepare: (target, amount, feeCap) => this.onNetworkOf(this.barkWallets,"Bark",target).require().prepare(target, amount, feeCap),
    execute: (review, prepared, persist) => this.onNetworkOf(this.barkWallets,"Bark",review).require().execute(review, prepared as BarkPrepared, persist),
    reconcile: (review, prepared) => this.onNetworkOf(this.barkWallets,"Bark",review).require().reconcile(review, prepared as BarkPrepared),
  }, {
    method: "spark",
    prepare: (target, amount, feeCap) => this.onNetworkOf(this.sparkWallets,"Spark",target).require().prepare(target, amount, feeCap),
    execute: (review, prepared, persist) => this.onNetworkOf(this.sparkWallets,"Spark",review).require().execute(review, prepared as SparkPrepared, persist),
    reconcile: (review, prepared) => this.onNetworkOf(this.sparkWallets,"Spark",review).require().reconcile(review, prepared as SparkPrepared),
  }, {
    method:"bitcoin",
    prepare:(target,amount,feeCap)=>this.bitcoins[walletNetworkOf(target.network)].adapter.prepare(target,amount,feeCap),
    execute:(review,prepared,persist)=>this.bitcoins[walletNetworkOf(review.network)].adapter.execute(review,prepared as BitcoinPrepared,persist),
    reconcile:(review,prepared,persist)=>this.bitcoins[walletNetworkOf(review.network)].adapter.reconcile(review,prepared as BitcoinPrepared,persist),
    release:(review,prepared)=>this.bitcoins[walletNetworkOf(review.network)].adapter.release!(review,prepared as BitcoinPrepared),
  }, {
    method:"fedimint",
    prepare:(target,amount,feeCap)=>new FedimintAdapter(this.fedimintWallets[walletNetworkOf(target.network)],this.desk.fedimintPublisher).prepare(target,amount,feeCap),
    execute:(review,prepared,persist)=>new FedimintAdapter(this.fedimintWallets[walletNetworkOf(review.network)],this.desk.fedimintPublisher).execute(review,prepared as FedimintPrepared,persist),
    reconcile:(review)=>new FedimintAdapter(this.fedimintWallets[walletNetworkOf(review.network)],this.desk.fedimintPublisher).reconcile(review),
  }, {
    method:"cashu",
    prepare:(target,amount,feeCap)=>new CashuAdapter(this.wallet,(r,t)=>this.desk.recordCashu(r,t)).prepare(target,amount,feeCap),
    execute:(review,prepared,persist)=>new CashuAdapter(this.wallet,(r,t)=>this.desk.recordCashu(r,t)).execute(review,prepared as CashuPrepared,persist),
    reconcile:(review,prepared)=>new CashuAdapter(this.wallet,(r,t)=>this.desk.recordCashu(r,t)).reconcile(review,prepared as CashuPrepared),
  }], (review) => {
    if (review.state === "settled") this.feedback("confirmed", review.id);
    void this.refreshWallet();
  });
  /**
   * The wallet of a payment's network, or a refusal naming what is missing: "no Testnet Ark wallet". The chain of
   * the target (or of the review, which is its target) decides; nothing else can.
   */
  private onNetworkOf<W>(wallets: PerNetwork<W>, rail: string, target: { network: string }): W {
    const network = walletNetworkOf(target.network), wallet = wallets[network] as W & { configured?: boolean };
    if (wallet.configured === false) throw new Error(`This is a ${networkLabel(network)} payment, and you have no ${networkLabel(network)} ${rail} wallet: create one in Wallet → New`);
    return wallet;
  }
  /** One network's Cashu mints, primary first (the network the legacy page shows when none is named). */
  private networkMints(network?: WalletNetwork): string[] {
    const wanted = this.net(network);
    return this.settings.mints.filter((mint) => mintNetwork(mint) === wanted);
  }
  private readonly wallet = new CashuWallet((network) => this.networkMints(network), {
    onChange: () => void this.refreshWallet(),
    // The mints settle their own invoices and payments; the Lightning journal learns it from here.
    onQuotePaid: (quote) => void this.lightnings[mintNetwork(quote.mint)].reportInvoicePaid(quote.invoice, { paymentId: quote.paymentId, mint: quote.mint }),
    onMeltResolved: (melt, paid) => void this.lightnings[mintNetwork(melt.mint)].reportPaymentResolved(melt.request, paid, { paymentId: melt.paymentId, mint: melt.mint }),
    onTestMintNeeded: async (mint) => void (await this.walletAddMint({ url: mint })),
  }, () => this.settings.mints);
  private registry?: ProviderRegistry;
  private providers() { return this.registry ??= this.options.providers ?? defaultRegistry(); }
  /** A plugin registered or left after start: the pickers show the new list. */
  private stopWatchingAdapters?: () => void;
  /** Read when a source connects, once the constructor has run. */
  private readonly providerHost = (network: WalletNetwork) => ({ platform: this.options.platform ?? "web" as const, cashu: this.wallet, fedimint: this.fedimintWallets[network], invoke: this.options.invoke });
  /** Lightning of each network, through its active source: the Cashu mints unless the person chose another. */
  private readonly lightnings: PerNetwork<LightningService> = perNetwork((network) => new LightningService(network, () => this.providers().lightning, () => this.providerHost(network), {
    changed: () => void this.refreshWallet(),
    received: (op) => void this.desk.onLightningPaid(op),
    resolved: (op, paid) => void this.desk.onLightningResolved(op, paid),
  }, CASHU_MINT_SOURCE));
  /** On-chain Bitcoin of each network, through its active source: none until the person sets one up. */
  private readonly bitcoins: PerNetwork<BitcoinService> = perNetwork((network) => new BitcoinService(network, () => this.providers().onchain, () => this.providerHost(network), () => { void this.refreshWallet(); void this.desk.reconcileBitcoinReceipts().catch(()=>{}); }));
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
    acceptsNetwork: (linkId, method, network) => this.acceptsNetwork(this.links.get(linkId)?.stored, method, network),
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
      this.awaitingSoon();
      this.emitState();
    },
    defaultNetwork: () => "mainnet",
  }, this.arkWallets, this.usdtWallets, this.barkWallets, perNetwork((network) => ({
    createInvoice: (amount: number, paymentId: string) => this.lightnings[network].createInvoice(amount, { paymentId }),
    quote: async (invoice: string) => { const quote = await this.lightnings[network].quote(invoice); return { ...quote, mint: quote.source === CASHU_MINT_SOURCE ? quote.mint : undefined }; },
    pay: (quote: { quote: string }, note: string, paymentId: string) => this.lightnings[network].pay(quote.quote, { note, paymentId }),
    // "I paid": the source, the mints and the federations are asked now; the request is paid only once one of them saw it.
    // A test mint's invoice waits for that word (StoredQuote `held`): the one the contact says it paid is let go.
    check: async (paid?: string) => { await Promise.all([this.lightnings[network].reconcile(), paid ? this.wallet.vouch(paid) : this.wallet.checkQuotes(), this.fedimintWallets[network].checkReceives()]); },
  })), this.bitcoins, this.fedimintWallets, perNetwork((network) => ({
    ready: () => !!this.sparkWallets[network].adapter,
    requestTarget: (amount: number, memo?: string) => this.sparkWallets[network].target(amount, memo),
    received: (target: PaymentTarget, amount: number, since: number, claimed: ReadonlySet<string>) => {
      const adapter = this.sparkWallets[network].adapter;
      return adapter && target.network === adapter.network ? adapter.received(target.address, amount, since, claimed) : Promise.resolve(undefined);
    },
    sync: async () => { await this.sparkWallets[network].adapter?.sync(); },
  })));

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
      await this.noteHold(linkId, messageId, state, error);
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
    receiveText: (linkId, message, held) => this.storeMessage({ linkId, id: `peer_${message.id}`, text: message.text, sender: "peer", timestamp: message.timestamp, via: "hold",
      details: { wire: { frame: "GHLD bundle", protocol: "hold/1", plaintextBytes: utf8Encode(message.text).length, ...(held && { wireBytes: held.bytes }) }, ...(held && { hold: held }) } }),
    receiveFile: async (linkId, wire, bytes, digest, held) => {
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
      await this.storeMessage({ linkId, id: `peer_${wire.wireId}`, text: fileMessageText(file), sender: "peer", timestamp: wire.timestamp, via: "hold", file,
        details: { wire: { frame: "GHLD bundle", protocol: "hold/1", plaintextBytes: wire.size, ...(held && { wireBytes: held.bytes }) }, ...(held && { hold: held }), completedAt: Date.now() } });
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
    emit: () => { this.emitState(); this.did.changed(); void this.publicProfiles.prune().catch(() => {}); },
    publicProfile: (provider, subject) => this.publicProfiles.view({ provider, subject }),
    publish: (seed, records) => this.transport.publish(identityFromSeed(seed), records),
    resolve: async key => (await this.transport.resolve(key))?.records ?? null,
  });

  /** The profile's did:dht: a key of its own, public, never tied to a chat (WISP 3xx-did-dht). */
  readonly did = new ProfileDid({
    online: () => this.settings.online,
    emit: () => this.emitState(),
    listable: () => {
      const now = Date.now() / 1000;
      return new Map(this.identities.views().filter(v => v.publicUri && v.expiresAt > now).map(v => [v.id, v.publicUri!]));
    },
    proofIds: () => this.identities.views().map(v => v.id),
    publish: (pubKeyZ32, payload) => {
      if (!this.transport.publishPayload) throw new Error("This app cannot publish a DID");
      // Background: the DID can wait for a chat's signaling.
      return this.transport.publishPayload(pubKeyZ32, payload, { background: true });
    },
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

  /** Public profiles of verified identities, read when their cards are on screen (PUBLIC-PROFILES.md). */
  private readonly publicProfiles = new PublicProfiles({
    enabled: () => this.settings.publicProfiles !== false,
    online: () => this.settings.online,
    emit: () => this.emitState(),
    eligible: () => this.profileSubjects(),
    nostrRelays: () => effectiveNostrSettings(this.settings.nostr).relays,
  });

  /** Every identity whose public profile may be shown: the profile's own current proofs, and what contacts shared that verifies now. */
  private profileSubjects(): ProfileSubject[] {
    const t = Math.floor(Date.now() / 1000);
    const out: ProfileSubject[] = this.identities.views().filter(p => p.expiresAt > t).map(p => ({ provider: p.provider, subject: p.verified.subject }));
    for (const live of this.links.values()) {
      const stored = live.stored;
      if (!stored.profile || !stored.identities || stored.group) continue;
      const mine = stored.participationSeed ? identityFromSeedB64(stored.participationSeed).pubKeyZ32 : undefined;
      for (const r of stored.identities.received)
        if (receivedIdentityStatus(r, stored.pairedPeerKey, mine, t) === "verified") out.push({ provider: r.binding.provider, subject: r.verified.subject });
    }
    return out;
  }

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
    closeEdge: linkId => this.closeGroupLink(linkId),
    entryDone: linkId => {
      const live = this.links.get(linkId);
      if (!live?.stored.groupEntry) return;
      if (live.dataLink === "open") live.entryDone = true;
      else void this.closeGroupLink(linkId).catch(() => {});
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
    // A relay that trips or recovers shows in the connection panel's Details.
    this.transport.subscribe?.(() => this.emitState());
  }

  /** The Desktop reaches the DHT itself: the relays in Settings are written to, and read from only when the person chose so. */
  private configureDirect(): void {
    this.transport.configure?.({ relays: this.settings.relays, readRelays: this.settings.readRelays === true });
  }

  /**
   * What each network's wallets still wait for (see `walletAwaiting`): open requests and invoices, paid invoices not
   * claimed yet, ecash sent and not taken. Read from the Cashu quotes, the Lightning journals and the payments.
   */
  private async readAwaiting(): Promise<Record<WalletNetwork, WalletAwaitingView[]>> {
    const quotes = await this.wallet.quotes(), payments = this.desk.records(), now = Date.now();
    const out = {} as Record<WalletNetwork, WalletAwaitingView[]>;
    for (const network of WALLET_NETWORKS) {
      const lightning = this.lightnings[network];
      out[network] = walletAwaiting({ network, mints: this.networkMints(network), quotes, lightningOps: await lightning.list(), lightningSource: lightning.view.providerId, payments, now });
    }
    return out;
  }

  private awaitingTimer?: ReturnType<typeof setTimeout>;
  /** A payment changed (a request made, paid or closed): what the wallets wait for is read again, soon. */
  private awaitingSoon(): void {
    if (this.shuttingDown || !this.walletView.networks) return;
    clearTimeout(this.awaitingTimer);
    this.awaitingTimer = setTimeout(() => void this.readAwaiting().then((awaiting) => {
      const networks = this.walletView.networks;
      if (this.shuttingDown || !networks) return;
      for (const network of WALLET_NETWORKS) networks[network] = { ...networks[network], awaiting: awaiting[network] };
      this.walletView = { ...this.walletView, networks: { ...networks } };
      this.emitState();
    }).catch(() => {}), 250);
  }

  private async refreshWallet(): Promise<void> {
    const networks = {} as Record<WalletNetwork, NetworkWalletsView>;
    let everything: WalletTx[] = [];
    const awaiting = await this.readAwaiting();
    for (const network of WALLET_NETWORKS) {
      const view = await this.wallet.view(network);
      everything = view.history;
      // A network's own story: test ecash is not mixed into the story of real money, nor the reverse.
      const history = view.history.filter((tx) => !tx.mint || mintNetwork(tx.mint) === network);
      networks[network] = { mints: view.mints, balance: view.balance, history, feesPaid: history.reduce((sum, tx) => sum + tx.fee, 0),
        ark: this.arkWallets[network].view, bark: this.barkWallets[network].view, fedimint: this.fedimintWallets[network].view, spark: this.sparkWallets[network].view,
        usdt: this.usdtWallets[network].view, lightning: this.lightnings[network].view, bitcoin: this.bitcoins[network].view, awaiting: awaiting[network] };
    }
    const wallets = walletInstances(networks);
    // The flat fields are Mainnet's, for a caller from before wallets had their own network; `networks` has both.
    this.walletView = { ...networks.mainnet, networks, wallets, offers: this.walletOffers(networks, wallets), intents: (await intentRepository.list()).map((saved) => saved.review) };
    this.announcePaymentNetworks(wallets);
    for (const tx of everything) {
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
        // Each through its own network's wallet, once that one is open.
        const network=walletNetworkOf(review.network);
        if(!["submitted","unknown"].includes(review.state) || (review.method==="arkade" && !this.arkWallets[network].adapter) || (review.method==="bark" && !this.barkWallets[network].adapter) || (review.method==="spark" && !this.sparkWallets[network].adapter) || (review.method==="usdt" && !this.usdtWallets[network].adapter) || (review.method==="bitcoin" && !this.bitcoins[network].sources.active) || (review.method==="fedimint" && !this.fedimintWallets[network].federation(review.provider)))continue;
        await this.reconcilePayment({id:review.id}).catch(()=>{});
      }
    } finally {if(!this.shuttingDown)this.paymentTimer=setTimeout(()=>void this.pollPaymentStatus(),10000);}
  }

  async start(): Promise<void> {
    // A new profile has no wallet until one is made (New, or the first-run setup): no mint is added by itself.
    this.settings = { ...DEFAULT_SETTINGS, ...(await db.getSettings()) };
    // A profile still on an old default list gets today's defaults: a relay added to them reaches everyone.
    this.settings.relays = currentRelays(this.settings.relays);
    this.relays?.setRelays(this.settings.relays);
    this.configureDirect();
    this.services = await db.getServices();
    await this.identities.load();
    this.identities.start();
    await this.did.load();
    // The DID provider refuses this profile's own did:dht as an external identity.
    setOwnDidSource(() => this.did.id);
    this.did.start();
    await this.nostrSocial.load();
    await this.publicProfiles.load();
    // Wallets stored the way they were before each had its own network take their network's key first. Nothing
    // is deleted: see walletNetworks.ts. The report names keys only.
    const migrated = await migrateWalletNetworks();
    if (migrated.moved.length || migrated.unreadable.length) console.info("[wallet] wallets moved to their network's key:", migrated.moved.map((m) => m.key).join(", ") || "none", migrated.unreadable.length ? `; left as they were: ${migrated.unreadable.join(", ")}` : "");
    for (const network of WALLET_NETWORKS) {
      await this.arkWallets[network].start();
      await this.barkWallets[network].start();
      await this.fedimintWallets[network].start();
      await this.sparkWallets[network].start();
      await this.usdtWallets[network].start();
      await this.lightnings[network].start();
      await this.bitcoins[network].start();
    }
    await this.desk.start();
    await this.refreshWallet();
    this.wallet.start();
    this.stopWatchingAdapters ??= onAdaptersChanged(() => { if (!this.shuttingDown) for (const network of WALLET_NETWORKS) { this.lightnings[network].refreshOffered(); this.bitcoins[network].refreshOffered(); } });

    const history = new Map<string, StoredMessage[]>();
    for (const stored of await db.getLinks()) {
      const messages = stored.group ? [] : await db.getMessages(stored.id);
      const storedFiles = stored.group ? [] : await fileStore.listForLink(stored.id);
      for (const file of storedFiles) if (file.transfer && !file.wire3) this.transfers.set(file.id,
        file.transfer.state === "transferring" ? { ...file.transfer, state: "failed", error: "Transfer interrupted. Retry when connected." } : file.transfer);
      // files/3 transfers go on where they stopped, once the chat is live again.
      if (!stored.group) this.fileDesk.restore(stored.id, storedFiles);
      const files = linkFilesFrom(stored.id, storedFiles, messages);
      this.links.set(stored.id, newLiveLink(stored, messages[messages.length - 1]?.timestamp ?? 0, files));
      history.set(stored.id, messages);
      if (stored.profile && !stored.group) await this.outboxFor(stored.id).recover();
    }
    // Groups know their edges from the links above, and may add or drop some before anything dials.
    await this.groups.load();
    // With the chats loaded, profiles of identities no longer verified can be told apart and dropped.
    this.publicProfiles.start();
    if (this.settings.online) for (const [linkId, messages] of history) {
      if (!this.links.has(linkId)) continue;
      this.startLink(linkId, messages);
      if (!this.links.get(linkId)?.stored.group) void this.refreshPublicProfiles({ linkId }).catch(() => {});
    }
    this.emitState();
    if (this.settings.online) { this.hold.start(); this.startGroupEntries(); this.prepareSpare(); }
    void this.pollPaymentStatus().catch(()=>{});
    // Federations joined before: opened (and the notes a contact sent that an interruption left unredeemed, redeemed).
    void Promise.all(WALLET_NETWORKS.map((n) => this.fedimintWallets[n].ensureReady())).then(() => this.desk.resumeFedimint());
    for (const network of WALLET_NETWORKS) {
      // The Lightning and Bitcoin sources the person set up (the Cashu mints need no network to connect).
      void this.lightnings[network].recover().then(() => this.lightnings[network].ensureReady());
      void this.bitcoins[network].ensureReady();
      this.openWallets(network);
    }
  }

  /** Opens the wallets of a network that exist. None is made here: wallets are made one at a time, with New. */
  private openWallets(network: WalletNetwork) {
    if (this.options.automaticWallets === false) return;
    void this.arkWallets[network].ensureReady();
    void this.barkWallets[network].ensureReady();
    void this.sparkWallets[network].ensureReady();
    void this.usdtWallets[network].ensureReady();
  }

  /** Tells every peer we are leaving. Best effort: the browser may already be closing. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.relayRetry) clearTimeout(this.relayRetry);
    if(this.paymentTimer)clearTimeout(this.paymentTimer);
    clearTimeout(this.awaitingTimer);
    if (this.spareTimer) clearTimeout(this.spareTimer);
    this.stopGroupEntries();
    this.stopWatchingAdapters?.();
    this.identities.stop();
    this.did.stop();
    this.nostrSocial.stop();
    this.publicProfiles.stop();
    for (const network of WALLET_NETWORKS) {
      await this.arkWallets[network].stop();
      await this.barkWallets[network].stop();
      await this.fedimintWallets[network].stop();
      await this.sparkWallets[network].stop();
      await this.usdtWallets[network].stop();
      await this.lightnings[network].stop();
      await this.bitcoins[network].stop();
    }
    await this.nativeQueue;
    await this.hold.stop();
    await Promise.allSettled([...this.outboxes.values()].map(outbox => outbox.stop()));
    await Promise.allSettled([...this.links.values()].map(async (live) => { await live.link?.stop(true); await live.caps?.stop(); }));
  }

  getState(): EngineState {
    const groups = this.groups.views();
    return {
      settings: this.settings,
      transport: {
        ...this.transport.describe(), ...(this.options.irohWeb ? { iroh: { relays: this.irohRelays, defaults: [...DEFAULT_IROH_RELAYS] } } : {}),
        ...(this.transport.configure && { direct: true }), ...(this.transport.discovery && { discovery: this.transport.discovery() }),
      },
      // Group edges are links the engine runs, not chats anyone sees.
      links: [...this.links.values()].filter((live) => !live.stored.group).map((live) => this.viewOf(live)).sort((a, b) => b.createdAt - a.createdAt),
      services: this.services
        .map((s) => ({ ...s, requests: this.requestCounts.get(s.id) ?? 0 }))
        .sort((a, b) => a.createdAt - b.createdAt),
      transfers: Object.fromEntries(this.transfers),
      wallet: this.walletView,
      payments: this.desk.views(),
      identityProofs: this.identities.views(),
      did: this.did.view(),
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
    const decoded = decodeInviteCode(inviteCode);
    if (!decoded) throw new Error("That does not look like a Ghostly invite");
    // DHT only is a choice made in a chat, not in its invite (WISP 400): a joined `pair2d/` code starts like any
    // other and upgrades by itself; the inviter's choice reaches this side in its envelopes.
    const { deliveryMode: _mode, ...params } = decoded;
    const existing = [...this.links.values()].find((l) => l.stored.seedB64 === params.seedB64);
    if (existing) {
      if (existing.stored.profile !== params.profile) throw new Error("Invitation profile does not match the stored link");
      return { linkId: existing.stored.id };
    }
    this.refuseOwnInvite(params);
    return { linkId: await this.addLink(params) };
  }

  /**
   * A profile never joins its own invite (WISP 801 Q9): the join would make a second chat, the joiner's
   * side of a link this profile already waits on. The inviter's own side arrives with its code or its
   * participation seed and is never a join. The spare invite counts too, though its code is not out yet.
   */
  private refuseOwnInvite(params: LinkParams): void {
    const own = inviteOwnership(params, [...this.links.values()].map((l) => l.stored));
    if (own.kind === "own") throw new OwnInviteError(own.link.id);
    if (this.spare && identityFromSeedB64(params.seedB64).pubKeyZ32 === this.spare.inviteKey.pubKeyZ32) throw new OwnInviteError(null);
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
    if (!inviteCode && !participationSeedB64) this.refuseOwnInvite(checked);
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
  setDidListed(params: { id: string; listed: boolean }): Promise<void> { return this.did.setListed(params); }
  lookupIdentityDisplay(params: { linkId: string; id: string }): Promise<void> {
    // A Nostr profile comes through the social layer, from the relays the person configured.
    const r = this.links.get(params.linkId)?.stored.identities?.received.find(x => x.id === params.id);
    if (r?.binding.provider === "nostr") return this.nostrSocial.loadContact({ linkId: params.linkId, subject: r.verified.subject, what: "profile" });
    return this.identities.lookupDisplay(params);
  }
  loadPublicProfile(params: { provider: string; subject: string; force?: boolean }): Promise<void> {
    return this.publicProfiles.request({ provider: String(params.provider), subject: String(params.subject), force: params.force === true });
  }
  nostrLoadContact(params: { linkId: string; subject: string; what: "profile" | "follows" | "notes"; more?: boolean }): Promise<void> { return this.nostrSocial.loadContact(params); }
  nostrForgetContact(params: { linkId: string; subject: string }): Promise<void> { return this.nostrSocial.forgetContact(params); }
  nostrLoadOwn(params: { subject: string }): Promise<void> { return this.nostrSocial.loadOwn(params); }
  nostrLookup(params: NostrLookupRequest): Promise<NostrLookupResult> { return this.nostrSocial.lookup(params); }
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
    this.fileDesk.drop(linkId);
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
    for (const [id, live] of this.links) live.link?.setChatActive(id === linkId);
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
    for (const network of WALLET_NETWORKS) { this.lightnings[network].sources.wake(); this.bitcoins[network].sources.wake(); }
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

  async sendMessage(params: { linkId: string; text: string; timestamp?: number; preview?: LinkPreview }): Promise<{ error: string | null; refused?: boolean }> {
    const { linkId, text } = params;
    const live = this.links.get(linkId);
    if (!live?.link) return { error: "You are offline" };
    const trimmed = text.trim();
    if (!trimmed) return { error: null };

    const timestamp = params.timestamp ?? Date.now();
    if (live.stored.profile) return this.sendChatText(live, trimmed, timestamp, params.preview === undefined ? undefined : parseLinkPreview(params.preview, trimmed));
    const via = live.link.isDataLinkOpen ? "datalink" : "pkarr";
    // What the DHT cannot carry is refused before it is kept: it must not show as sent.
    const bytes = new TextEncoder().encode(trimmed).length;
    if (!(live.link.isDataLinkOpen && trimmed.length <= LIMITS.maxChatMessageBytes / 4) && bytes > MAX_DHT_TEXT_BYTES)
      return { error: `Message too large for DHT (${bytes} bytes, max ${MAX_DHT_TEXT_BYTES}). Try a shorter message or share a link instead.`, refused: true };
    await this.storeMessage({ linkId, id: `me_${timestamp}`, text: trimmed, sender: "me", timestamp, via });
    const at = Date.now(), snapshot = pathSnapshot(live, via);
    const error = await live.link.sendMessage(trimmed, timestamp);
    await this.noteTextSend(linkId, { linkId, id: `me_${timestamp}`, text: trimmed, sender: "me", timestamp, via }, snapshot, at, error, live.link);
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
  private async sendChatText(live: LiveLink, trimmed: string, timestamp: number, preview?: LinkPreview): Promise<{ error: string | null; refused?: boolean }> {
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
        await this.storeMessage({ linkId, id, wireId, text: trimmed, sender: "me", timestamp, via: delivery === "dht" ? "pkarr" : "datalink", delivery: "sending", ...(preview && { preview }) });
        await this.outboxFor(linkId).transmit(id);
        // The durable row carries delivery errors and an explicit retry action.
        return { error: null };
      }
      if (/Payment tokens|does not match/.test(validationError)) return { error: validationError, refused: true };
    }
    if (this.holdingFor(live) && bytes <= HOLD_LIMITS.maxTextBytes) {
      // Longer than the DHT carries, and both sides allow held items: it waits in this device's storage, sealed for them.
      await this.storeMessage({ linkId, id, wireId, text: trimmed, sender: "me", timestamp, via: "hold", delivery: "sending", ...(preview && { preview }) });
      // The durable row carries the outcome; the promise only says whether it could start.
      void this.hold.hold(linkId, { kind: "text", id: wireId, messageId: id, bytes, timestamp }).catch(() => {});
      return { error: null };
    }
    const reason = delivery === "dht" && bytes <= DHT_TEXT_BYTES ? "Waits for the text before it to be confirmed."
      : delivery === "dht" ? `Longer than the ${DHT_TEXT_BYTES} bytes the DHT carries: it is sent when you are live.`
      : "Sent when your contact is reachable.";
    await this.storeMessage({ linkId, id, wireId, text: trimmed, sender: "me", timestamp, via: "datalink", delivery: "waiting", deliveryError: reason, ...(preview && { preview }) });
    await this.outboxFor(linkId).wait(id, reason);
    return { error: null };
  }

  /**
   * A chat stopped by a security rejection (a stream authenticated a participation key other than the pinned one):
   * nothing goes until the person acts. Another key on the DHT or the link's signals is ignored instead (WISP 400).
   */
  private chatStopped(live: LiveLink): string | null {
    if (live.pairing?.keyMismatch) return live.pairing.error ?? "This chat stopped: your contact's key changed.";
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
          if (delivery === "delivered") await this.noteDetails(linkId, id, details => ({ ...details, receiptAt: Date.now() }));
          const messages = await db.getMessages(linkId);
          if (delivery === "sent" || delivery === "delivered") {
            const message = messages.find(item => item.id === id);
            if (message) this.messageFeedback("sent", message);
          }
          this.events.onMessages(linkId, messages);
        },
      }, async message => {
        const live = this.links.get(linkId), link = live?.link;
        if (!link) return "You are offline. It is sent again once you are back.";
        // The path as it is when the message goes: the details keep it, whatever the session does after.
        const at = Date.now(), snapshot = pathSnapshot(live, message.via);
        const error = await link.sendMessage(message.text, message.timestamp, message.wireId, ...(message.preview ? [message.preview] : []));
        await this.noteTextSend(linkId, message, snapshot, at, error, link);
        return error;
      }, message => message.via === "pkarr" ? DHT_MESSAGE_TTL : 20_000, message => {
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
  /**
   * One message's details view (WISP 400 § Message details): the row and its record, the chat's public keys and
   * session, the file or payment it stands for. Nothing that opens the chat is in it.
   */
  async messageDetails({ linkId, messageId }: { linkId: string; messageId: string }): Promise<MessageDetailsView | null> {
    if (typeof linkId !== "string" || typeof messageId !== "string") throw new Error("Chat not found");
    const message = (await db.getMessages(linkId)).find(m => m.id === messageId);
    if (!message) return null;
    const live = this.links.get(linkId), stored = live?.stored;
    const group = linkId.startsWith("group:") ? (await db.getGroups()).find(g => g.id === linkId.slice("group:".length)) : undefined;
    const file = message.file ? await fileStore.get(message.file.id) : undefined;
    const payment = message.paymentId ? this.desk.views()[message.paymentId] : undefined;
    return composeDetails(message, {
      link: live && stored && {
        // A paired chat's sender key is its participation key; a compatibility chat's is its address on the DHT.
        stored, myKey: stored.participationSeed ? identityFromSeedB64(stored.participationSeed).pubKeyZ32 : live.myPubKeyZ32,
        verified: !!stored.pairedPeerKey && (stored.peerTrust ? stored.peerTrust.verifiedKey === stored.pairedPeerKey : true),
        transportNow: live.link?.isDataLinkOpen ? live.pairing?.transport : undefined, relayedNow: !!live.link?.relayedPath, rttNowMs: live.link?.rttMs,
      },
      file, payment, group: group && { id: group.id, profile: group.community ? "community" : "mesh" },
    });
  }

  /** Adds to a message's details record, whatever the row's delivery state. Nothing is pushed for it: the view asks. */
  private noteDetails(linkId: string, id: string, change: (details: MessageDetails, message: StoredMessage) => MessageDetails): Promise<void> {
    return db.patchMessage(linkId, id, message => ({ details: change(message.details ?? {}, message) })).then(() => {}, () => {});
  }

  /** One send of a text on its details: the path, the frame and its size, and the DHT envelope when that was the way. */
  private noteTextSend(linkId: string, message: StoredMessage, snapshot: PathSnapshot, at: number, error: string | null, link: GhostLink): Promise<void> {
    const plaintextBytes = utf8Encode(message.text).length;
    const send: MessageSend = { at, ...snapshot, result: error ? "failed" : "sent", ...(error && { error }) };
    const published = snapshot.path === "dht" ? link.dhtDelivery?.lastPublished : undefined;
    const dht = published && published.id === message.wireId ? published : undefined;
    const wire: MessageDetails["wire"] = snapshot.path === "dht" ? { frame: "_dm envelope", protocol: "dht-text/1", plaintextBytes, ...(dht && { wireBytes: dht.packetBytes }) }
      : snapshot.path === "legacy-dht" ? { frame: "_msgs record", protocol: "legacy/1", plaintextBytes }
      : snapshot.path === "legacy-datalink" ? { frame: "m", protocol: "legacy/1", plaintextBytes }
      : { frame: "paired-message", protocol: "chat/1", plaintextBytes, wireBytes: utf8Encode(pairedMessageFrame(message.wireId ?? "", message.timestamp, message.text, message.preview)).length };
    return this.noteDetails(linkId, message.id, details => ({ ...withSend(details, send), ...(!error && { sentAt: at, wire }),
      ...(dht && { dht: { seq: dht.seq, issued: dht.issued, expires: dht.expires, packetBytes: dht.packetBytes, nonce: dht.nonce, recordKey: dht.recordKey, records: dht.records } }) }));
  }

  /** A received text's frame, and the envelope it came in when the DHT floor carried it. */
  private static receivedTextDetails(paired: boolean, message: IncomingMessage): MessageDetails {
    const plaintextBytes = utf8Encode(message.text).length;
    if (message.via === "pkarr") {
      const p = message.packet, batch = message.batch;
      if (paired) return { wire: { frame: "_dm envelope", protocol: "dht-text/1", plaintextBytes, ...(p && { wireBytes: p.packetBytes }) },
        ...(p && { dht: { seq: p.seq, issued: p.issued, expires: p.expires, packetBytes: p.packetBytes, nonce: p.nonce, recordKey: p.recordKey, records: p.records } }) };
      return { wire: { frame: "_msgs record", protocol: "legacy/1", plaintextBytes, ...(batch && { wireBytes: batch.encryptedPayloadLength }) },
        ...(batch && { dht: { issued: batch.packetTimestamp, records: batch.rawRecordNames } }) };
    }
    if (!paired) return { wire: { frame: "m", protocol: "legacy/1", plaintextBytes } };
    return { wire: { frame: "paired-message", protocol: "chat/1", plaintextBytes, wireBytes: utf8Encode(pairedMessageFrame(message.id ?? "", message.timestamp, message.text, message.preview)).length } };
  }

  /** A held item's fate, on its message: stored for the contact (with the item's place in the mailbox), failed, or picked up. */
  private noteHold(linkId: string, messageId: string, state: "sending" | "held" | "delivered" | "failed", error?: string): Promise<void> {
    const now = Date.now(), entry = this.links.get(linkId)?.stored.hold?.outbox.find(e => e.messageId === messageId);
    const facts = entry && { seq: entry.seq, bytes: entry.bytes, expires: entry.expires };
    if (state === "held") return this.noteDetails(linkId, messageId, details => ({ ...withSend(details, { at: now, path: "hold", result: "sent" }), heldAt: now, sentAt: now,
      wire: { ...details.wire, frame: "GHLD bundle", protocol: "hold/1", ...(facts?.bytes && { wireBytes: facts.bytes }) }, ...(facts && { hold: facts }) }));
    if (state === "failed") return this.noteDetails(linkId, messageId, details => withSend(details, { at: now, path: "hold", result: "failed", ...(error && { error }) }));
    if (state === "delivered") return this.noteDetails(linkId, messageId, details => ({ ...details, receiptAt: now }));
    return Promise.resolve();
  }

  /** A file transfer ended: when, on the message that carries the file. */
  private async noteFileEnd(linkId: string, fileId: string, error?: string): Promise<void> {
    const message = (await db.getMessages(linkId)).find(m => m.file?.id === fileId);
    if (!message) return;
    const now = Date.now();
    await this.noteDetails(linkId, message.id, details => error
      ? (message.sender === "me" && details.sends?.length ? { ...details, sends: details.sends.map((s, i) => i === details.sends!.length - 1 ? { ...s, result: "failed", error } : s) } : details)
      : { ...details, completedAt: now, ...(message.sender === "me" && { receiptAt: now }) });
  }

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
        if (stored && !stored.wire3 && (stored.direction === "in" || (!stored.direction && message.sender === "peer"))) {
          live.files.receivedBytes = Math.max(0, live.files.receivedBytes - storedSize(stored));
        }
        // A files/3 transfer still going ends on both sides.
        this.fileDesk.forget(linkId, message.file.id);
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
    // A file too large to hold waits for the chat to be live instead, like one sent where nothing holds it.
    const holdable = file.size <= HOLD_LIMITS.maxBundleBytes - 4096;
    if (!GhostlyNode.takesFiles(live.link) && this.holdingFor(live) && holdable) {
      // The contact is away: the file waits in this device's storage, sealed for them.
      live.files.wireIds.add(wireId);
      this.transfers.set(file.id, { state: "transferring", transferred: 0, size: file.size });
      void this.storeMessage({ linkId, id: `me_${timestamp}`, text: fileMessageText(file), sender: "me", timestamp, via: "hold", delivery: "sending", file })
        .then(() => this.hold.hold(linkId, { kind: "file", id: wireId, messageId: `me_${timestamp}`, ref: file.id, bytes: file.size, timestamp })).catch(() => {});
      return;
    }
    if (!GhostlyNode.takesFiles(live.link) && live.stored.profile && !live.link.isDataLinkOpen) {
      // Not live and nothing holds it: it waits here, with a cancel, and goes when the chat is live (WISP 500).
      if (this.chatStopped(live)) return fail(this.chatStopped(live)!);
      live.files.wireIds.add(wireId);
      void this.storeMessage({ linkId, id: `me_${timestamp}`, text: fileMessageText(file), sender: "me", timestamp, via: "datalink", file,
        delivery: "waiting", deliveryError: "Sent when you are live." });
      return;
    }
    if (!GhostlyNode.takesFiles(live.link)) return fail("Connect to an updated peer to send files");
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

  /**
   * The file of a stored message goes over the open session: offered with files/3 when both sides agree it,
   * else whole with files/2, which takes up to 100 MB.
   */
  private transferFile(live: LiveLink, file: MessageFile, wireId: string, timestamp: number, fail: (error: string) => void): void {
    const { link } = live;
    if (!link) return fail("You are offline");
    this.transfers.set(file.id, { state: "transferring", transferred: 0, size: file.size });
    void (async () => {
      const large = await GhostlyNode.largeFilesAgreed(link), at = Date.now();
      await this.noteDetails(live.stored.id, `me_${timestamp}`, details => ({ ...withSend(details, { at, ...pathSnapshot(live, "datalink"), result: "sent" }), sentAt: at, wire: fileWire(large ? "files/3" : "files/2", file.size) }));
      if (large) {
        await this.fileDesk.offer(live.stored.id, file, wireId, timestamp);
        return;
      }
      if (file.size > LIMITS.maxFileBytes) {
        return fail(`Your contact's app takes files up to ${Math.round(LIMITS.maxFileBytes / 1024 / 1024)} MB. Larger ones need an updated Ghostly on their side.`);
      }
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

  fileAction({ linkId, fileId, action }: { linkId: string; fileId: string; action: "accept" | "decline" | "pause" | "resume" | "cancel" }): void {
    if (!this.links.get(linkId)) throw new Error("No such chat");
    if (!["accept", "decline", "pause", "resume", "cancel"].includes(action)) throw new Error("Unknown file action");
    this.fileDesk.act(linkId, fileId, action);
  }

  /** The contact can take a file on the open session: files/2 or files/3. */
  private static takesFiles(link: GhostLink): boolean { return link.supportsFiles || !!link.supportsLargeFiles; }

  /**
   * Whether both sides take files/3 on the open session. A session that just opened has not heard the
   * contact's capabilities yet: they come in the first second, so this waits for them a little.
   */
  private static async largeFilesAgreed(link: GhostLink): Promise<boolean> {
    for (let waited = 0; waited < 4_000 && link.isDataLinkOpen && !link.supportsLargeFiles && link.sessionOffers?.peer === null; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return link.supportsLargeFiles;
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
        if (!GhostlyNode.takesFiles(live.link)) { await db.updateDelivery(linkId, message.id, "failed", "Your contact's app cannot receive files."); continue; }
        const file = message.file, wireId = file.id.slice(`${linkId}-out-`.length);
        await db.putMessage(sentNow(message));
        this.transferFile(live, file, wireId, message.timestamp, error => {
          this.transfers.set(file.id, { state: "failed", transferred: 0, size: file.size, error });
          this.emitState();
        });
      } else {
        // The desk's replay has sent every pending request of this chat on the open session.
        if (live.link.supportsPayments) {
          const at = Date.now();
          await db.putMessage({ ...sentNow(message), details: { ...withSend(message.details, { at, ...pathSnapshot(live, "datalink"), result: "sent" }), sentAt: at } });
        } else await db.updateDelivery(linkId, message.id, "failed", "Your contact's app cannot receive payment requests.");
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
      details: { wire: fileWire("files/2", wire.size) },
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

  private fileSettled(fileId: string | undefined, error?: string, linkId?: string): void {
    if (!fileId) return;
    const transfer = this.transfers.get(fileId);
    if (!transfer) return;
    if (linkId) void this.noteFileEnd(linkId, fileId, error);
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
    // The capability record names the chat's choice, for a contact with no session to hear it on.
    this.capsChanged(linkId);
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
    await live.link.setTransportPreference(automaticTransport(live.link.availableTransports), true, true);
    this.capsChanged(linkId);
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
      relayed: !!pairing?.transport && live.link.relayedTransports.includes(pairing.transport),
      text: this.holdingFor(live) ? "hold" : live.link.textDelivery,
      dhtOnly: live.stored.deliveryMode === "dht",
      peerDhtOnly: live.link.dhtDelivery?.peerMode === "dht",
      preferred: live.stored.preferredTransport,
      transitionError: pairing?.transitionError,
      transitionTarget: pairing?.transitionTarget,
      error: pairing?.status === "error" ? pairing.error : undefined,
      waiting: live.link.transportWait,
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
  /** `networks`: for a way of paying, the networks this chat takes it on (the Accept side's cards); the others are kept. */
  async setChatPaymentMethods({ linkId, methods, networks }: { linkId: string; methods: Partial<Record<PaymentMethodName, boolean>>; networks?: Partial<Record<PaymentMethodName, WalletNetwork[]>> }): Promise<void> {
    const live = this.links.get(linkId);
    if (!live || !methods || Object.entries(methods).some(([m, on]) => !PAYMENT_METHODS.includes(m as PaymentMethodName) || typeof on !== "boolean")) throw new Error("Chat not found");
    if (networks && Object.entries(networks).some(([m, list]) => !PAYMENT_METHODS.includes(m as PaymentMethodName) || !Array.isArray(list) || !list.every((n) => n === "mainnet" || n === "testnet"))) throw new Error("Chat not found");
    const paymentMethods = { ...live.stored.paymentMethods, ...methods };
    const paymentNetworks = networks ? { ...live.stored.paymentNetworks, ...Object.fromEntries(Object.entries(networks).map(([m, list]) => [m, [...new Set(list)]])) } : live.stored.paymentNetworks;
    await db.patchLink(linkId, { paymentMethods, ...(networks ? { paymentNetworks } : {}) });
    live.stored = { ...live.stored, paymentMethods, paymentNetworks };
    // A connected contact is told on the open session; nothing reconnects.
    live.link?.setPaymentMethods(paymentMethods);
    live.link?.setPaymentNetworks?.(this.chatNetworks(live.stored));
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
  sendGroupMessage({ groupId, text, mentions }: { groupId: string; text: string; mentions?: GroupMention[] }): Promise<{ error: string | null }> {
    if (typeof text !== "string") return Promise.resolve({ error: "Nothing to send" });
    return this.groups.send(groupId, text, Array.isArray(mentions) ? mentions : []);
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
   * New → a type → a network: the wallet is made in one click, with the known-good defaults of that network, and
   * checked before its card appears: the server answers, the mint says who it is, the chain is the right one. On
   * failure nothing is saved and the error says what to try again. Types that need one thing (a Fedimint invite,
   * a Lightning or on-chain source's form) take it in `invite` or `providerId` + `values`.
   */
  async walletCreate(params: WalletCreate): Promise<WalletInstanceView> {
    const { type, network } = params;
    if (!WALLET_TYPES.includes(type)) throw new Error("Unknown kind of wallet");
    if (network !== "mainnet" && network !== "testnet") throw new Error("Choose Mainnet or Testnet");
    await this.refreshWallet();
    const offer = this.walletView.offers?.find((o) => o.type === type && o.network === network);
    if (offer && !offer.available) throw new Error(offer.reason ?? "This wallet cannot be made here");
    if (offer?.exists && type !== "lightning" && type !== "fedimint") throw new Error(`You already have a ${networkLabel(network)} ${WALLET_NAMES[type]} wallet`);
    const label = `${networkLabel(network)} ${WALLET_NAMES[type]}`;
    try {
      if (type === "cashu") await this.createCashu(network);
      else if (type === "arkade") await this.creating(this.arkWallets[network], () => this.arkWallets[network].createDefaultNow());
      else if (type === "usdt") await this.creating(this.usdtWallets[network], () => this.usdtWallets[network].createDefaultNow());
      else if (type === "bark") await this.creating(this.barkWallets[network], () => this.barkWallets[network].createDefaultNow());
      else if (type === "spark") {
        if (network === "mainnet") throw new Error(SPARK_MAINNET_NOT_YET);
        await this.creating(this.sparkWallets[network], () => this.sparkWallets[network].create({ network: sparkNetworkFor(network) }));
      } else if (type === "fedimint") {
        if (!params.invite?.trim()) throw new Error("Paste the federation's invite code (fed11…)");
        await this.creating(this.fedimintWallets[network], () => this.fedimintWallets[network].join(params.invite!));
        void this.lightnings[network].ensureReady();
      } else {
        const service = type === "lightning" ? this.lightnings[network] : this.bitcoins[network];
        const providerId = params.providerId ?? "";
        const descriptor = service.sources.view.offered.find((d) => d.id === providerId);
        if (!descriptor) throw new Error(`Choose a ${type === "lightning" ? "Lightning" : "Bitcoin"} source that runs on ${networkLabel(network)}`);
        // What the person left blank takes the network's default (a BDK wallet's chain), the rest as typed.
        const values = { ...Object.fromEntries(descriptor.fields.flatMap((f) => f.defaults?.[network] ? [[f.name, f.defaults[network]!]] : [])), ...(params.values ?? {}) };
        await this.creating(service.sources, () => service.sources.set(providerId, values));
      }
    } catch (error) {
      await this.refreshWallet();
      throw Object.assign(new Error(createFailure(label, error)), { cause: error });
    }
    await this.refreshWallet();
    const made = this.walletView.wallets?.find((w) => w.type === type && w.network === network);
    if (!made) throw new Error(`The ${label} wallet did not come up. Nothing was lost: try again.`);
    return made;
  }

  /**
   * A creation that waits on the network gets `createTiming.timeoutMs`; then its waits are cut short, and what it did
   * decides (a wait cut short saves nothing). It is never raced: a wallet saved just in time is reported as made.
   */
  private async creating(wallet: { cutShort(): void; resume(): void }, work: () => Promise<unknown>): Promise<void> {
    let late = false;
    const timer = setTimeout(() => { late = true; wallet.cutShort(); }, createTiming.timeoutMs);
    try { await work(); }
    catch (error) { throw late && error instanceof ModeChanged ? new Error("It did not answer in time") : error; }
    finally { clearTimeout(timer); wallet.resume(); }
  }

  /**
   * "Get test coins", pressed by the person on a Testnet wallet: a small fixed amount from that wallet's own faucet.
   * Cashu, and Lightning through the mints: the test mint pays an invoice asked of it on purpose. USDT: Aave's Sepolia
   * faucet, paid with the wallet's own test ETH. Never Mainnet; nothing else asks a faucet, Receive included.
   */
  async walletTestCoins({ type, network }: WalletTestCoins): Promise<TestCoinsResult> {
    if (network !== "testnet") throw new Error("Test coins are for Testnet wallets only");
    if (type === "cashu" || (type === "lightning" && (this.lightnings.testnet.view.providerId ?? CASHU_MINT_SOURCE) === CASHU_MINT_SOURCE)) {
      let got: { amount: number };
      try { got = await this.wallet.testCoins(TEST_COINS_SATS, "testnet"); }
      catch (error) { throw faucetError(error); }
      await this.refreshWallet();
      return { amount: got.amount, unit: "test sats" };
    }
    if (type === "usdt") {
      try { await this.usdtWallets.testnet.getTestTokens(); }
      catch (error) { throw faucetError(error); }
      // Aave's test USDT has 6 decimals, like USDT.
      return { amount: TEST_USDT_FAUCET_AMOUNT / 1e6, unit: "TEST-USDT", pending: true };
    }
    throw new Error("Ghostly cannot ask this wallet's faucet by itself: open it instead");
  }

  /**
   * Removes the `type` wallet of `network`, asked for by the person: its keys, its ecash and its config go, and so does
   * what every chat keeps about it (the network's place in its accepted ways of paying); every other wallet stays.
   * What was already paid to it is claimed first, then what it holds and what it still waits for are checked here
   * again, whatever the page showed: money on this device (or a balance that could not be read), and open requests or
   * invoices whose money would come to this device, are removed only with `acceptLoss`, the person's own confirmation
   * that it becomes unreachable. A payment through it that has not finished stops the removal. Its open requests are
   * closed, and their contacts told, so nobody pays them afterwards. Never logs a seed or a key.
   */
  async walletRemove({ type, network, acceptLoss }: WalletRemove): Promise<void> {
    if (!WALLET_TYPES.includes(type)) throw new Error("Unknown kind of wallet");
    if (network !== "mainnet" && network !== "testnet") throw new Error("Choose Mainnet or Testnet");
    await this.refreshWallet();
    const label = `${networkLabel(network)} ${WALLET_NAMES[type]}`;
    if (!this.walletView.wallets?.some((w) => w.type === type && w.network === network)) throw new Error(`There is no ${label} wallet to remove`);
    const first = walletRemoval(type, network, this.walletView.networks?.[network], this.walletView.intents);
    if (first.comesWith) throw new Error(`Lightning through the Cashu mints comes with your ${networkLabel(network)} Cashu wallet: remove that wallet to remove it`);
    // Ecash minted now is counted in what it holds, not deleted with its invoice.
    if (first.awaiting.length) { await this.claimPaid(type, network); await this.refreshWallet(); }
    const removal = first.awaiting.length ? walletRemoval(type, network, this.walletView.networks?.[network], this.walletView.intents) : first;
    if (removal.pending) throw new Error(`A payment through this wallet is not finished yet (${removal.pending}). Cancel it or wait for it to settle, then remove the wallet.`);
    if (removalRisksFunds(removal) && acceptLoss !== true) throw new Error(lossRefusal(label, removal));
    // Its open requests close first, while the chats still carry payment frames: once its last wallet goes, a chat
    // may have no way of paying left, and the contact would never hear of it.
    for (const item of removal.awaiting) if (item.kind === "request" && item.paymentId) await this.closeRequest(item.paymentId, `you removed the ${label} wallet it was paid to`).catch(() => {});
    try {
      if (type === "cashu") {
        const mints = this.networkMints(network);
        await this.wallet.forget(mints);
        await this.updateSettings({ settings: { mints: this.settings.mints.filter((m) => !mints.includes(m)) } });
      }
      else if (type === "arkade") await this.arkWallets[network].remove();
      else if (type === "bark") await this.barkWallets[network].remove();
      else if (type === "spark") await this.sparkWallets[network].remove();
      else if (type === "usdt") await this.usdtWallets[network].remove();
      else if (type === "fedimint") await this.fedimintWallets[network].remove();
      else await (type === "lightning" ? this.lightnings[network] : this.bitcoins[network]).sources.clear();
    } finally {
      await this.refreshWallet();
    }
    await this.forgetChatNetwork(type as PaymentMethodName, network);
  }

  /**
   * Before a wallet goes: its own rail is asked about what was paid to it (the mints about its quotes, the source about
   * its invoices, the chain or server about its requests), so money already there is claimed. Bounded: a mint or a
   * server that does not answer leaves what it holds as it was, still counted as awaited.
   */
  private async claimPaid(type: WalletType, network: WalletNetwork): Promise<void> {
    const work = type === "cashu" ? this.wallet.checkQuotes(this.networkMints(network))
      : type === "lightning" ? this.lightnings[network].reconcile()
      : type === "fedimint" ? this.fedimintWallets[network].checkReceives()
      : type === "bitcoin" ? this.desk.reconcileBitcoinReceipts()
      : type === "arkade" ? this.desk.reconcileArkReceipts()
      : type === "bark" ? this.desk.reconcileBarkReceipts()
      : type === "spark" ? this.desk.reconcileSparkReceipts()
      : this.desk.reconcileUsdtReceipts();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([work.catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, removalTiming.claimMs); })]);
    clearTimeout(timer);
  }

  /** A request of ours closes for good (its wallet was removed): never sent again, taken back from the contact's storage too. */
  private async closeRequest(paymentId: string, reason: string): Promise<void> {
    const request = this.desk.payment(paymentId);
    if (!request || !(await this.desk.close(paymentId, reason, "your contact removed the wallet it was paid to"))) return;
    const message = (await db.getMessages(request.linkId)).find((m) => m.paymentId === paymentId && m.sender === "me");
    if (message) await this.hold.forget(request.linkId, message.id).catch(() => {});
  }

  /**
   * What the chats keep about a way of paying on a network whose wallet was removed goes back to the default: a chat
   * that had that network off takes it again if a wallet of it is made later, and a way with no wallet left on any
   * network loses its on/off too. The choices about the other network stay. The contacts hear of it from the
   * paired-payments offer, which already names only the ways with a wallet.
   */
  private async forgetChatNetwork(method: PaymentMethodName, network: WalletNetwork) {
    const left = (this.walletView.wallets ?? []).some((w) => w.type === method);
    for (const live of this.links.values()) {
      const stored = live.stored, list = stored.paymentNetworks?.[method];
      const paymentMethods = { ...stored.paymentMethods }, paymentNetworks = { ...stored.paymentNetworks };
      if (!left) { delete paymentMethods[method]; delete paymentNetworks[method]; }
      else if (list && !list.includes(network)) {
        const next = [...list, network];
        if (WALLET_NETWORKS.every((n) => next.includes(n))) delete paymentNetworks[method]; else paymentNetworks[method] = WALLET_NETWORKS.filter((n) => next.includes(n));
      }
      if (JSON.stringify([paymentMethods, paymentNetworks]) === JSON.stringify([{ ...stored.paymentMethods }, { ...stored.paymentNetworks }])) continue;
      await db.patchLink(stored.id, { paymentMethods, paymentNetworks });
      live.stored = { ...stored, paymentMethods, paymentNetworks };
      live.link?.setPaymentMethods(paymentMethods);
      live.link?.setPaymentNetworks?.(this.chatNetworks(live.stored));
      this.capsChanged(stored.id);
    }
    this.emitState();
  }

  /** Cashu of one network: its default mints, only those that answer. None answering is a failure, nothing added. */
  private async createCashu(network: WalletNetwork) {
    if (this.networkMints(network).length) throw new Error(`You already have a ${networkLabel(network)} Cashu wallet`);
    const defaults = network === "testnet" ? [TEST_MINT] : DEFAULT_MINTS;
    const answered: string[] = [];
    let last: unknown;
    for (const url of defaults) {
      try { answered.push((await this.wallet.checkMint(url)).url); } catch (error) { last = error; }
    }
    if (!answered.length) throw last instanceof Error ? last : new Error("No mint answered");
    // A mint of the other network stays where it is; these become this network's, the first one primary.
    await this.updateSettings({ settings: { mints: [...this.settings.mints.filter((m) => !answered.includes(m)), ...answered], mintsInitialized: true } });
  }

  /** What New can make on each network, and what is already there. */
  private walletOffers(networks: Record<WalletNetwork, NetworkWalletsView>, wallets: WalletInstanceView[]): WalletOffer[] {
    const has = (type: WalletType, network: WalletNetwork) => wallets.some((w) => w.type === type && w.network === network);
    const offers: WalletOffer[] = [];
    for (const type of WALLET_TYPES) for (const network of WALLET_NETWORKS) {
      const view = networks[network];
      const base = { type, network, exists: has(type, network) };
      if (type === "bark" && !barkDefaults(network)) offers.push({ ...base, available: false, reason: BARK_MAINNET_UNAVAILABLE });
      else if (type === "spark" && network === "mainnet") offers.push({ ...base, available: false, reason: SPARK_MAINNET_NOT_YET });
      else if (type === "fedimint") offers.push(network === "mainnet" && !FEDIMINT_MAINNET ? { ...base, available: false, reason: FEDIMINT_MAINNET_UNAVAILABLE } : { ...base, available: true, needs: "invite" });
      else if (type === "lightning" || type === "bitcoin") {
        // Lightning through the Cashu mints comes with a Cashu wallet: New offers the other sources.
        const providers = (type === "lightning" ? view.lightning : view.bitcoin)?.offered.filter((d) => d.id !== CASHU_MINT_SOURCE) ?? [];
        const custom = type === "lightning" ? !!view.lightning?.providerId && view.lightning.providerId !== CASHU_MINT_SOURCE : base.exists;
        offers.push(providers.length ? { ...base, exists: custom, available: true, needs: "provider", providers } : { ...base, exists: custom, available: false, reason: `No ${type === "lightning" ? "Lightning source" : "on-chain wallet"} runs on ${networkLabel(network)} here yet` });
      } else offers.push({ ...base, available: true });
    }
    return offers;
  }

  /** The networks of this profile's wallets, per way of paying: every chat tells its contact (paired-payments). */
  private announcePaymentNetworks(wallets: WalletInstanceView[]) {
    const key = JSON.stringify(paymentNetworksOf(wallets));
    if (key === this.announcedNetworks) return;
    this.announcedNetworks = key;
    for (const live of this.links.values()) live.link?.setPaymentNetworks?.(this.chatNetworks(live.stored));
  }
  private announcedNetworks = "";
  /** What a chat announces: the networks of this profile's wallets, per way of paying, that the chat accepts. */
  private chatNetworks(stored: StoredLink): PaymentNetworks {
    const mine = paymentNetworksOf(this.walletView.wallets ?? []);
    return Object.fromEntries(Object.entries(mine).map(([method, networks]) => [method, networks!.filter((n) => this.acceptsNetwork(stored, method as PaymentMethodName, n))]));
  }
  /** This chat takes this way of paying on this network (a card on its Accept side). */
  private acceptsNetwork(stored: StoredLink | undefined, method: PaymentMethodName, network: WalletNetwork): boolean {
    return stored?.paymentNetworks?.[method]?.includes(network) ?? true;
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

  /** `via: "cashu"`: ecash straight from the network's mints (the Cashu card). Otherwise its active Lightning source. */
  async walletReceiveLightning({ amount, via, network }: { amount: number; via?: "cashu"; network?: WalletNetwork }) {
    const n = this.net(network);
    if (via === "cashu") {
      const quote = await this.wallet.receiveLightning(amount, undefined, n);
      return { quote: quote.quote, invoice: quote.invoice, expiresAt: quote.expiresAt, source: CASHU_MINT_SOURCE };
    }
    const created = await this.lightnings[n].createInvoice(amount);
    return { quote: created.paymentHash, invoice: created.invoice, expiresAt: created.expiresAt, paymentHash: created.paymentHash, source: created.source };
  }

  walletQuoteInvoice({ invoice, via, network }: { invoice: string; via?: "cashu"; network?: WalletNetwork }) {
    const n = this.net(network);
    return via === "cashu" ? this.wallet.quoteInvoice(invoice, n) : this.lightnings[n].quote(invoice);
  }

  /** `confirmedReal`: the person confirmed a Mainnet payment as real money; without it one is refused. */
  async walletPayQuote({ quote, mint, note, confirmedReal }: { quote: string; mint: string; note?: string; confirmedReal?: boolean }) {
    // A quote of a network's Lightning source (it knows its own), or a melt quote the Cashu card asked the mints for.
    const network = WALLET_NETWORKS.find((n) => this.lightnings[n].hasQuote(quote));
    const lightning = network && this.lightnings[network];
    assertConfirmedReal(network ?? mintNetwork(mint), confirmedReal);
    return { paid: lightning ? await lightning.pay(quote, { note }) : await this.wallet.payQuote(quote, mint, note) };
  }

  /** A Lightning address or LNURL (LUD-16, LUD-06): resolved here, in the engine, so every platform fetches the same way. */
  lnurlResolve({ text, network }: { text: string; network?: WalletNetwork }) { return this.lightnings[this.net(network)].resolveDestination(text); }
  lnurlInvoice({ id, amount, comment, network }: { id: string; amount: number; comment?: string; network?: WalletNetwork }) { return this.lightnings[this.net(network)].destinationInvoice(id, amount, comment); }

  checkPayment(params: { linkId: string; paymentId: string }) { return this.desk.checkPayment(params); }

  /** Makes a provider this network's Lightning source, with the values of its form (secrets are sealed). */
  async lightningSetSource({ providerId, values, network }: { providerId: string; values: Record<string, string>; network?: WalletNetwork }) { await this.lightnings[this.net(network)].sources.set(providerId, values); await this.refreshWallet(); }
  /** Back to the default source, the Cashu mints. */
  async lightningClearSource(params?: { network?: WalletNetwork }) { await this.lightnings[this.net(params?.network)].sources.clear(); await this.refreshWallet(); }
  async lightningRetrySource(params?: { network?: WalletNetwork }) { await this.lightnings[this.net(params?.network)].sources.retryNow(); await this.refreshWallet(); }
  async lightningReconfigureSource({ values, network }: { values: Record<string, string>; network?: WalletNetwork }) { await this.lightnings[this.net(network)].sources.reconfigure(values); await this.refreshWallet(); }
  async lightningRefresh(params?: { network?: WalletNetwork }) { const lightning = this.lightnings[this.net(params?.network)]; await lightning.sources.refresh(); await lightning.reconcile(); }
  async bitcoinSetSource({ providerId, values, network }: { providerId: string; values: Record<string, string>; network?: WalletNetwork }) { await this.bitcoins[this.net(network)].sources.set(providerId, values); await this.refreshWallet(); }
  async bitcoinClearSource(params?: { network?: WalletNetwork }) { await this.bitcoins[this.net(params?.network)].sources.clear(); await this.refreshWallet(); }
  async bitcoinRetrySource(params?: { network?: WalletNetwork }) { await this.bitcoins[this.net(params?.network)].sources.retryNow(); await this.refreshWallet(); }
  async bitcoinReconfigureSource({ values, network }: { values: Record<string, string>; network?: WalletNetwork }) { await this.bitcoins[this.net(network)].sources.reconfigure(values); await this.refreshWallet(); }
  async bitcoinReceiveAddress(params?: { network?: WalletNetwork }) { const address = await this.bitcoins[this.net(params?.network)].receiveAddress(); await this.refreshWallet(); return address; }
  bitcoinRefresh(params?: { network?: WalletNetwork }) { return this.bitcoins[this.net(params?.network)].sources.refresh(); }

  walletInspectCashu({ text }: { text: string }) {
    return { inspection: this.wallet.inspect(text) };
  }

  async walletReceiveToken({ token }: { token: string }) {
    const { amount } = await this.wallet.receiveToken(token.trim());
    return { amount };
  }

  /** `network`: only that network's Cashu wallet (its mints). */
  walletExport(params?: { network?: WalletNetwork }) {
    return this.wallet.exportTokens(params?.network ? this.networkMints(params.network) : undefined);
  }

  /**
   * A backup goes into the wallet of its own network, whichever was asked: the file says which, and a wallet of the
   * other network refuses it untouched (WrongNetworkError) before this hands it on.
   */
  private async restoreInto<W, R>(wallets: PerNetwork<W>, network: WalletNetwork | undefined, restore: (wallet: W) => Promise<R>): Promise<{ wallet: W; result: R }> {
    const first = wallets[this.net(network)];
    try { return { wallet: first, result: await restore(first) }; }
    catch (error) {
      if (!(error instanceof WrongNetworkError)) throw error;
      const wallet = wallets[error.network];
      return { wallet, result: await restore(wallet) };
    }
  }

  // Each wallet call acts on one network's wallet: the one named, else the legacy page's. A create names its chain,
  // and so its network.
  usdtCreate(params: Parameters<EngineApi["usdtCreate"]>[0]) { return this.usdtWallets[usdtMode(params.network)].create(params); }
  usdtUnlock(params: { password: string; network?: WalletNetwork }) { return this.usdtWallets[this.net(params.network)].unlock(params.password); }
  usdtReveal(params: { password?: string; network?: WalletNetwork }) { return this.usdtWallets[this.net(params?.network)].reveal(params?.password); }
  usdtLock(params?: { network?: WalletNetwork }) { return this.usdtWallets[this.net(params?.network)].lock(); }
  usdtRefresh(params?: { network?: WalletNetwork }) { return this.usdtWallets[this.net(params?.network)].refresh(); }
  usdtExportBackup(params: { password: string; network?: WalletNetwork }) { return this.usdtWallets[this.net(params.network)].exportBackup(params.password); }
  async usdtRestoreBackup(params: { text: string; password: string; network?: WalletNetwork }) { const { wallet } = await this.restoreInto(this.usdtWallets, params.network, (w) => w.restoreBackup(params.text, params.password)); await wallet.ensureReady(); }
  arkCreate(params: Parameters<EngineApi["arkCreate"]>[0]) { return this.arkWallets[arkMode(params.network)].create(params); }
  arkUnlock(params: { password: string; network?: WalletNetwork }) { return this.arkWallets[this.net(params.network)].unlock(params.password); }
  arkLock(params?: { network?: WalletNetwork }) { return this.arkWallets[this.net(params?.network)].lock(); }
  arkBackup(params: { password?: string; network?: WalletNetwork }) { return this.arkWallets[this.net(params?.network)].backup(params?.password); }
  arkExportBackup(params: { password: string; network?: WalletNetwork }) { return this.arkWallets[this.net(params.network)].exportBackup(params.password); }
  async arkRestoreBackup(params: { text: string; password: string; network?: WalletNetwork }) { const { wallet } = await this.restoreInto(this.arkWallets, params.network, (w) => w.restoreBackup(params.text, params.password)); await wallet.ensureReady(); }
  arkRefresh(params?: { network?: WalletNetwork }) { return this.arkWallets[this.net(params?.network)].refresh(); }
  arkRecover(params?: { network?: WalletNetwork }) { return this.arkWallets[this.net(params?.network)].recover(); }
  barkCreate(params: Parameters<EngineApi["barkCreate"]>[0]) { return this.barkWallets[barkMode(params.network)].create(params); }
  barkBackup(params?: { network?: WalletNetwork }) { return this.barkWallets[this.net(params?.network)].backup(); }
  barkExportBackup(params: { password: string; network?: WalletNetwork }) { return this.barkWallets[this.net(params.network)].exportBackup(params.password); }
  async barkRestoreBackup(params: { text: string; password: string; network?: WalletNetwork }) { const { wallet } = await this.restoreInto(this.barkWallets, params.network, (w) => w.restoreBackup(params.text, params.password)); await wallet.ensureReady(); }
  barkRefresh(params?: { network?: WalletNetwork }) { return this.barkWallets[this.net(params?.network)].refresh(); }
  barkBoard(params?: { network?: WalletNetwork }) { return this.barkWallets[this.net(params?.network)].board(); }
  /** An invite's federation is on one network: the wallet of that network previews and joins it. */
  async fedimintPreview(params: { invite: string; network?: WalletNetwork }) { return (await this.restoreInto(this.fedimintWallets, params.network, (w) => w.preview(params.invite))).result; }
  async fedimintJoin(params: { invite: string; recover?: boolean; network?: WalletNetwork }) {
    const { wallet, result } = await this.restoreInto(this.fedimintWallets, params.network, (w) => w.join(params.invite, { recover: !!params.recover }));
    void this.lightnings[wallet.network].ensureReady();
    return result;
  }
  fedimintLeave(params: { federation: string }) { return (this.fedimintOf(params.federation) ?? this.fedimintWallets.mainnet).leave(params.federation); }
  async fedimintRefresh(params?: { network?: WalletNetwork }) { for (const network of params?.network ? [params.network] : WALLET_NETWORKS) await this.fedimintWallets[network].refresh(); }
  async fedimintSpendNotes(params: { federation: string; amount: number }) { const { notes, operationId } = await (this.fedimintOf(params.federation) ?? this.fedimintWallets.mainnet).spendNotes(params.federation, params.amount); return { notes, operation: operationId }; }
  /** Pasted notes go to the wallet that joined their federation, whichever network it is on. */
  async fedimintReceiveNotes(params: { notes: string; network?: WalletNetwork }) {
    for (const network of WALLET_NETWORKS) {
      const wallet = this.fedimintWallets[network];
      if (await wallet.inspectNotes(params.notes).catch(() => null)) return wallet.receiveNotes(params.notes);
    }
    return this.fedimintWallets[this.net(params.network)].receiveNotes(params.notes);
  }
  fedimintInvoice(params: { federation: string; amount: number; memo?: string }) { return (this.fedimintOf(params.federation) ?? this.fedimintWallets.mainnet).createInvoice(params.federation, params.amount, params.memo ?? "").then(({ invoice }) => ({ invoice })); }
  fedimintTakeBack(params: { federation: string; operation: string }) { return (this.fedimintOf(params.federation) ?? this.fedimintWallets.mainnet).takeBack(params.federation, params.operation); }
  fedimintBackup(params?: { network?: WalletNetwork }) { return this.fedimintWallets[this.net(params?.network)].backup(); }
  fedimintExportBackup(params: { password: string; network?: WalletNetwork }) { return this.fedimintWallets[this.net(params.network)].exportBackup(params.password); }
  async fedimintRestoreBackup(params: { text: string; password: string; network?: WalletNetwork }) { return (await this.restoreInto(this.fedimintWallets, params.network, (w) => w.restoreBackup(params.text, params.password))).result; }
  fedimintRestorePhrase(params: { mnemonic: string; invites: string[]; network?: WalletNetwork }) { return this.fedimintWallets[this.net(params.network)].restorePhrase(params.mnemonic, params.invites); }
  /** A Spark wallet on the chain named (Mainnet with a Breez API key), or one restored from a phrase. */
  async sparkCreate(params: Parameters<EngineApi["sparkCreate"]>[0]) { await this.sparkWallets[sparkMode(params.network)].create(params); }
  async sparkBackup(params?: { network?: WalletNetwork }) { const { mnemonic, network } = await this.sparkWallets[this.net(params?.network)].backup(); return { mnemonic, network }; }
  sparkExportBackup(params: { password: string; network?: WalletNetwork }) { return this.sparkWallets[this.net(params.network)].exportBackup(params.password); }
  async sparkRestoreBackup(params: { text: string; password: string; apiKey?: string; network?: WalletNetwork }) { const { wallet } = await this.restoreInto(this.sparkWallets, params.network, (w) => w.restoreBackup(params.text, params.password, params.apiKey)); await wallet.ensureReady(); }
  sparkRefresh(params?: { network?: WalletNetwork }) { return this.sparkWallets[this.net(params?.network)].refresh(); }
  /**
   * One seed for both: the Spark wallet of a network becomes that network's Breez Lightning source too. The SDK is
   * shared (same seed, same storage), so there is one wallet and one balance behind the Spark and Lightning cards.
   */
  async sparkUseForLightning(params?: { network?: WalletNetwork }) {
    const network = this.net(params?.network);
    const { mnemonic, apiKey } = await this.sparkWallets[network].backup();
    await this.lightnings[network].sources.set(BREEZ_SOURCE, { mnemonic, ...(apiKey ? { apiKey } : {}) });
    await this.refreshWallet();
  }
  async preparePayment(params: Parameters<EngineApi["preparePayment"]>[0]) {
    // The card chosen and what it pays are on one network, or nothing is prepared: test coins never pay for real money.
    const paying = params.target.method === "cashu" ? mintNetwork(params.target.provider) : walletNetworkOf(params.target.network);
    if (params.network && params.network !== paying) throw new Error(crossNetwork(params.network, paying));
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
      // A way this chat has off on that network (its Accept side) pays nothing here, as it takes nothing.
      if(!this.acceptsNetwork(this.links.get(params.linkId)?.stored, params.target.method, paying))throw new Error(`${networkLabel(paying)} ${WALLET_NAMES[params.target.method]} is off in this chat`);
      const request=params.requestId ? this.desk.payment(params.requestId) : undefined;
      if(params.requestId){
        if(!request || request.linkId!==params.linkId || request.direction!=="in" || request.state!=="pending" || request.amount!==params.amount)throw new Error("Payment review does not match the authenticated request");
        if(params.target.method!=="cashu" ? JSON.stringify(request.target)!==JSON.stringify(params.target) : !!request.target || params.target.address!==request.id || !request.mints?.includes(params.target.provider))throw new Error("Selected method or mint does not match the authenticated request");
        if(request.lightningPending || Object.values(this.desk.views()).some(p=>p.kind==="payment" && p.requestId===request.id && p.linkId===params.linkId && !["failed","reclaimed"].includes(p.state)))throw new Error("This request already has a payment; reconcile it instead");
        const asked=paymentNetwork(request);
        if(asked!==paying)throw new Error(crossNetwork(paying, asked));
      } else if(params.target.method!=="cashu" || !payee || params.target.address!==payee)throw new Error("Destination does not match the authenticated peer");
      params={...params,payee};
    }
    if(params.target.method==="cashu" && !params.linkId)throw new Error("Select a Cashu chat request first");
    if(params.target.method==="fedimint" && !params.requestId)throw new Error("Fedimint ecash is paid on a contact's request in a chat");
    const memo=typeof params.memo==="string" ? params.memo.trim().slice(0,140) || undefined : undefined;
    return this.paymentCoordinator.prepare(params.target,params.amount,params.feeCap,{payee:params.payee,linkId:params.linkId,requestId:params.requestId,memo});
  }
  /** The wallets of a review's network read again after it moved money. */
  private async refreshNetwork(review: PaymentReview) {
    const network = review.method === "cashu" ? mintNetwork(review.provider) : walletNetworkOf(review.network);
    await this.arkWallets[network].refresh(); await this.barkWallets[network].refresh(); await this.sparkWallets[network].refresh(); await this.usdtWallets[network].refresh();
  }
  /** `confirmedReal`: the person confirmed a Mainnet payment as real money; without it one is refused. */
  async approvePayment(params: {id:string;confirmedReal?:boolean}) {
    const intent=await intentRepository.get(params.id);
    if(intent)assertConfirmedReal(intent.review.method==="cashu" ? mintNetwork(intent.review.provider) : walletNetworkOf(intent.review.network), params.confirmedReal);
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
    await this.refreshNetwork(review);return review;
  }
  async reconcilePayment(params: {id:string}) {
    const review=await this.paymentCoordinator.reconcile(params.id);
    await this.desk.confirmReviewedCashu(review);
    if(review.state==="settled")await this.desk.recordArk(review).catch(()=>{});
    await this.desk.recordBark(review).catch(()=>{});
    await this.desk.recordBitcoin(review).catch(()=>{});
    await this.desk.recordSpark(review).catch(()=>{});
    await this.desk.recordUsdt(review).catch(()=>{});
    await this.refreshNetwork(review);return review;
  }
  cancelPayment(params: {id:string}) { return this.paymentCoordinator.cancel(params.id); }

  /** `network`: the Cashu card of that network sends (its mints). `confirmedReal`: required on Mainnet. */
  sendPayment(params: { linkId: string; amount: number; memo?: string; timestamp: number; network?: WalletNetwork; confirmedReal?: boolean }) {
    const live = this.links.get(params.linkId);
    // Ecash is a bearer token: it is never held for an away contact, only a request for it is.
    if (live && this.holdingFor(live)) throw new Error("Ecash is not held for an away contact. Send a request instead, or wait until they are back.");
    return this.desk.send({ ...params, network: this.net(params.network) });
  }

  /** `network`: the card's network; the request is paid only by a wallet of that network. */
  requestPayment(params: { linkId: string; amount: number; memo?: string; timestamp: number; method?: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin" | "fedimint" | "spark"; rail?: "cashu" | "lightning"; network?: WalletNetwork }) {
    return this.desk.request({ linkId: params.linkId, amount: params.amount, memo: params.memo, timestamp: params.timestamp, method: params.method, network: this.net(params.network),
      ...(params.rail === "cashu" || params.rail === "lightning" ? { rail: params.rail } : {}) });
  }

  /** A request any member of a group may pay, once (WISP 9xx § Payments). */
  requestGroupPayment(params: { groupId: string; amount: number; memo?: string; timestamp: number; rail: "cashu" | "lightning"; network?: WalletNetwork }) {
    const group = this.groups.views().find(g => g.id === params.groupId);
    if (group?.status !== "active") throw new Error("You are not in this group");
    if (group.members.length < 2) throw new Error("Nobody else is in the group yet");
    return this.desk.requestFromGroup({ ...params, network: this.net(params.network) });
  }

  /** Paying on a card without a request (Ark, Bark, Spark, USDT, on-chain): the contact's app answers with one, on this card's network. */
  askToPay(params: { linkId: string; amount: number; method: "arkade" | "usdt" | "bark" | "bitcoin" | "spark" | "fedimint"; memo?: string; timestamp: number; network?: WalletNetwork }) {
    if (params.method !== "arkade" && params.method !== "usdt" && params.method !== "bark" && params.method !== "bitcoin" && params.method !== "fedimint" && params.method !== "spark") throw new Error("Only Ark, Bark, Spark, USDT, on-chain Bitcoin and Fedimint are paid this way");
    return this.desk.ask({ ...params, network: this.net(params.network) });
  }

  /** `network`: the card chosen to pay; a request of the other network is refused, nothing spent. `confirmedReal`: required on Mainnet. */
  payRequest(params: { linkId: string; paymentId: string; via?: "lightning"; maxFee?: number; network?: WalletNetwork; confirmedReal?: boolean }) {
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
    if (settings.relays && (this.relays || this.transport.configure) && !settings.relays.some((relay) => normalizeRelayUrl(relay))) throw new Error("Enter at least one relay address (https://…)");
    if (settings.readRelays !== undefined && typeof settings.readRelays !== "boolean") throw new Error("readRelays is on or off");
    if (settings.irohRelays) {
      if (settings.irohRelays.length > 4) throw new Error("Use at most four Iroh relays");
      for (const relay of settings.irohRelays) { const problem = irohRelayProblem(relay); if (problem) throw new Error(problem); }
    }
    const irohRelaysChanged = settings.irohRelays !== undefined && JSON.stringify(settings.irohRelays) !== JSON.stringify(this.settings.irohRelays ?? []);
    if (settings.hyperdhtRelay !== undefined) {
      if (typeof settings.hyperdhtRelay !== "string") throw new Error("Enter a relay address (wss://…)");
      settings.hyperdhtRelay = settings.hyperdhtRelay.trim();
      const problem = settings.hyperdhtRelay && hyperdhtRelayProblem(settings.hyperdhtRelay);
      if (problem) throw new Error(problem);
    }
    const relayBefore = this.hyperdhtRelay;
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
      // The Desktop writes to them: kept as the browsers keep theirs. Elsewhere (a transport of one's own) as given.
      else if (this.transport.configure) this.settings.relays = [...new Set(settings.relays.map(normalizeRelayUrl).filter((relay): relay is string => relay !== null))];
    }
    if (settings.relays || settings.readRelays !== undefined) {
      if (this.settings.readRelays !== true) delete this.settings.readRelays;
      this.configureDirect();
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
    // Load public profiles: absent means on; turned off, nothing read before is kept.
    if (settings.publicProfiles !== undefined) {
      if (settings.publicProfiles !== false) delete this.settings.publicProfiles;
      else this.settings.publicProfiles = false;
      await db.putSettings(this.settings);
      if (settings.publicProfiles === false) await this.publicProfiles.clear();
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
    if (settings.hyperdhtRelay !== undefined) {
      // The default is kept as no setting at all, so a later default reaches whoever never chose.
      if (settings.hyperdhtRelay === DEFAULT_HYPERDHT_RELAY) delete this.settings.hyperdhtRelay;
      await db.putSettings(this.settings);
      if (this.hyperdhtRelay !== relayBefore && this.settings.online) await this.relayChanged();
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
      void this.did.publishNow().catch(() => {});
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

  private async closeGroupLink(linkId: string): Promise<void> {
    const live = this.links.get(linkId);
    if (!live?.stored.group) return;
    this.links.delete(linkId);
    // An entry session is over once the admission is (or was given up): nobody waits on it, so it goes
    // without a last packet saying so, which would only spend two of the relays' requests at a busy moment.
    await live.link?.stop(!live.stored.groupEntry); await live.caps?.stop();
    await db.deleteLink(linkId);
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
      // An entry session carries one admission and closes. The member's side always dials (the joiner's key is
      // drawn so), and the joiner's packet is already there: its offer goes in its first packet.
      ...(entry ? { oneShot: true, firstPublish: stored.groupEntry === "host" ? "after-first-poll" as const : "at-start" as const } : {}),
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
          // The joiner closed its side on the welcome: the session goes now. Left to itself, it would dial
          // the joiner again (its packet still looks online), spending an offer and fast polls on nobody.
          if (entry && state !== "open" && live.entryDone) void this.closeGroupLink(linkId).catch(() => {});
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
      paymentNetworks: this.chatNetworks(stored),
      holdSupport: !!stored.hold?.enabled,
      arkPaymentsSupport: true,
      usdtPaymentsSupport: true,
      barkPaymentsSupport: true,
      params: stored,
      rtcAvailable: typeof RTCPeerConnection !== "undefined",
      // Call media is a WebRTC connection of its own, whatever carries the chat: no WebRTC, no calls (Linux WebKitGTK).
      callsSupport: typeof RTCPeerConnection !== "undefined",
      largeFilesSupport: true,
      servicesSupport: this.options.servicesSupport ?? (this.options.platform ?? "web") !== "web",
      dht: stored.profile ? { state: stored.dhtDeliveryState, save: async state => {
        await db.patchLink(linkId, { dhtDeliveryState: state });
        live.stored = { ...live.stored, dhtDeliveryState: state };
      },
        // The capability record's revision rides every envelope; a newer one from the contact is read (WISP 03).
        capsRev: () => live.caps?.rev, peerCapsRev: rev => live.caps?.peerRev(rev),
        // A contact whose record lacks dht-text/1 gets nothing on the DHT: what would go there waits for live.
        peerAcceptsText: () => { const peer = live.caps?.peer; return !peer || peer.capabilities.includes(DHT_TEXT_CAPABILITY); },
      } : undefined,
      native: { peerDescriptors: stored.peerDescriptors, peerTransports: stored.peerTransports,
        peerFallback: stored.peerFallback, preferred: stored.preferredTransport, fallback: stored.transportFallback,
        automatic: stored.preferredTransport === undefined },
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
        onTransportsChanged: () => {
          if (live.link && !live.link.availableTransports.includes("hyperdht/1")) this.retryRelayLater();
          // How to dial this side changed (an endpoint went, or homed on a relay): the capability record says so.
          this.capsChanged(linkId);
          this.emitState();
        },
        onPeerTransportChoice: (transport, apart) => {
          const log = this.transportLogOf(live);
          // Heard apart from a session's intent (its record, or a session it chose before): a row only if it is news.
          if (!log || (apart && log.lastChoice("contact") === transport)) return;
          if (log.chose("contact", transport, Date.now())) this.saveTransportLog(live, log);
        },
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
        // Waiting for a chosen transport (WISP 100): the header, the panel and the menu say so; the history keeps attempts.
        onTransportWait: () => { this.observeTransport(linkId); this.emitState(); },
        // Why the chat is not live: what the last attempt tried (WISP 100), never a silent retry loop.
        onLiveAttempt: () => this.emitState(),
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
            details: GhostlyNode.receivedTextDetails(!!stored.profile, message),
            ...(message.preview && { preview: message.preview }),
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
          this.fileSettled(this.localFileId(linkId, id, direction, { failed: false }), undefined, linkId),
        onFilesFrame: (frame) => this.fileDesk.handle(linkId, frame),
        onFilesSession: (open) => this.fileDesk.session(linkId, open),
        onFileFailed: (id, reason, direction) =>
          this.fileSettled(this.localFileId(linkId, id, direction, { failed: true }), reason, linkId),
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
        published: () => live.link?.announceCapsRevision(),
      });
      live.caps.start();
      // The contact's record as last read: what its app runs, before any session says more (WISP 03).
      const peer = live.caps.peer;
      if (peer) {
        link.learnPeerTransports(peer.transports.filter((t): t is PairedTransport => (TRANSPORTS as readonly string[]).includes(t)), dialDescriptors(peer.descriptors));
        link.learnPeerChoice(peer.choice);
      }
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
      transports: this.runnableTransports(live),
      capabilities: ["chat/1", DHT_TEXT_CAPABILITY, ...(live?.stored.hold?.enabled ? [HOLD_CAPABILITY] : []), "files/2",
        ...(cashu || lightning ? ["payments/1"] : []), ...(cashu ? ["payments-cashu/1"] : []), ...(lightning ? ["payments-lightning/1"] : [])],
      extensions: ["ping/1"],
      descriptors: capsDescriptors(live?.link?.nativeDescriptors),
      name,
      // The transport chosen for this chat, for a contact with no session to hear it on (WISP 100).
      ...(live?.link?.choice ? { choice: live.link.choice } : {}),
    };
  }

  /**
   * Every layer-1 transport this app runs for a chat, started or not (WISP 03): those it has started, in their order,
   * then WebRTC where the page has it, then the native adapters it can start. `descriptors` names the started ones,
   * so a contact tells one still starting from one this app lacks (WISP 100).
   */
  private runnableTransports(live: LiveLink | undefined): PairedTransport[] {
    const started = live?.link?.availableTransports ?? [];
    const can: PairedTransport[] = [...(typeof RTCPeerConnection !== "undefined" ? ["webrtc/1" as const] : []), ...Object.keys(this.nativeFactories) as NativeTransport[]];
    return [...started, ...TRANSPORTS.filter(t => can.includes(t) && !started.includes(t))];
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
    if (!live) return;
    // Native transports to try without WebRTC first, and how to dial them as the contact last said; a choice it made
    // meanwhile (WISP 100, "A choice made while not live").
    live.link?.learnPeerTransports(record.transports.filter((t): t is PairedTransport => (TRANSPORTS as readonly string[]).includes(t)), dialDescriptors(record.descriptors), true);
    live.link?.learnPeerChoice(record.choice, true);
    if (live.link?.isDataLinkOpen) return;
    if (record.name !== (live.stored.peerNick ?? "")) {
      live.stored = { ...live.stored, peerNick: record.name };
      void db.patchLink(linkId, { peerNick: record.name });
    }
    void this.hold.peerSaid(linkId, { peerAllows: record.capabilities.includes(HOLD_CAPABILITY) });
    const methods = (["cashu", "lightning"] as const).filter(m => record.capabilities.includes(`payments-${m}/1`));
    void this.hold.rememberPeerMethods(linkId, methods).catch(() => {});
    this.emitState();
  }

  /** The native transports this engine runs: the host's, Iroh's browser build where it runs in the page, and HyperDHT through a relay where one is set and the host has no HyperDHT of its own. */
  private get nativeFactories(): Partial<Record<NativeTransport, (seedB64: string) => Promise<NativeEndpoint>>> {
    const relay = this.relaysHyperdht ? this.hyperdhtRelay : "";
    return {
      // Loaded only now: a browser that never uses a relay never downloads the HyperDHT client.
      ...(relay ? { "hyperdht/1": async (seedB64: string) => (await import("../platform/hyperdhtRelay")).createRelayedHyperEndpoint(seedB64, relay) } : {}),
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

  /** The HyperDHT relay a browser reaches the HyperDHT through; empty when none is set. */
  private get hyperdhtRelay(): string { return (this.settings.hyperdhtRelay ?? DEFAULT_HYPERDHT_RELAY).trim(); }
  /** HyperDHT goes through the relay here: the host runs none of its own (the Desktop does). */
  private get relaysHyperdht(): boolean { return !this.options.nativeTransports?.["hyperdht/1"]; }

  /**
   * A relayed endpoint went away (the relay restarted, the network dropped): try again in a while, for every
   * chat that keeps native listeners, as opening a chat would.
   */
  private relayRetry: ReturnType<typeof setTimeout> | null = null;
  private retryRelayLater(): void {
    if (!this.relaysHyperdht || !this.hyperdhtRelay || this.relayRetry || this.shuttingDown) return;
    this.relayRetry = setTimeout(() => {
      this.relayRetry = null;
      for (const [linkId, live] of this.links) {
        if (live.link && live.stored.profile && !live.stored.group && live.stored.deliveryMode !== "dht" && !live.link.availableTransports.includes("hyperdht/1")
          && (live.stored.pairedPeerKey || this.activeLinkId === linkId)) void this.ensureNativeEndpoints(linkId);
      }
    }, RELAY_RETRY_MS);
  }

  /** A new relay (or none): chats give up their endpoints on the old one, as soon as none of them carries a session. */
  private async relayChanged(): Promise<void> {
    if (!this.relaysHyperdht) return;
    for (const [linkId, live] of this.links) {
      const link = live.link;
      if (!link?.availableTransports.includes("hyperdht/1")) {
        if (this.hyperdhtRelay && link && (live.stored.pairedPeerKey || this.activeLinkId === linkId)) void this.ensureNativeEndpoints(linkId);
        continue;
      }
      if (!link.canReleaseEndpoint("hyperdht/1")) continue;
      await link.releaseEndpoint("hyperdht/1");
      if (live.transportErrors) delete live.transportErrors["hyperdht/1"];
      if (this.hyperdhtRelay) void this.ensureNativeEndpoints(linkId);
    }
    this.emitState();
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
          // The record says how to dial it, so a contact whose WebRTC never connects can try it (WISP 03).
          this.capsChanged(linkId);
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
    // A peer says when it sent a message; a time far ahead of this clock would pin the chat to the top of the list
    // and may be past what a date holds, so it is taken as now at the latest.
    if (message.sender === "peer") message = { ...message, timestamp: receivedTimestamp(message.timestamp) };
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
    // Its details begin here: the path a received message came over, or the one a payment goes over right now.
    if (message.sender === "peer" && live && !message.details?.received) message = { ...message, details: { ...message.details, received: { at: Date.now(), ...pathSnapshot(live, message.via) } } };
    else if (message.sender === "me" && message.paymentId && !message.delivery && live && !message.details?.sends) {
      const at = Date.now();
      message = { ...message, details: { ...withSend(message.details, { at, ...pathSnapshot(live, message.via), result: "sent" }), sentAt: at } };
    }
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
      peerFileRoom: stored.profile ? this.fileDesk.status(stored.id).peerRoom : undefined,
      hold: this.hold.view(stored.id),
      paymentMethods: Object.fromEntries(PAYMENT_METHODS.map(m => [m, stored.paymentMethods?.[m] !== false])) as Record<PaymentMethodName, boolean>,
      paymentNetworks: Object.fromEntries(PAYMENT_METHODS.map(m => [m, WALLET_NETWORKS.filter((n) => this.acceptsNetwork(stored, m, n))])) as Record<PaymentMethodName, WalletNetwork[]>,
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
      relayedTransports: live.link?.relayedTransports,
      deliveryMode: live.stored.deliveryMode ?? "stream",
      dhtDelivery: live.link?.dhtDelivery,
      canSendText: (live.link?.canSendText ?? false) || this.holdingFor(live),
      textDelivery: this.holdingFor(live) ? "hold" : live.link?.textDelivery ?? "unavailable",
      transportErrors: live.transportErrors,
      // Automatic: what the app's rule prefers here, so the Fallback switch sends a transport this app has.
      preferredTransport: live.stored.preferredTransport ?? automaticTransport(live.link?.availableTransports ?? []),
      transportFallback: live.stored.transportFallback ?? true,
      transportAutomatic: live.stored.preferredTransport === undefined,
      peerTransports: live.link?.peerAvailableTransports,
      transportWait: live.link?.transportWait,
      liveAttempt: live.link?.liveAttempt,
      liveDialer: live.stored.profile && !live.stored.group ? live.link?.dialer : undefined,
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
    if (!this.holdingFor(live)) return { files: !!link && GhostlyNode.takesFiles(link), payments: link?.supportsPayments ?? false,
      calls: link?.supportsCalls ?? false, services: link?.supportsServices ?? false, largeFiles: link?.supportsLargeFiles ?? false,
      methods: Object.fromEntries(PAYMENT_METHODS.map(m => [m, link?.allowsPayment(m) ?? false])) as Record<PaymentMethodName, boolean>,
      ...(link?.peerWalletNetworks?.() ? { networks: link.peerWalletNetworks() } : {}) };
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
