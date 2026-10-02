import { UsdtWallet, usdtMode } from "./paymentAdapters/usdtWallet";
import { iceServerProblem } from "../shared/ice";
import type { UsdtPrepared } from "./paymentAdapters/usdt";
import { ArkWallet, arkMode } from "./paymentAdapters/arkWallet";
import { BarkWallet, barkMode } from "./paymentAdapters/barkWallet";
import { FedimintWallet } from "./paymentAdapters/fedimintWallet";
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
import { CASHU_CARD, LightningCards } from "./paymentAdapters/providers/lightningCards";
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
import { PublicActivity } from './publicActivity';
import { normalizeNostrRelays } from '../nostr/relay';
import type { NostrDraft, NostrDraftRequest, NostrLookupRequest, NostrLookupResult, NostrPublishResult } from '../nostr/types';
import { readPubkyProof } from '../proofs/storage';
import { lookupPublicProfile, currentProfileProof, PROFILE_RETRY, PROFILE_TTL, type ProfileChoice } from '../profiles/public';
import { BUTTON_ID, BUTTONS_CAPABILITY, EDIT_CAPABILITY, MAX_EDITS_PER_MESSAGE, STATUS_CARD_LIMITS, checkStatusCard, forwardedAgain, readForwarded, statusCardText, withRequestOptions, type StatusCard, type WireEdit } from "@ghostly/core";
import { FORWARD_MESSAGES, FORWARD_TARGETS, copyForForward, forwardKind, type ForwardResult } from "./forwards";
import { TEST_USDT_FAUCET_AMOUNT, arrivalKey, claimedTime, heardTime, receivedTimestamp, typingActivity, type TypingActivity, type TypingKind, WALLET_NETWORKS, walletNetworkOf, type GroupMention, type PaymentNetworks, type PaymentReview, type PaymentTarget, type WalletNetwork } from "@ghostly/core";
import { ModeChanged, networkLabel, WrongNetworkError } from "./paymentAdapters/modeGate";
import { assertConfirmedReal, createTiming, WALLET_NAMES, createFailure, crossNetwork, paymentNetwork, paymentNetworksOf, walletInstances } from "./paymentAdapters/walletInstances";
import { migrateWalletNetworks } from "./paymentAdapters/walletNetworks";
import { perNetwork, type PerNetwork } from "./paymentAdapters/perNetwork";
import { COMMUNITY_EDIT_FRAME, INVITE_TAKEN, LIVENESS_MISSED_PINGS, LIVENESS_PING_MS, MAX_GROUP_NAME_LENGTH, engineError, engineText, groupName, parseCommunityEdit, traceLink } from "@ghostly/core";
import { ClockWatch, DirectPathWatch } from "@ghostly/core";
import { GROUP_WAKE_FRAME, GROUP_WAKE_RECEIVE_LIMIT, GroupWakeLimiter, RateWindow, WAKE_CALL_INTERVAL_MS, WakeLimiter, groupWakeFrame, groupWakes, parseGroupWakeFrame, checkPushEndpoint, newWakeToken, relayRequest, vapidKeysMatch, wakeRequest, type PushRequest, type WakeKind, type WakeTarget } from "@ghostly/core";
import { COMMUNITY_REACTION_FRAME, GROUP_REACTION_FRAME, REACTION_LIMITS, ReactionWindow, queueReaction, readReaction, validReactionNumber, wireReaction, type WireReaction } from "@ghostly/core";
import { COMMUNITY_PIN_FRAME, PIN_LIMITS, mayPin, pinIsNewer, pinNumberHolds, readPin, type GroupPinFrame, type WirePin } from "@ghostly/core";
import { CapsExchange, DHT_TEXT_CAPABILITY, HOLD_CAPABILITY, TRANSPORTS, automaticTransport, capsDescriptors, dialDescriptors, type CapsContent, type CapsRecord, type PairingCredentials } from "@ghostly/core";
import { fileMessageText, parseLinkPreview, pairedMessageFrame, type WireReply, type LinkPreview, type PaymentRequest, type PaymentAsk, type Payment, type PaymentResult, HOLD_LIMITS, MAX_DHT_TEXT_BYTES, normalizeRelayUrl, sanitizeAvatar, PeerProofs, emptyProofLedger, emptyIdentityLedger, lastSharedWithMe, receivedIdentityStatus, type ProofChallenge, type ProofEvidence, type ProofAdapter, type ProofScope, type PaymentMethodName } from "@ghostly/core";
import {
  presenceSeenAt,
  DEFAULT_RELAYS,
  currentRelays,
  GhostLink,
  utf8Encode,
  type IncomingMessage,
  emptyLinkRecords,
  createRelayPayload,
  type Identity,
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
import type { AttentionCue, AttentionEvent, EngineImplementation } from "../shared/rpc";
import { clearProfileStores, fileStore, type StoredFile } from "../shared/idb";
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
  CardIndexRow,
  MessagePage,
  MessageReply,
  ReactionNote,
  MessageSend,
  GroupView,
  Settings,
  SettingsPatch,
  StoredLink,
  StoredMessage,
  StoredPin,
  StoredService,
  NetworkWalletsView,
  WalletAwaitingView,
  MintView,
  WalletCreate,
  WalletRemove,
  WalletTestCoins,
  TestCoinsResult,
  WalletInstanceView,
  WalletOffer,
  WalletTx,
  WalletType,
  WalletView,
  PublicGraphView,
  PublicPostImageView,
  PublicPostsView,
} from "../shared/types";
import { WALLET_TYPES } from "../shared/types";
import type { WakeSubscription } from "../shared/types";
import { forgetWallet, mainnetBalances, markBackedUp, observeBalances, putOff, type BackupReminders } from "../shared/backupReminder";
import type { MessageChanges } from "../shared/messageChanges";
import { pairedWireReply, receivedPairedReply, replyRef, replyTo as replyToOriginal } from "../shared/replies";
import { buttonPress, buttonsState } from "../shared/buttons";
import { canEdit, isJoinNotice, takesPeerEdit, withEdit } from "../shared/edits";
import { CardEditPacer, EditBuffer, EditQueue } from "./edits";
import { ENGLISH_REMOVAL, removalRisksFunds, walletRemoval } from "../shared/walletRemoval";
import { mintAwaiting, walletAwaiting } from "./walletAwaiting";
import type { WalletRemoval } from "../shared/walletRemoval";
import { TEST_COINS_SATS, faucetError } from "./paymentAdapters/testCoins";
import { composeDetails, fileWire, pathSnapshot, withSend, type PathSnapshot } from "./messageDetails";
import { db } from "./db";
import { settleAhead } from "./arrival";
import { Groups, meshEdgeIntervals, otherEndSeen } from "./groups";
import { edgeView } from "./groupEdges";
import { GroupPayments } from "./groupPayments";
import { Reactions, groupReactionsToResend, latestReaction, noteAfterChange } from "./reactions";
import { mayPinIn, myPin, pinView, pinnedRow } from "./pins";
import { GroupEdits } from "./groupEdits";
import { CommunityPay, groupLinkId, parsePayLink } from "./communityPay";
import { mayReach } from "./serviceAccess";
import { Outbox } from "./outbox";
import { HoldEngine } from "./hold";
import { TransportLog } from "./transportLog";
import { ProfilePeek, readPathOf, type PeekResult } from "./profilePeek";
import { S3Store } from "../backup/s3";
import type { HoldStore } from "../backup/storage";
import { PaymentDesk } from "./payments";
import { CashuWallet, TEST_COINS_NOTE, normalizeMintUrl } from "./wallet";
import { identityCues, knockCue, paymentCue, transportCue, transportMark, type Cue } from "./cues";
import { CLOCK_SAMPLES, messageAttention, writtenAt } from "./attention";
import { DEFAULT_HYPERDHT_RELAY, hyperdhtRelayProblem } from "../shared/hyperdhtRelay";
import { pushRelayProblem } from "../shared/pushRelay";
import { traceJoin } from "./joinTrace";
import { SETUP_NETWORK, WalletSetup } from "./walletSetup";
import { DEFAULT_IROH_RELAYS, createIrohWebEndpoint, irohRelayProblem } from "../platform/irohWeb";

/** How long a chat waits before listening again after its HyperDHT relay went away. */
const RELAY_RETRY_MS = 30_000;
/** Native listeners an app may hold per transport (the Desktop's Rust Iroh allows eight, `paired_transport.rs`). */
const NATIVE_SLOTS = 8;
/**
 * Of those, what a group's links (edges, entry sessions) may hold where one side has no WebRTC (WISP 9xx § Transports):
 * half, so 1:1 chats keep room. It is also the group links' budget of connections on an app with no WebRTC (`peerRoom`).
 */
export const GROUP_NATIVE_SLOTS = 4;
/** How often a group link that found no free native slot tries again. */
const GROUP_NATIVE_RETRY_MS = 15_000;
/** "Clear all data": how long taking things back from the network may hold up the clear, in all. */
export const CLEAR_WITHDRAW_MS = 6_000;
/**
 * How soon the chat on screen tries again for a native slot when every one was busy (each dialling, or carrying a
 * session): a dial to a contact that is not there ends within its 20 s timeout, and leaves its slot free until the next.
 */
const ACTIVE_SLOT_RETRY_MS = 3_000;
/**
 * Every native listener taken, each by a chat live over it: the chat in use (on screen, or a text going or coming in
 * it) takes the one of the chat whose session has gone unused longest, once that is this long (no text, receipt,
 * typing, reaction or file; never with a call on). It is also how long a listener taken that way is kept from going
 * straight back: a session that just started has been unused for none of it, and one still dialling is not taken from.
 */
export const NATIVE_HOLD_MS = 2 * 60_000;
/**
 * How long a chat live when the app last ran may take to be live again before that stretch counts as over
 * (`TransportLog.notBackAfterRestart`): past the contact's liveness bound (three pings missed), the session it held is
 * gone too. Shorter, an app started twice in quick succession would not knock the second time on a contact still
 * holding the session.
 */
export const RESUME_SPENT_MS = LIVENESS_PING_MS * (LIVENESS_MISSED_PINGS + 1);

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
/** A reaction said on the live session and not confirmed is said again after this long. */
const REACTION_RESEND_MS = 30_000;
/** A second press of one message's buttons waits this long (WISP 4xx · Message Buttons). */
export const BUTTON_PRESS_MS = 1_000;

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
  /** When this chat last took a native listener from an idle live session (`ensureNativeEndpoints`), by transport. */
  nativeTakenAt?: Partial<Record<NativeTransport, number>>;
}

/** What one peer has sent us, so it can neither fill the disk nor reuse an id. */
interface LinkFiles {
  /** Received bytes stored, plus those announced by transfers still in flight. */
  receivedBytes: number;
  /** Wire ids already used on this link, in either direction. */
  wireIds: Set<string>;
  /** Transfers in flight from the peer, by wire id. */
  incoming: Map<string, { localId: string; size: number }>;
  /** files/2 message ids taken since the app started, by the wire id of the file whose message it is. */
  messageIds?: Map<string, string>;
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

interface SpareInvite { mine: LinkParams; inviteKey: ReturnType<typeof identityFromSeedB64>; inviteCode: string; madeAt: number; warmedAt?: number }
/** A spare invite is warmed again this often while it waits, and handed out only between these ages. */
const SPARE_INVITE_WARM_EVERY_MS = 4 * 60_000;
/**
 * The spare that replaces one handed out is warmed this long after, not in the second the new chat is made: its two
 * packets spent a pairing's requests while it signals, and in a burst of invites the next chat came too soon to take
 * it anyway. Three pairings in a minute are the whole of a page's relay budget (2026-09-27).
 */
export const SPARE_INVITE_WARM_AFTER_TAKE_MS = 30_000;
export const SPARE_INVITE_MIN_AGE_MS = 6_000;
/**
 * At start (and back online), writes that can wait go this long after the chats' and groups' first packets: the spare
 * invite's warm-up, a chat's first control envelope, its capability record (once the chat's native endpoints are up).
 * A daemon back with two chats and two groups spent 25 of pkarr.pubky.org's 30 requests a minute on writes in its
 * first 11 s, and read nothing more for the rest of the minute, the others' answers included (bug hunt r7a, 2026-09-29).
 */
export const STARTUP_QUIET_MS = 15_000;
const SPARE_INVITE_MAX_AGE_MS = 15 * 60_000;
/** How far before this clock a warm packet is dated (`warmKey`): further than a contact's clock is ever behind. */
export const WARM_DATED_BACK_MS = 24 * 60 * 60_000;

/** How long a removal waits for a wallet's rail to claim what was already paid to it (tests shorten it). */
export const removalTiming = { claimMs: 30_000 };

/** Why a removal needs the person's confirmation: what it holds, what it still waits for, and what confirming means. */
/** `label`: what goes, as a noun ("Testnet Cashu wallet", "Testnet Lightning card “Home”"). */
function lossRefusal(label: string, removal: WalletRemoval): string {
  const { held, awaiting } = removal;
  const holds = held === "unknown" ? `Ghostly could not read what the ${label} holds.` : held.empty ? "" : `The ${label} holds ${held.text}.`;
  const listed = awaiting.slice(0, 3).map((i) => i.text.charAt(0).toLowerCase() + i.text.slice(1)).join("; ") + (awaiting.length > 3 ? `; and ${awaiting.length - 3} more` : "");
  const waits = awaiting.length ? `${holds ? " It" : `The ${label}`} still waits for money: ${listed}.` : "";
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
  /** Reactions on 1:1 chats (`react/1`, WISP 401 § Reactions). Default on; off only stands in for an older app in tests. */
  reactions?: boolean;
  /** How to reach Pkarr. Default: HTTP relays, the only way out of a browser. */
  transport?: PkarrTransport;
  pollIntervals?: PollIntervals;
  /** How to reach a shared local web app. Default: `fetch`, which needs the app's or the browser's consent. */
  localFetch?: LocalFetch;
  /** Create and connect the Ark, Bark, Spark and USDT wallets at start. Default: on; tests without a network turn it off. */
  automaticWallets?: boolean;
  /**
   * A new profile gets its default Mainnet wallets by itself (Cashu, USDT, and Bitcoin on-chain where it runs on
   * Mainnet), in the background, once (see `WalletSetup`). Default: off. The apps turn it on, except under test (the
   * host decides, before the peer starts); the CLI and the unit tests never do.
   */
  defaultWallets?: boolean | (() => boolean | Promise<boolean>);
  /** Where this engine runs, for the wallet providers that only work on some platforms. Default: web. */
  platform?: ProviderPlatform;
  /**
   * The profiles of this storage are never on several devices (WISP 06 § Goals and non-goals): the CLI, whose profiles
   * are always `single`. No device state database is made or read for them. Default: off.
   */
  singleDevice?: boolean;
  /**
   * Start in limited mode (WISP 06 § When a device checks): the device could not read which device is active, and the
   * person chose "Start anyway". It is the profile offline: history can be read and messages written, which wait.
   * Nothing is published, nothing is dialled, nothing is settled in hold storage, no wallet is opened and no admin
   * work is done, until `leaveLimited()` is called after the first good read. Default: off.
   */
  limited?: boolean;
  /**
   * This app stays online, so it offers to be a hub of the private groups past 16 members it is in (WISP 9xx · Group
   * Mesh § Hubs). Default: the Desktop app; the CLI says so itself; a browser tab only when the admin pins it.
   */
  staysOnline?: boolean;
  /**
   * Tests only: group links behave as before they could go native (WISP 9xx § Transports): WebRTC alone, no `_tr` read
   * or published, no native endpoint. A compatibility test runs this app as one from before against a current one.
   */
  webrtcGroupLinks?: boolean;
  /**
   * The most WebRTC connections this app's groups and 1:1 chats hold at once (WISP 9xx · Group Mesh § Hubs, Budget):
   * within it, the app is a hub of a private group only while that fits, and a group opens only the edges that fit.
   * Default: none. The Desktop app on a Mac says 40: WKWebView opens about 46 in one page, and the rest stay for calls.
   */
  peerBudget?: number;
  /** The Lightning and on-chain providers on offer. Default: the registry (tests pass their own). */
  providers?: ProviderRegistry;
  /** Desktop: the Tauri commands the providers that need them call (see `ProviderHost.invoke`). */
  invoke?: ProviderHost["invoke"];
  /** The Fedimint client. Default: the browser's (a module worker, the origin-private file system); the CLI passes its Node one, tests a fake. */
  fedimintSdk?: () => Promise<FedimintSdk>;
  /**
   * Whether paired chats offer `services/1`: this app serves granted local web apps and opens a contact's.
   * Default: everywhere but the web app, which can do neither (a tab has no way to reach localhost).
   */
  servicesSupport?: boolean;
  /**
   * Whether paired chats offer `calls/1`. Default: where the page has WebRTC. Ghostly Desktop on Linux says
   * itself: its calls run in GStreamer, and when that is missing, `callsUnavailable` says what to install.
   */
  callsSupport?: boolean;
  callsUnavailable?: string;
  /**
   * Leave the groups' sessions (edges, entry sessions, the admission and community timers) unstarted: a headless
   * one-shot that only talks to one chat, whose relay budget they would spend in seconds. What is stored stays as it is.
   */
  deferGroups?: boolean;
  /**
   * Posts a wake-up to a contact's push service (WISP 401 § Wake-up push) and answers its HTTP status. Default:
   * `fetch` from here, and when that is refused (a browser page: push services answer without CORS) the push
   * relay in the settings. Ghostly Desktop posts from Rust; the CLI's `fetch` has no CORS to refuse it.
   */
  pushSend?: (request: PushRequest) => Promise<number>;
}

export interface NodeEvents {
  onAttention?(event: AttentionEvent): void;
  onState(state: EngineState): void;
  onMessages(linkId: string, messages: StoredMessage[]): void;
  /** Only what changed in a chat's or group's history; without it, `onMessages` gets the whole history on each change. */
  onMessageChanges?(linkId: string, changes: MessageChanges): void;
  onCallSignal(linkId: string, signal: string): void;
}

/**
 * The Ghostly peer running in this browser: every link, the services it
 * shares, and the glue to IndexedDB. It owns nothing durable on the network;
 * when it stops, the peer is gone.
 */
/** A waiting file or request that went out: it shows like any other from now on (a file by its transfer). */
/** The contact's typing as the chat shows it: plain typing needs only `peerTyping`. */
function typingView(activity: TypingActivity | null): Pick<LinkView, "peerTyping" | "peerTypingKind" | "peerTypingStatus"> {
  return {
    peerTyping: true,
    ...(activity && activity.kind !== "typing" ? { peerTypingKind: activity.kind } : {}),
    ...(activity?.status ? { peerTypingStatus: activity.status } : {}),
  };
}

function sentNow(message: StoredMessage): StoredMessage {
  const { delivery: _delivery, deliveryError: _error, resendUntil: _until, ...sent } = message;
  return sent;
}

/** What a call refused in limited mode is answered with. */
export const LIMITED_MODE_ERROR = "Ghostly could not check which device is active yet. This works once it can.";

/**
 * What the pages may call in limited mode (WISP 06 § When a device checks): reading history, writing messages (they
 * wait), and the settings. Everything else is refused, whatever it would do: every wallet and payment call (no
 * wallet is opened), every group change (no admin work), every new chat, join, call and identity change (nothing is
 * dialled or published). A list of what is allowed, so a method added later is refused until someone decides.
 */
export const LIMITED_MODE_METHODS: ReadonlySet<string> = new Set<keyof EngineApi>([
  "setActiveLink", "renameLink", "updateSettings", "disconnect",
  "sendMessage", "editMessage", "retryMessage", "deleteMessage", "react", "pinMessage", "forwardMessages", "messageDetails", "messagePage",
  "sendGroupMessage", "groupMessages", "statusCardIndex", "setTyping", "setGroupTyping", "setFastPoll", "exportLinks", "walletBackupReminder",
]);

/** Thrown by the transport when something tries to publish in limited mode: a bug in a switch point, never a wait. */
export class LimitedModeError extends Error {
  constructor() {
    super("Nothing is published before the turn was read (limited mode)");
    this.name = "LimitedModeError";
  }
}

/**
 * The transport with every publish refused while `limited()` says so. The engine's own switches keep it from
 * trying; this is the one place that cannot be forgotten, since every Pkarr record of a profile goes through it.
 */
function refusingWhileLimited(transport: PkarrTransport, limited: () => boolean): PkarrTransport {
  const publish = transport.publish.bind(transport);
  transport.publish = (identity, records, options) => (limited() ? Promise.reject(new LimitedModeError()) : publish(identity, records, options));
  const publishPayload = transport.publishPayload?.bind(transport);
  if (publishPayload) transport.publishPayload = (pubKeyZ32, payload, options) => (limited() ? Promise.reject(new LimitedModeError()) : publishPayload(pubKeyZ32, payload, options));
  return transport;
}

export class GhostlyNode implements EngineImplementation {
  private settings: Settings = DEFAULT_SETTINGS;
  /** Limited mode (`NodeOptions.limited`): on from the start until `leaveLimited()`. */
  private limitedMode = false;
  /** Whether this engine is in limited mode (WISP 06 § When a device checks). */
  get limited(): boolean { return this.limitedMode; }
  /**
   * Whether this engine may use the network for the profile: the person's own switch, and never in limited mode.
   * Everything that publishes, dials, polls or settles asks this, not the stored setting.
   */
  private get networkOn(): boolean { return !!this.settings.online && !this.limitedMode; }
  private readonly transport: PkarrTransport;
  /** The same, for groups' requests: a relay budget keeps a chat's share from them (`CHAT_RESERVE`). */
  private readonly groupTransport: PkarrTransport;
  private readonly relays: RelayTransport | null;
  /** Other profiles of this device, looked at for new messages (WISP 04 § Checking other profiles). */
  private readonly profilePeek: ProfilePeek;
  /** Whether this device's WebRTC attempts say direct connections are blocked on its network (`directPath.ts`). */
  private readonly directPath = new DirectPathWatch(() => { if (!this.shuttingDown) this.emitState(); });
  /** Whether this device's clock seems to be off, from what the relays' answers and several contacts' packets say (`clockWatch.ts`). */
  private readonly clock = new ClockWatch(() => { if (!this.shuttingDown) this.emitState(); });
  private clockOff: (() => void) | undefined;
  /**
   * Edges of groups whose WebRTC did not connect in this run of the app (`edgeWithoutRtc`): they go on as an app with
   * no WebRTC does, over a native transport. Not kept: the next start tries WebRTC first again.
   */
  private readonly edgeRtcOff = new Set<string>();
  private readonly pollIntervals: PollIntervals;
  private readonly localFetch: LocalFetch;
  private readonly links = new Map<string, LiveLink>();
  private services: StoredService[] = [];
  private activeLinkId: string | null = null;
  /**
   * Native listeners start one at a time per transport (`ensureNativeEndpoints`): their slots are counted per transport.
   * Not one queue for all: a transport slow to start held every other chat's listeners of every kind behind it.
   */
  private readonly nativeQueues = new Map<NativeTransport, Promise<void>>();
  /** Every listener start asked for so far has ended. */
  private get nativeQueue(): Promise<void> { return Promise.all(this.nativeQueues.values()).then(() => {}); }
  private shuttingDown = false;
  /** `start` has put the kept transfers back (EngineState.transfersRestored). */
  private transfersRestored = false;
  private readonly feedbackStartedAt = Date.now();
  private readonly feedbackIds = new Set<string>();
  private walletFeedbackReady = false;
  private readonly walletFeedbackIds = new Set<string>();
  /** `cue`: a finer sound the page plays instead of the event's own when its category is on (apps/ui/src/lib/cues.ts). */
  private feedback(type: AttentionEvent["type"], id: string, linkId?: string, mention = false, cue?: AttentionCue) {
    const key = type + ":" + id;
    if (this.feedbackIds.has(key)) return;
    this.feedbackIds.add(key);
    this.events.onAttention?.({type, id:key, at:Date.now(), ...(linkId ? {linkId} : {}), ...(mention ? {mention:true} : {}), ...(cue ? {cue} : {})});
  }
  /** A fact that had no sound before the sound categories: its cue is its only sound (engine/cues.ts). */
  private cueFeedback({ cue, key }: Cue, linkId?: string) {
    this.feedback("cue", cue + ":" + key, linkId, false, cue);
  }
  /** The newest time written in each chat while this engine runs: a message written well before it is a catch-up. */
  private readonly newestAt = new Map<string, number>();
  /** The last place given in each chat while this engine runs (`arrivalKey`). */
  private readonly placedAt = new Map<string, number>();
  /**
   * Each 1:1 chat's contact: how far the time its latest live messages said was from when they came (`CLOCK_SAMPLES`
   * of them). What tells a contact's clock that is behind from a message that is late (`writtenAt`).
   */
  private readonly clockLeads = new Map<string, number[]>();
  /** A contact's row came on the live session of a 1:1 chat: what it says of the contact's clock is kept. */
  private clockSample(message: StoredMessage): void {
    if (message.sender !== "peer" || message.sentAt === undefined || message.event || message.via !== "datalink" || message.linkId.startsWith("group:")) return;
    this.clockLeads.set(message.linkId, [...(this.clockLeads.get(message.linkId) ?? []), message.sentAt - message.timestamp].slice(-CLOCK_SAMPLES));
  }
  /** Only a new message, or mine going out, says anything (engine/attention.ts): judged by when it was written. */
  private messageFeedback(type: "message" | "sent", message: StoredMessage, newest = this.newestAt.get(message.linkId)) {
    const attention = messageAttention(type, { ...message, timestamp: writtenAt(message, this.clockLeads.get(message.linkId)) }, { startedAt: this.feedbackStartedAt, newest, now: Date.now() });
    if (attention) this.feedback(attention.type, message.linkId + ":" + message.id, message.linkId, attention.mention, attention.cue);
  }
  /**
   * The chat a link's facts belong to, as the pages mute it: a group member's edge, or a community member's
   * payment link, files them in the group (as `storeMessage` does); any other link is its own chat.
   */
  private chatOf(linkId: string | undefined): string | undefined {
    if (!linkId) return undefined;
    const edge = this.links.get(linkId)?.stored;
    if (edge?.group && edge.groupPeer && !edge.groupEntry) return `group:${edge.group}`;
    const pay = parsePayLink(linkId);
    return pay ? `group:${pay.groupId}` : linkId;
  }
  /** The next chat's keys, warmed on the network ahead of time (`takeInvite`). */
  private spare: SpareInvite | null = null;
  private spareTimer: ReturnType<typeof setTimeout> | null = null;
  /** Keys this engine warmed with an empty packet, and when. */
  private readonly warmedKeys = new Map<string, number>();
  private readonly outboxes = new Map<string, Outbox>();
  /** My edits on their way, per 1:1 chat (WISP 400 § Edits). */
  private readonly editQueues = new Map<string, EditQueue>();
  /** The contacts' edits of messages not here yet. */
  private readonly editBuffer = new EditBuffer();
  /** Received status card updates, applied at most once a second per message (WISP 4xx · Status Cards). */
  private readonly cardEdits = new CardEditPacer();
  /** When each message's buttons were last pressed here (`pressButton`). */
  private readonly pressedAt = new Map<string, number>();
  /** At most one wake-up per contact per `WAKE_INTERVAL_MS` (WISP 401 § Wake-up push). */
  private readonly wakeLimiter = new WakeLimiter();
  /** Call wake-ups have their own, shorter limit: a call is rarer than a message and cannot wait five minutes. */
  private readonly callWakeLimiter = new WakeLimiter(WAKE_CALL_INTERVAL_MS);
  /** Mentions in private groups: one per member per 5 minutes, four per group per minute (WISP 9xx · Group Mesh § Wake-up push). */
  private readonly groupWakeLimiter = new GroupWakeLimiter();
  /** `group-wake` frames read per edge, a handful a minute. */
  private readonly groupWakeReceived = new Map<string, RateWindow>();
  private readonly requestCounts = new Map<string, number>();
  private readonly transfers = new Map<string, FileTransferView>();
  /** files/3 in every chat: offers, resumable transfers, checked by digest (WISP 501 rev 0.3). */
  private readonly fileDesk = new FileDesk({
    send: (linkId, frame) => this.links.get(linkId)?.link?.sendFilesFrame(frame) ?? false,
    writable: (linkId) => this.links.get(linkId)?.link?.filesWritable(),
    receivedBytes: (linkId) => this.links.get(linkId)?.files.receivedBytes ?? 0,
    wireIds: (linkId) => this.links.get(linkId)?.files.wireIds,
    deleted: (linkId, messageId) => !!this.links.get(linkId)?.stored.deletedIds?.includes(messageId),
    messageExists: (linkId, messageId) => db.hasMessage(linkId, messageId),
    storeMessage: (message) => this.storeMessage(message),
    transfers: this.transfers,
    changed: (delayMs) => this.emitState(delayMs),
    flush: () => this.flushState(),
    settled: (linkId, fileId, record, seen) => {
      if (seen && record.direction === "in" && record.state === "done") this.cueFeedback({ cue: "downloaded", key: fileId }, this.chatOf(linkId));
      void this.noteFileEnd(linkId, fileId, record.state === "done" ? undefined : record.error ?? record.state);
    },
  });
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private paymentTimer:ReturnType<typeof setTimeout>|null=null;
  /** Every minute, the reviews no Approve can send any more are cancelled (dropStaleReviews). */
  private staleReviewTimer?: ReturnType<typeof setInterval>;
  /** Group links: admins read knocks, joiners knock (WISP 9xx § Entry link). */
  private groupEntryTimer: ReturnType<typeof setInterval> | null = null;
  private walletView: WalletView = { mints: [], balance: 0, history: [], feesPaid: 0 };
  /** A new profile's default Mainnet wallets, made once in the background (`NodeOptions.defaultWallets`). */
  private readonly walletSetup = new WalletSetup({
    record: () => this.settings.walletSetup,
    save: async (record) => { this.settings = { ...this.settings, walletSetup: record }; await db.putSettings(this.settings); },
    offer: async (type) => { await this.refreshWallet(); return this.walletView.offers?.find((o) => o.type === type && o.network === SETUP_NETWORK); },
    create: async (type) => { await this.walletCreate({ type, network: SETUP_NETWORK }); },
    changed: () => { this.walletView = { ...this.walletView, setup: this.walletSetup.view() }; this.emitState(); },
  });

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
    // With the intent's own save: a payment that never reached the mint is marked abandoned before its sats come back.
    reconcile:(review,prepared,persist)=>{
      if(!persist)throw new Error("A Cashu payment is reconciled with its intent saved");
      return new CashuAdapter(this.wallet,(r,t)=>this.desk.recordCashu(r,t)).reconcile(review,prepared as CashuPrepared,persist);
    },
  }], (review) => {
    if (review.state === "settled") this.feedback("confirmed", review.id);
    if (review.state === "failed") this.cueFeedback({ cue: "failed", key: review.id }, this.chatOf(review.linkId));
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
  /**
   * The Lightning cards of each network, each through its own source (the Cashu mints, a node, a wallet connection).
   * A payment goes through the card picked for it; a request's invoice comes from the network's default for receiving.
   */
  private readonly lightnings: PerNetwork<LightningCards> = perNetwork((network) => new LightningCards(network, {
    descriptors: () => this.providers().lightning,
    host: () => this.providerHost(network),
    hasMints: () => this.networkMints(network).length > 0,
    events: {
      changed: () => void this.refreshWallet(),
      received: (op) => void this.desk.onLightningPaid(op),
      resolved: (op, paid) => void this.desk.onLightningResolved(op, paid),
    },
  }));
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
    groupLinks: (groupId) => this.groups.isCommunityGroup(groupId) ? [groupLinkId(groupId)] : [...this.memberEdges(groupId).values()],
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
        const cue = paymentCue(payment, this.feedbackStartedAt);
        if (cue) this.cueFeedback(cue, this.chatOf(payment.group ? `group:${payment.group}` : payment.linkId));
      }
      void this.groupPayments.sync().catch(() => {});
      this.awaitingSoon();
      this.emitState();
    },
    defaultNetwork: () => "mainnet",
  }, this.arkWallets, this.usdtWallets, this.barkWallets, perNetwork((network) => ({
    createInvoice: async (amount: number, paymentId: string, card?: string) => (await this.lightningCard(network, card)).createInvoice(amount, { paymentId }),
    quote: async (invoice: string, card?: string) => { const quote = await (await this.lightningCard(network, card)).quote(invoice); return { ...quote, mint: quote.source === CASHU_MINT_SOURCE ? quote.mint : undefined }; },
    pay: (quote: { quote: string }, note: string, paymentId: string) => this.lightningQuote(network, quote.quote).pay(quote.quote, { note, paymentId }),
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
      // Limited mode settles nothing in hold storage: with no storage the hold engine puts, reads and deletes nothing.
      if (this.limitedMode) return null;
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
      const message = await db.getMessage(linkId, messageId);
      if (message?.file) this.transfers.set(message.file.id, state === "failed" ? { state: "failed", transferred: 0, size: message.file.size, error } : { state: "done", transferred: message.file.size, size: message.file.size });
      if (message && state !== "failed") this.messageFeedback("sent", message);
      await this.messagesChanged(linkId, [messageId]);
      this.emitState();
    },
    text: async (linkId, messageId) => (await db.getMessages(linkId)).find((m) => m.id === messageId)?.text ?? null,
    reply: async (linkId, messageId) => {
      const message = (await db.getMessages(linkId)).find((m) => m.id === messageId);
      return message && GhostlyNode.wireReply(message);
    },
    forwarded: async (linkId, messageId) => (await db.getMessages(linkId)).find((m) => m.id === messageId)?.forwarded,
    file: async (fileId) => {
      const stored = await fileStore.get(fileId);
      if (!stored?.metadata) return null;
      // A held file is at most 8 MiB: whole in memory while it is sealed.
      return { bytes: await readStored(stored, 0, storedSize(stored)), name: stored.metadata.name, size: stored.metadata.size, mime: stored.metadata.mime, voice: stored.metadata.voice, video: stored.metadata.video, image: stored.metadata.image };
    },
    paymentRequest: (paymentId): PaymentRequest | null => this.desk.requestFor(paymentId),
    receiveText: (linkId, message, held) => this.storeMessage({ linkId, id: `peer_${message.id}`, text: message.text, sender: "peer", timestamp: message.timestamp, via: "hold",
      ...(message.reply && { replyTo: receivedPairedReply(message.reply) }), ...(message.forwarded && { forwarded: message.forwarded }),
      details: { wire: { frame: "GHLD bundle", protocol: "hold/1", plaintextBytes: utf8Encode(message.text).length, ...(held && { wireBytes: held.bytes }) }, ...(held && { hold: held }) } }),
    receiveFile: async (linkId, wire, bytes, digest, held) => {
      const live = this.links.get(linkId);
      if (!live) return "unknown chat";
      if (live.files.wireIds.has(wire.wireId)) return "duplicate file id";
      if (live.files.receivedBytes + wire.size > LIMITS.maxStoredIncomingBytesPerPeer) return "no room for more files";
      const file: MessageFile = { id: `${linkId}-in-${toBase64Url(randomBytes(12))}`, name: wire.name, size: wire.size, mime: wire.mime, ...(wire.voice && { voice: wire.voice }), ...(wire.video && { video: wire.video }), ...(wire.image && { image: wire.image }) };
      if (live.stored.deletedIds?.includes(`peer_${wire.wireId}`)) return null;
      live.files.wireIds.add(wire.wireId);
      live.files.receivedBytes += wire.size;
      // The bytes first, then the message that shows them: a message never points at a file that is not there.
      await fileStore.put({ id: file.id, linkId, blob: new Blob([bytes as BlobPart], { type: safeBlobType(file.mime) }), createdAt: Date.now(), direction: "in", wireId: wire.wireId, digest,
        metadata: { name: wire.name, size: wire.size, mime: wire.mime, timestamp: wire.timestamp, voice: wire.voice, video: wire.video, image: wire.image }, transfer: { state: "done", transferred: wire.size, size: wire.size } });
      this.transfers.set(file.id, { state: "done", transferred: wire.size, size: wire.size });
      await this.storeMessage({ linkId, id: `peer_${wire.wireId}`, text: fileMessageText(file), sender: "peer", timestamp: wire.timestamp, via: "hold", file,
        ...(wire.reply && { replyTo: receivedPairedReply(wire.reply) }), ...(wire.forwarded && { forwarded: wire.forwarded }),
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
      const before = this.links.get(linkId)?.stored.identities;
      const identities = await db.updateIdentities(linkId, change);
      for (const cue of identityCues(before, identities)) this.cueFeedback(cue, linkId);
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
    online: () => this.networkOn,
    emit: () => { this.emitState(); this.did.changed(); void this.publicProfiles.prune().catch(() => {}); this.publicActivity.prune(); },
    publicProfile: (provider, subject) => this.publicProfiles.view({ provider, subject }),
    publish: (seed, records) => this.transport.publish(identityFromSeed(seed), records),
    resolve: async key => (await this.transport.resolve(key))?.records ?? null,
  });

  /** The profile's did:dht: a key of its own, public, never tied to a chat (WISP 3xx-did-dht). */
  readonly did = new ProfileDid({
    online: () => this.networkOn,
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
    online: () => this.networkOn,
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
    online: () => this.networkOn,
    emit: () => this.emitState(),
    eligible: () => this.profileSubjects(),
    nostrRelays: () => effectiveNostrSettings(this.settings.nostr).relays,
  });

  /** A contact's verified identity's posts and follows, asked when its card is chosen (PUBLIC-PROFILES.md, "Posts and follows"). */
  private readonly publicActivity = new PublicActivity({
    enabled: () => this.settings.publicProfiles !== false,
    online: () => this.networkOn,
    eligible: () => this.profileSubjects(),
    nostrRelays: () => effectiveNostrSettings(this.settings.nostr).relays,
    own: () => { const t = Math.floor(Date.now() / 1000); return this.identities.views().filter(p => p.expiresAt > t).map(p => ({ provider: p.provider, subject: p.verified.subject })); },
    contacts: () => this.contactSubjects(),
    ownNostrFollows: () => this.nostrSocial.ownFollows(),
    nostrMuted: (note, author) => this.nostrSocial.hides(note, author),
  });

  /** What contacts shared that verifies now, with the chat it came in (paired chats only). */
  private contactSubjects(): (ProfileSubject & { linkId: string })[] {
    const t = Math.floor(Date.now() / 1000);
    const out: (ProfileSubject & { linkId: string })[] = [];
    for (const live of this.links.values()) {
      const stored = live.stored;
      if (!stored.profile || !stored.identities || stored.group) continue;
      const mine = stored.participationSeed ? identityFromSeedB64(stored.participationSeed).pubKeyZ32 : undefined;
      for (const r of stored.identities.received)
        if (receivedIdentityStatus(r, stored.pairedPeerKey, mine, t) === "verified") out.push({ provider: r.binding.provider, subject: r.verified.subject, linkId: stored.id });
    }
    return out;
  }

  /** Every identity whose public profile may be shown: the profile's own current proofs, and what contacts shared that verifies now. */
  private profileSubjects(): ProfileSubject[] {
    const t = Math.floor(Date.now() / 1000);
    const out: ProfileSubject[] = this.identities.views().filter(p => p.expiresAt > t).map(p => ({ provider: p.provider, subject: p.verified.subject }));
    for (const c of this.contactSubjects()) out.push({ provider: c.provider, subject: c.subject });
    return out;
  }

  /**
   * Reactions to messages (WISP 400 § Reactions), kept on their rows. `reactionNotes`: each chat's latest, for the
   * chat list. `reactionsSent`: when each reaction was said on this session, per link: a flush says only the new ones, and
   * again those not confirmed after a while.
   */
  private readonly reactionNotes = new Map<string, ReactionNote>();
  private readonly reactionsSent = new Map<string, Map<number, number>>();
  private readonly reactionPace = new Map<string, ReactionWindow>();
  private readonly reactionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** A pin said on the live session and not confirmed yet is said again when this fires, per link. */
  private readonly pinTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The WebRTC connections of 1:1 chats, kept (with a budget only) until closed: they count against `peerBudget`. */
  private readonly chatPeers = new Set<RTCPeerConnection>();
  private chatPeer(pc: RTCPeerConnection): RTCPeerConnection {
    if (this.options.peerBudget !== undefined) this.chatPeers.add(pc);
    return pc;
  }
  /** The 1:1 chats' connections not closed yet (`close()` fires no event, so this looks at each). */
  private openChatPeers(): number {
    for (const pc of this.chatPeers) if (pc.connectionState === "closed") this.chatPeers.delete(pc);
    return this.chatPeers.size;
  }
  private readonly reactions = new Reactions({
    messages: chat => db.getMessages(chat),
    message: (chat, id) => db.getMessage(chat, id),
    patch: (chat, id, change) => db.patchMessage(chat, id, change),
    changed: async (chat, id, note) => {
      if (note) this.reactionNotes.set(chat, note);
      await this.messagesChanged(chat, [id]);
      this.emitState();
    },
    // Someone reacted to a message of mine: a quiet notice, never a message's sound or an unread count.
    notify: (chat, key) => this.feedback("reaction", `${chat}:${key}`, chat),
  });

  /** Private groups (WISP 900): sessions, admission on contact chats, and the pairwise edges that carry them. */
  private readonly groups = new Groups({
    sendOnLink: (linkId, frame) => {
      const live = this.links.get(linkId);
      if (!live?.link) throw new Error("You are offline");
      // An edge to someone out of the roster carries the commits up to the one that took them out, and nothing else.
      const { group, groupPeer, groupEntry } = live.stored;
      if (group && groupPeer && !groupEntry && !this.groups.edgeAllows(group, groupPeer, frame)) return;
      live.link.sendGroupFrame(frame);
    },
    linkReady: (linkId, version = 1) => !!this.links.get(linkId)?.link?.supportsGroupVersion(version),
    linkOpen: linkId => !!this.links.get(linkId)?.link?.isDataLinkOpen,
    myNick: () => this.sharedNick,
    // An app with no WebRTC (the Linux Desktop) reaches members over native listeners, a few of them
    // (`GROUP_NATIVE_SLOTS`): it does not offer to be a private group's hub, which keeps an edge with everyone.
    staysOnline: () => this.options.staysOnline ?? (this.options.platform === "desktop" && typeof RTCPeerConnection !== "undefined"),
    peerRoom: groupId => {
      // With no WebRTC, a group's links are native ones, and all the groups together hold `GROUP_NATIVE_SLOTS` at most.
      if (typeof RTCPeerConnection === "undefined" && Object.keys(this.nativeFactories).length) {
        let held = 0;
        for (const live of this.links.values()) if (live.stored.group && live.stored.group !== groupId && live.link) held++;
        return Math.max(0, GROUP_NATIVE_SLOTS - held);
      }
      const budget = this.options.peerBudget;
      if (budget === undefined) return undefined;
      // Every other group's edges and entry sessions that run, one connection each, and the 1:1 chats' on WebRTC: a
      // call finds room only in what is left, so chats count in full here, not in the room kept for calls.
      let held = this.openChatPeers();
      for (const live of this.links.values()) if (live.stored.group && live.stored.group !== groupId && live.link) held++;
      return budget - held;
    },
    contactName: linkId => { const stored = this.links.get(linkId)?.stored; return stored?.label || stored?.peerNick || undefined; },
    edges: groupId => this.groupEdges(groupId),
    entries: groupId => {
      const entries = new Map<string, string>();
      for (const live of this.links.values()) if (live.stored.group === groupId && live.stored.groupPeer && live.stored.groupEntry) entries.set(live.stored.groupPeer, live.stored.id);
      return entries;
    },
    openEntry: (link, role, seedB64, peer) => this.openEntry(link, role, seedB64, peer),
    linkSeen: linkId => { const live = this.links.get(linkId); return otherEndSeen(live?.presence, live?.dataLink); },
    // Its packet is newer than the moment the edge was last up (when this device first read it, so both times are this clock's).
    linkBack: linkId => { const live = this.links.get(linkId); return !!live?.lastSyncAt && !!live.presence?.online && presenceSeenAt(live.presence) > live.lastSyncAt; },
    publish: (identity, records, background) => this.groupTransport.publish(identity, records, { background }),
    resolve: async (pubKeyZ32, background, door) => (await this.groupTransport.resolve(pubKeyZ32, { background, door }))?.records ?? null,
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
    storeMessage: message => this.storeNewMessage(message),
    completeMessage: message => this.completeGroupMessage(message),
    membersChanged: groupId => this.groupMembersChanged(groupId),
    historyGone: groupId => this.groupHistoryGone(groupId),
    emit: () => this.emitState(),
    communityApp: (groupId, sender, frame) => frame.t === COMMUNITY_REACTION_FRAME ? this.receiveGroupReaction(groupId, sender, frame)
      : frame.t === COMMUNITY_EDIT_FRAME ? this.receiveCommunityEdit(groupId, sender, frame)
      : frame.t === COMMUNITY_PIN_FRAME ? this.receiveGroupPin(groupId, sender, readPin(frame))
      : this.communityPay.receiveApp(groupId, sender, frame),
    groupEdit: async (groupId, { sender, ...edit }) => { await this.groupEdits.receive(groupId, sender, edit); },
    groupReaction: (groupId, member, reaction) => this.receiveGroupReaction(groupId, member, reaction),
    groupPin: (groupId, from, { member, pin, frame }) => this.receiveGroupPin(groupId, member, pin, { from, frame }),
    // My latest edits, again, to a member whose edge opened: a private group has no catch-up for them. The group's pin too.
    edgeUp: (groupId, peer) => { void this.groupEdits.resend(groupId, peer).catch(() => {}); this.sendGroupPinFrame(groupId, peer); },
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

  /**
   * Edits in groups (WISP 9xx § Edits): mine said to the group at the pace allowed, the members' on their messages.
   * Never a new message: no sound, no unread.
   */
  private readonly groupEdits = new GroupEdits({
    messages: chat => db.getMessages(chat),
    message: (chat, id) => db.getMessage(chat, id),
    patch: (chat, id, change) => db.patchMessage(chat, id, change),
    changed: (chat, id) => this.messagesChanged(chat, [id]),
    membership: groupId => {
      const membership = this.membership(groupId);
      return membership && { ...membership, community: this.groups.isCommunityGroup(groupId), admin: !!this.groups.views().find(g => g.id === groupId)?.isAdmin };
    },
    send: (groupId, edit, to) => this.groups.sendEdit(groupId, edit, to),
  });

  /** A community member's edit, signed by them: of their own message, and only while they are a member. */
  private async receiveCommunityEdit(groupId: string, sender: string, frame: Record<string, unknown>): Promise<void> {
    const edit = parseCommunityEdit(frame, sender);
    if (edit) await this.groupEdits.receive(groupId, sender, edit);
  }

  /** My key in an active group, and who is in it. */
  private membership(groupId: string): { me: string; members: ReadonlySet<string> } | undefined {
    const group = this.groups.views().find(g => g.id === groupId);
    return group?.status === "active" && group.myKey ? { me: group.myKey, members: new Set(group.members.map(m => m.key)) } : undefined;
  }

  /** The link payments with `linkId` go over: a chat's or an edge's, or a community member's through the group. */
  private paymentLink(linkId: string) { return this.outsideEdge(linkId) ? null : this.links.get(linkId)?.link ?? this.communityPay.link(linkId); }

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
    edges: groupId => this.groups.isCommunityGroup(groupId) ? new Map([["*", groupLinkId(groupId)]]) : this.memberEdges(groupId),
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
      // A note is written again as its payment moves on: it keeps the place it took when it first came here, and a
      // member's takes that place as any received row does, never the time the member's clock said.
      const kept = await db.getMessage(message.linkId, message.id);
      await db.putMessage(kept ? { ...message, timestamp: kept.timestamp, ...(kept.sentAt !== undefined && { sentAt: kept.sentAt }) } : this.placed(message));
      await this.messagesChanged(message.linkId, [message.id]);
      this.emitState();
    },
  });

  /**
   * Member key → edge link id, for the edges of a group that exist (open or not), whoever is at the other end: an edge
   * outlives its member's place in the roster for a moment, or for as long as it is kept to tell it (`StoredGroup.farewells`).
   * For the group engine alone, which opens and closes them. Whatever is said to the group goes over `memberEdges`.
   */
  private groupEdges(groupId: string): Map<string, string> {
    const edges = new Map<string, string>();
    for (const live of this.links.values()) if (live.stored.group === groupId && live.stored.groupPeer && !live.stored.groupEntry) edges.set(live.stored.groupPeer, live.stored.id);
    return edges;
  }

  /** The edges of a private group to its members as the roster has them now: the only ones the group's traffic goes over. */
  private memberEdges(groupId: string): Map<string, string> {
    const edges = this.groupEdges(groupId);
    for (const key of [...edges.keys()]) if (!this.groups.inRoster(groupId, key)) edges.delete(key);
    return edges;
  }

  /** An edge of a private group to someone its roster no longer has: it says no name and no picture of mine. */
  private quietEdge(stored: StoredLink | undefined): boolean {
    return !!stored && this.meshEdge(stored) && this.groups.outsider(stored.group!, stored.groupPeer!);
  }
  /** Edges that said no name while their other end was out of the roster: the name is said again once it is back in. */
  private readonly quietEdges = new Set<string>();
  /** A group's roster changed: an edge kept to someone now out of it (closed, waiting for them) stops carrying my name. */
  private quietOutsideEdges(groupId: string): void {
    for (const live of this.links.values()) {
      if (live.stored.group !== groupId || !live.link || !this.meshEdge(live.stored)) continue;
      const id = live.stored.id;
      if (this.quietEdge(live.stored)) {
        // One still open closes in a moment (its last commit is on its way): nothing more is said on it, not even this.
        if (!this.quietEdges.has(id) && !live.link.isDataLinkOpen) { this.quietEdges.add(id); live.link.setNick(undefined); }
      } else if (this.quietEdges.delete(id)) live.link.setNick(this.sharedNick);
    }
  }

  /** An edge of a private group whose other end is not in its roster: nothing of the group goes over it but what the group engine says. */
  private outsideEdge(linkId: string): boolean {
    const stored = this.links.get(linkId)?.stored;
    return !!stored && this.meshEdge(stored) && !this.groups.inRoster(stored.group!, stored.groupPeer!);
  }

  constructor(
    private readonly events: NodeEvents,
    private readonly options: NodeOptions = {},
  ) {
    // Relays are a setting only where relays are the transport.
    this.relays = options.transport ? null : new RelayTransport();
    this.limitedMode = options.limited === true;
    this.transport = refusingWhileLimited(options.transport ?? this.relays!, () => this.limitedMode);
    this.groupTransport = withRequestOptions(this.transport, { group: true });
    this.profilePeek = new ProfilePeek({ transport: this.transport, direct: !!this.transport.configure, online: () => this.networkOn,
      // A CLI profile is always `single` (WISP 06 § Goals and non-goals): no device state database is made for it.
      ...(options.singleDevice ? { runsHere: async () => true } : {}),
      readPath: () => readPathOf(this.relays ? { relays: this.relays.describe().relays } : this.settings, !!this.transport.configure) });
    this.pollIntervals = options.pollIntervals ?? RELAY_POLL_INTERVALS;
    this.localFetch = options.localFetch ?? webLocalFetch;
    (this.hold as unknown as { host: { transport: PkarrTransport } }).host.transport = this.transport;
    // A relay that trips or recovers shows in the connection panel's Details.
    this.transport.subscribe?.(() => this.emitState());
    this.clockOff = this.transport.onServerTime?.(time => this.clock.server(time.source, time.date, time.sent, time.received));
  }

  /** The Desktop reaches the DHT itself: the relays in Settings are written to, and read from only when the person chose so. */
  private configureDirect(): void {
    this.transport.configure?.({ relays: this.settings.relays, readRelays: this.settings.readRelays === true });
  }

  /**
   * What each network's wallets still wait for (see `walletAwaiting`): open requests and invoices, paid invoices not
   * claimed yet, ecash sent and not taken. Read from the Cashu quotes, the Lightning journals and the payments.
   */
  /** What each network's wallets still wait for, and each mint on its own (`mints`, only the mints that wait for something). */
  private async readAwaiting(): Promise<{ networks: Record<WalletNetwork, WalletAwaitingView[]>; mints: Map<string, WalletAwaitingView[]> }> {
    const quotes = await this.wallet.quotes(), payments = this.desk.records(), now = Date.now();
    const out = {} as Record<WalletNetwork, WalletAwaitingView[]>;
    const mints = new Map<string, WalletAwaitingView[]>();
    for (const network of WALLET_NETWORKS) {
      const lightning = this.lightnings[network];
      out[network] = walletAwaiting({ network, mints: this.networkMints(network), quotes, lightningOps: await lightning.list(), lightningSource: lightning.view?.providerId, lightningCard: lightning.receivingId, lightningOwner: (op) => lightning.owner(op), payments, now });
      for (const url of this.networkMints(network)) {
        const waits = mintAwaiting(url, { network, quotes, payments, now });
        if (waits.length) mints.set(url, waits);
      }
    }
    return { networks: out, mints };
  }

  /** A mint as the wallet page shows it, with what it still waits for when it does (asked about before it is removed). */
  private withWaits(mints: readonly MintView[], waits: Map<string, WalletAwaitingView[]>): MintView[] {
    return mints.map(({ awaiting: _, ...mint }) => (waits.has(mint.url) ? { ...mint, awaiting: waits.get(mint.url) } : mint));
  }

  private awaitingTimer?: ReturnType<typeof setTimeout>;
  /** A payment changed (a request made, paid or closed): what the wallets wait for is read again, soon. */
  private awaitingSoon(): void {
    if (this.shuttingDown || !this.walletView.networks) return;
    clearTimeout(this.awaitingTimer);
    this.awaitingTimer = setTimeout(() => void this.readAwaiting().then((awaiting) => {
      const networks = this.walletView.networks;
      if (this.shuttingDown || !networks) return;
      for (const network of WALLET_NETWORKS) networks[network] = { ...networks[network], mints: this.withWaits(networks[network].mints, awaiting.mints), awaiting: awaiting.networks[network] };
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
      networks[network] = { mints: this.withWaits(view.mints, awaiting.mints), balance: view.balance, history, feesPaid: history.reduce((sum, tx) => sum + tx.fee, 0),
        ark: this.arkWallets[network].view, bark: this.barkWallets[network].view, fedimint: this.fedimintWallets[network].view, spark: this.sparkWallets[network].view,
        usdt: this.usdtWallets[network].view, lightning: this.lightnings[network].view, lightnings: this.lightnings[network].views(), bitcoin: this.bitcoins[network].view, awaiting: awaiting.networks[network] };
    }
    const wallets = walletInstances(networks);
    // The flat fields are Mainnet's, for a caller from before wallets had their own network; `networks` has both.
    this.walletView = { ...networks.mainnet, networks, wallets, offers: this.walletOffers(networks, wallets), intents: (await intentRepository.list()).map((saved) => saved.review), setup: this.walletSetup.view() };
    this.announcePaymentNetworks(wallets);
    for (const tx of everything) {
      const fresh = !this.walletFeedbackIds.has(tx.id);
      this.walletFeedbackIds.add(tx.id);
      if (this.walletFeedbackReady && fresh && tx.amount > 0 && tx.timestamp >= this.feedbackStartedAt) {
        if (tx.kind === "lightning-in" || tx.kind === "ecash-in") this.feedback("coin", tx.id, undefined, false, tx.note === TEST_COINS_NOTE ? "testcoins" : undefined);
        if (tx.kind === "lightning-out") this.feedback("confirmed", tx.id);
      }
    }
    this.walletFeedbackReady = true;
    await this.observeBackups();
    this.emitState();
  }

  /** Whether this profile's settings are read: before that, a reminder saved would write the defaults over them. */
  private backupsLoaded = false;
  /** The backup reminders (shared/backupReminder): what the Mainnet balances change in them, saved when they do. */
  private async observeBackups(): Promise<void> {
    if (this.backupsLoaded) {
      const view = this.walletView;
      const { records, changed } = observeBalances(this.settings.backupReminders ?? {}, mainnetBalances(view.wallets ?? [], view.networks?.mainnet), Date.now());
      if (changed) await this.saveBackups(records);
    }
    this.walletView = { ...this.walletView, backupReminders: this.settings.backupReminders ?? {} };
  }
  private async saveBackups(records: BackupReminders): Promise<void> {
    this.settings = { ...this.settings, backupReminders: records };
    this.walletView = { ...this.walletView, backupReminders: records };
    await db.putSettings(this.settings);
  }
  /** A wallet's phrase shown or its backup file made (once it answered): a copy of it exists, its reminder is over. */
  private async copied<T>(type: WalletType, network: WalletNetwork | undefined, work: () => T | Promise<T>): Promise<T> {
    const result = await work();
    const net = this.net(network);
    if (net === "mainnet" && this.backupsLoaded) {
      await this.saveBackups(markBackedUp(this.settings.backupReminders ?? {}, { kind: "phrase", id: `${type}:${net}` }, Date.now()));
      this.emitState();
    }
    return result;
  }

  /** The backup reminder's "Later" on one Mainnet wallet, or a profile backup just made (see `EngineApi`). */
  async walletBackupReminder(params: { event: "later"; wallet: string } | { event: "profile" }): Promise<void> {
    const records = this.settings.backupReminders ?? {}, now = Date.now();
    if (params?.event === "profile") await this.saveBackups(markBackedUp(records, { kind: "profile" }, now));
    else if (params?.event === "later" && typeof params.wallet === "string") {
      const view = this.walletView;
      const held = mainnetBalances(view.wallets ?? [], view.networks?.mainnet).find((b) => b.id === params.wallet);
      if (!held) throw new Error("There is no such Mainnet wallet");
      await this.saveBackups(putOff(records, held.id, held.balance, now));
    } else throw new Error("Unknown backup reminder event");
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
    // A new profile has nothing stored yet. Its wallets come from the first-run setup (where the app runs it), or from
    // New; no mint is added by itself here.
    const stored = await db.getSettings();
    const fresh = Object.keys(stored).length === 0;
    this.settings = { ...DEFAULT_SETTINGS, ...stored };
    // A profile still on an old default list gets today's defaults: a relay added to them reaches everyone.
    this.settings.relays = currentRelays(this.settings.relays);
    this.relays?.setRelays(this.settings.relays);
    this.configureDirect();
    this.services = await db.getServices();
    this.backupsLoaded = true;
    await this.identities.load();
    this.identities.start();
    await this.did.load();
    // The DID provider refuses this profile's own did:dht as an external identity.
    setOwnDidSource(() => this.did.id);
    this.did.start();
    await this.nostrSocial.load();
    await this.publicProfiles.load();
    // Limited mode opens no wallet: they start when it is left (`leaveLimited`).
    if (!this.limitedMode) await this.startWallets();

    const history = new Map<string, StoredMessage[]>();
    for (const stored of await db.getLinks()) {
      if (!stored.group) await this.settleHistory(stored.id);
      const messages = stored.group ? [] : await db.getMessages(stored.id);
      const storedFiles = stored.group ? [] : await fileStore.listForLink(stored.id);
      // A file whose message still waits for the chat to be live never started: it goes then (`sendWaiting`), as it
      // would have without the restart, and shows no transfer until it does.
      const waiting = new Set(messages.flatMap(m => m.sender === "me" && m.delivery === "waiting" && m.file ? [m.file.id] : []));
      for (const file of storedFiles) if (file.transfer && !file.wire3 && !waiting.has(file.id)) this.transfers.set(file.id,
        file.transfer.state === "transferring" ? { ...file.transfer, state: "failed", error: "Transfer interrupted. Retry when connected." } : file.transfer);
      // files/3 transfers go on where they stopped, once the chat is live again.
      if (!stored.group) this.fileDesk.restore(stored.id, storedFiles);
      const files = linkFilesFrom(stored.id, storedFiles, messages);
      this.links.set(stored.id, newLiveLink(stored, messages[messages.length - 1]?.timestamp ?? 0, files));
      history.set(stored.id, messages);
      // What the contact's clock was when the chat was last live: its first message of this run is read by it.
      for (const message of messages.slice(-4 * CLOCK_SAMPLES)) this.clockSample(message);
      const note = latestReaction(messages);
      if (note) this.reactionNotes.set(stored.id, note);
      if (stored.profile && !stored.group) await this.outboxFor(stored.id).recover();
    }
    this.transfersRestored = true;
    for (const group of await db.getGroups()) await this.settleHistory(`group:${group.id}`);
    // Groups know their edges from the links above, and may add or drop some before anything dials.
    await this.groups.load();
    for (const group of this.groups.views()) {
      const note = latestReaction(await db.getMessages(`group:${group.id}`));
      if (note) this.reactionNotes.set(`group:${group.id}`, note);
    }
    // With the chats loaded, profiles of identities no longer verified can be told apart and dropped.
    this.publicProfiles.start();
    if (this.networkOn) for (const linkId of this.nativeStartOrder([...history.keys()])) {
      const messages = history.get(linkId)!;
      if (!this.links.has(linkId)) continue;
      this.startLink(linkId, messages);
      if (!this.links.get(linkId)?.stored.group) void this.refreshPublicProfiles({ linkId }).catch(() => {});
    }
    this.emitState();
    if (this.networkOn) { this.hold.start(); this.startGroupEntries(); this.prepareSpare(STARTUP_QUIET_MS); }
    if (!this.limitedMode) this.openStartedWallets(fresh);
  }

  /** Every wallet's stored state, loaded: the first half of what `start()` does for money. */
  private async startWallets(): Promise<void> {
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
    void this.dropStaleReviews();
    this.staleReviewTimer ??= setInterval(() => void this.dropStaleReviews(), 60_000);
    this.stopWatchingAdapters ??= onAdaptersChanged(() => { if (!this.shuttingDown) for (const network of WALLET_NETWORKS) { this.lightnings[network].refreshOffered(); this.bitcoins[network].refreshOffered(); } });
  }

  /** The wallets that exist, opened, and what was in flight looked at again: the second half. */
  private openStartedWallets(fresh: boolean): void {
    void this.pollPaymentStatus().catch(()=>{});
    // Federations joined before: opened (and the notes a contact sent that an interruption left unredeemed, redeemed).
    void Promise.all(WALLET_NETWORKS.map((n) => this.fedimintWallets[n].ensureReady())).then(() => this.desk.resumeFedimint());
    for (const network of WALLET_NETWORKS) {
      // The Lightning and Bitcoin sources the person set up (the Cashu mints need no network to connect).
      void this.lightnings[network].recover().then(() => this.lightnings[network].ensureReady());
      void this.bitcoins[network].ensureReady();
      this.openWallets(network);
    }
    // A new profile (nothing stored, no wallet, no chat) gets its default Mainnet wallets, in the background.
    void this.startWalletSetup(fresh && !this.walletView.wallets?.length && this.links.size === 0).catch(() => {});
  }

  /**
   * Leaves limited mode after the first good turn read that says this device is the active one (WISP 06 § When a
   * device checks: "the first good one either starts the engine properly or stops the device"). What `start()` left
   * out runs now: the wallets, then every chat, the hold storage and the group entries, as when the person goes online.
   */
  async leaveLimited(): Promise<void> {
    if (!this.limitedMode) return;
    this.limitedMode = false;
    await this.startWallets();
    this.openStartedWallets(false);
    if (this.networkOn) {
      for (const live of this.links.values()) this.startLink(live.stored.id, await db.getMessages(live.stored.id));
      this.hold.start();
      this.startGroupEntries();
      this.prepareSpare(STARTUP_QUIET_MS);
      void this.did.publishNow().catch(() => {});
    }
    this.emitState();
  }

  /** The first-run wallet setup, where the app runs it (`NodeOptions.defaultWallets`): begun once, then what is left. */
  private async startWalletSetup(fresh: boolean): Promise<void> {
    const option = this.options.defaultWallets;
    const on = typeof option === "function" ? await option() : option === true;
    if (!on || this.shuttingDown) return;
    await this.walletSetup.begin(fresh);
  }

  /** Wallet page: try again to make a default wallet the first-run setup could not make. */
  async walletSetupRetry({ type }: { type: WalletType }): Promise<void> {
    if (!WALLET_TYPES.includes(type)) throw new Error("Unknown kind of wallet");
    await this.walletSetup.run(type);
  }

  /** Wallet page: the person does not want this default wallet made for them; it is not tried again. */
  async walletSetupDismiss({ type }: { type: WalletType }): Promise<void> {
    if (!WALLET_TYPES.includes(type)) throw new Error("Unknown kind of wallet");
    await this.walletSetup.dismiss(type);
  }

  /** Opens the wallets of a network that exist. None is made here: wallets are made one at a time, with New. */
  private openWallets(network: WalletNetwork) {
    if (this.options.automaticWallets === false) return;
    void this.arkWallets[network].ensureReady();
    void this.barkWallets[network].ensureReady();
    void this.sparkWallets[network].ensureReady();
    void this.usdtWallets[network].ensureReady();
  }

  /**
   * Says goodbye on every live session (`paired-bye`): the contacts end theirs now and watch for this app to come back,
   * instead of noticing a minute later. Synchronous: an app closing may have no time for anything after it.
   */
  depart(): void {
    for (const live of this.links.values()) live.link?.depart();
  }

  /** Tells every peer we are leaving. Best effort: the browser may already be closing. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    // First, before anything that waits: every live contact hears this app is going, and watches for it to come back.
    this.depart();
    this.directPath.close();
    this.clock.close();
    this.clockOff?.();
    if (this.relayRetry) clearTimeout(this.relayRetry);
    if (this.activeSlotRetry) clearTimeout(this.activeSlotRetry);
    for (const timer of this.resumeTimers.values()) clearTimeout(timer);
    this.resumeTimers.clear();
    if(this.paymentTimer)clearTimeout(this.paymentTimer);
    clearTimeout(this.awaitingTimer);
    clearInterval(this.staleReviewTimer);
    if (this.spareTimer) clearTimeout(this.spareTimer);
    for (const timer of this.reactionTimers.values()) clearTimeout(timer);
    this.reactionTimers.clear();
    for (const timer of this.pinTimers.values()) clearTimeout(timer);
    this.pinTimers.clear();
    this.stopGroupEntries();
    this.stopWatchingAdapters?.();
    this.identities.stop();
    this.did.stop();
    this.nostrSocial.stop();
    this.publicProfiles.stop();
    this.publicActivity.clear();
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
    for (const queue of this.editQueues.values()) queue.stop();
    this.groupEdits.stop();
    this.cardEdits.stop();
    await Promise.allSettled([...this.links.values()].map(async (live) => { await live.link?.stop(true); await live.caps?.stop(); }));
  }

  /**
   * "Clear all data" (WISP 04), the peer's part. First what can be taken back from the network, best effort and within
   * `CLEAR_WITHDRAW_MS` in all: items held in storage for contacts, the DID (a `deactivated` record), the identity
   * proofs (their revocation records, once more). Then the peer stops, so nothing it holds in memory is written back,
   * and its database keeps only the wallets. The host starts a new peer afterwards (the page reloads).
   */
  async clearProfileData(): Promise<void> {
    const withdraw = Promise.allSettled([this.hold.withdrawAll(), this.did.deactivate(), this.identities.revokeAll()]);
    await Promise.race([withdraw, new Promise((resolve) => setTimeout(resolve, CLEAR_WITHDRAW_MS))]);
    await this.shutdown();
    await clearProfileStores();
  }

  getState(): EngineState {
    const groups = this.groups.views();
    return {
      settings: this.settings,
      ...(this.limitedMode && { limited: true as const }),
      transport: {
        ...this.transport.describe(), ...(this.options.irohWeb ? { iroh: { relays: this.irohRelays, defaults: [...DEFAULT_IROH_RELAYS] } } : {}),
        ...(this.transport.configure && { direct: true }), ...(this.transport.discovery && { discovery: this.transport.discovery() }),
        ...(typeof RTCPeerConnection === "undefined" && { webrtc: false as const }),
        ...(this.directPath.blocked && { directBlocked: true as const }),
        ...(this.clock.offset !== null && { clockOffMs: this.clock.offset }),
        // A group's link goes over WebRTC, or a native transport where one side has none (WISP 9xx § Transports).
        ...(typeof RTCPeerConnection === "undefined" && !Object.keys(this.nativeFactories).length && { groupLinks: false as const }),
      },
      // Group edges are links the engine runs, not chats anyone sees.
      links: [...this.links.values()].filter((live) => !live.stored.group).map((live) => this.viewOf(live)).sort((a, b) => b.createdAt - a.createdAt),
      services: this.services
        .map((s) => ({ ...s, requests: this.requestCounts.get(s.id) ?? 0 }))
        .sort((a, b) => a.createdAt - b.createdAt),
      transfers: Object.fromEntries(this.transfers),
      transfersRestored: this.transfersRestored,
      wallet: this.walletView,
      payments: this.desk.views(),
      identityProofs: this.identities.views(),
      did: this.did.view(),
      nostr: this.nostrSocial.state(),
      edges: [...[...this.links.values()].filter(live => live.stored.group && !live.stored.groupEntry).map(live => this.viewOf(live)), ...this.communityPayViews(groups)],
      groups: groups.map(group => ({ ...group, ...(this.reactionNotes.has(`group:${group.id}`) && { lastReaction: this.reactionNotes.get(`group:${group.id}`) }), ...this.groupWakeView(group), members: group.members.map(member => {
        const edge = member.me ? undefined : this.edgeView(group.id, member.key);
        return edge ? { ...member, edge } : member;
      }) })),
    };
  }

  /** A private group's wake-up tokens (the push worker's table) and its mute, as its edges have them. */
  private groupWakeView(group: GroupView): Pick<GroupView, "wakeTokens" | "wakeMuted"> {
    if (group.profile !== "mesh") return {};
    const tokens = this.settings.wake ? [...this.links.values()].filter(live => live.stored.group === group.id && this.meshEdge(live.stored) && live.stored.wakeToken).map(live => live.stored.wakeToken!) : [];
    return { ...(tokens.length && { wakeTokens: tokens }), ...(this.settings.wakeMutedGroups?.includes(group.id) && { wakeMuted: true }) };
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
    for (const live of this.links.values()) if (live.stored.group === groupId && live.stored.groupPeer === member && !live.stored.groupEntry)
      return edgeView(live, Date.now(), this.groupNativeWaiting.has(live.stored.id));
    return undefined;
  }

  getMessages(linkId: string): Promise<StoredMessage[]> {
    return db.getMessages(linkId);
  }

  async messagePage({ linkId, limit = 50, before }: { linkId: string; limit?: number; before?: string | number }): Promise<MessagePage> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit: a whole number of messages, at least 1");
    if (before === undefined) return db.getMessagePage(linkId, { limit });
    if (typeof before === "number") {
      if (Number.isNaN(before)) throw new Error("before: a time or a message id");
      return db.getMessagePage(linkId, { limit, before: { timestamp: before } });
    }
    const from = await db.getMessage(linkId, before);
    if (!from) throw new Error(`No message ${before}`);
    return db.getMessagePage(linkId, { limit, before: from });
  }

  async statusCardIndex(): Promise<CardIndexRow[]> {
    const rows: CardIndexRow[] = [];
    for (const m of await db.getCardMessages()) {
      if (m.card?.kind !== "task" && m.card?.kind !== "routine") continue;
      rows.push({ linkId: m.linkId, id: m.id, card: m.card, sender: m.sender, ...(m.member && { member: m.member }), timestamp: m.timestamp, ...(m.edit && { editedAt: m.edit.at }) });
    }
    return rows;
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
   * (`emptyLinkRecords`), and makes the next one the moment this one is taken (warmed a little later,
   * `SPARE_INVITE_WARM_AFTER_TAKE_MS`).
   */
  takeInvite(): { mine: LinkParams; inviteCode: string } {
    // A spare warmed seconds ago is worse than fresh keys: the network is still putting its first packet,
    // and a second one under the key meanwhile is refused by relays and DHT alike (for ~4 s). One not warmed yet is
    // fresh keys like any others.
    const now = Date.now(), warmedAt = this.spare?.warmedAt;
    const spare = this.spare && (warmedAt === undefined || (now - warmedAt >= SPARE_INVITE_MIN_AGE_MS && now - this.spare.madeAt < SPARE_INVITE_MAX_AGE_MS)) ? this.spare : this.makeSpare();
    if (spare === this.spare) { this.spare = null; this.prepareSpare(SPARE_INVITE_WARM_AFTER_TAKE_MS); }
    return { mine: spare.mine, inviteCode: spare.inviteCode };
  }

  /**
   * Warms a key with an empty packet (`emptyLinkRecords`), dated `WARM_DATED_BACK_MS` before this clock. One of the two
   * keys an invite warms is the contact's: its own first packet has to be the later one, or the relays and the DHT keep
   * this empty one in its place. Dated by this clock, it was later than the first packets of every contact whose clock
   * runs behind this one: a joiner two minutes behind stayed unseen for two minutes, one an hour behind for an hour.
   */
  private warmKey(identity: Identity): void {
    const records = emptyLinkRecords();
    const put = this.transport.publishPayload
      ? this.transport.publishPayload(identity.pubKeyZ32, createRelayPayload(identity, records, BigInt(Date.now() - WARM_DATED_BACK_MS) * 1000n))
      : this.transport.publish(identity, records);
    void put.catch(() => {});
  }

  private makeSpare(): SpareInvite {
    // A ghostly1 invite (WISP 801): `mine` keeps the participation seed whose public key the code carries.
    const { mine, invite, inviteCode } = createChatInvite();
    return { mine, inviteKey: identityFromSeedB64(invite.seedB64), inviteCode, madeAt: Date.now() };
  }

  /** One invite warmed and waiting (`after` ms from now), warmed again every so often while it waits (the relays forget). */
  private prepareSpare(after = 0): void {
    if (this.shuttingDown || !this.networkOn) return;
    if (!this.spare) this.spare = this.makeSpare();
    const spare = this.spare;
    if (this.spareTimer) clearTimeout(this.spareTimer);
    if (after > 0) {
      this.spareTimer = setTimeout(() => { this.spareTimer = null; if (this.spare === spare) this.prepareSpare(); }, after);
      return;
    }
    spare.warmedAt ??= Date.now();
    for (const identity of [identityFromSeedB64(spare.mine.seedB64), spare.inviteKey]) {
      this.warmedKeys.set(identity.pubKeyZ32, Date.now());
      this.warmKey(identity);
    }
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
      return { linkId: await this.existingLink(existing.stored.id) };
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
      return { linkId: await this.existingLink(existing.stored.id) };
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
    const live=this.links.get(linkId);if(!live || !this.networkOn || live.stored.profileChoice==='ghostly')return;
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
  async completeIdentityProof(params: { draftId: string; evidence: unknown }) {
    const proof = await this.identities.complete(params);
    // Proofs are checked before they are kept: added is verified.
    this.cueFeedback({ cue: "sealed", key: proof.id });
    return proof;
  }
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
  loadPublicPosts(params: { provider: string; subject: string; more?: boolean; force?: boolean }): Promise<PublicPostsView | null> {
    return this.publicActivity.loadPosts({ provider: String(params.provider), subject: String(params.subject), more: params.more === true, force: params.force === true });
  }
  loadPublicGraph(params: { provider: string; subject: string; force?: boolean }): Promise<PublicGraphView | null> {
    return this.publicActivity.loadGraph({ provider: String(params.provider), subject: String(params.subject), force: params.force === true });
  }
  loadPublicPostImage(params: { provider: string; subject: string; postId: string; index: number }): Promise<PublicPostImageView> {
    return this.publicActivity.loadImage({ provider: String(params.provider), subject: String(params.subject), postId: String(params.postId), index: Number(params.index) });
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

  // ---------- wake-up push (WISP 401 § Wake-up push) ----------

  async setWakeSubscription({ subscription }: { subscription: WakeSubscription | null }): Promise<void> {
    if (subscription) {
      checkPushEndpoint(subscription.endpoint);
      if (!/^[A-Za-z0-9_-]{80,100}$/.test(subscription.p256dh) || !/^[A-Za-z0-9_-]{20,24}$/.test(subscription.auth)) throw new Error("Not a push subscription");
      if (!vapidKeysMatch(subscription.vapid)) throw new Error("The VAPID keys are not a pair");
    }
    const before = this.settings.wake;
    this.settings = { ...this.settings, wake: subscription ?? undefined };
    if (!subscription) delete this.settings.wake;
    // Replaced or turned off: whoever held the old subscription can no longer post to it.
    delete this.settings.wakeRotate;
    delete this.settings.wakeHeldBy;
    await db.putSettings(this.settings);
    for (const live of this.links.values()) {
      const edge = this.meshEdge(live.stored);
      if (!edge && (!live.stored.profile || live.stored.group)) continue;
      if (!subscription) {
        // Stopped: every contact told now forgets it; one away still has it, and its push service answers 410.
        if (before && edge) this.sendGroupWake(live, null);
        else if (before && live.link?.supportsWake) live.link.sendWake(null);
        if (live.stored.wakeToken) { live.stored = { ...live.stored, wakeToken: undefined }; void db.patchLink(live.stored.id, { wakeToken: undefined }); }
        continue;
      }
      // A new subscription is a new token everywhere: what anyone kept from before names nothing now.
      live.stored = { ...live.stored, wakeToken: undefined };
      void db.patchLink(live.stored.id, { wakeToken: undefined });
      void (edge ? this.shareGroupWake(live.stored.id) : this.shareWake(live.stored.id));
    }
    this.emitState();
  }

  async setWakeMuted({ linkId, muted }: { linkId: string; muted: boolean }): Promise<void> {
    if (linkId.startsWith("group:")) return this.setGroupWakeMuted(linkId.slice("group:".length), muted);
    const live = this.links.get(linkId);
    if (!live?.stored.profile || live.stored.group || !!live.stored.wakeMuted === muted) return;
    // A contact told to forget the subscription may keep it anyway: the app replaces it.
    if (muted && live.stored.wakeToken) await this.rotateWake();
    live.stored = { ...live.stored, wakeMuted: muted || undefined, ...(muted && { wakeToken: undefined }) };
    await db.patchLink(linkId, { wakeMuted: muted || undefined, ...(muted && { wakeToken: undefined }) });
    // Muted: the contact forgets it now if live, else on the next session; unmuted: a new token goes to it.
    await this.shareWake(linkId);
    this.emitState();
  }

  /** A contact that held this profile's subscription is gone or muted: the app is to replace it (`wakeRotate`). */
  private async rotateWake(): Promise<void> {
    if (!this.settings.wake || this.settings.wakeRotate) return;
    this.settings = { ...this.settings, wakeRotate: true };
    await db.putSettings(this.settings);
  }

  /**
   * Tells the contact how to wake this app, under this chat's token, once both sides offer `wake/1`; for a muted chat,
   * to forget it (said on every session: the contact may have been away when the chat was muted).
   */
  private async shareWake(linkId: string): Promise<void> {
    const live = this.links.get(linkId);
    const own = this.settings.wake;
    if (!live?.link?.supportsWake) return;
    if (live.stored.wakeMuted) { live.link.sendWake(null); return; }
    if (!own) return;
    let token = live.stored.wakeToken;
    if (!token) {
      token = newWakeToken();
      live.stored = { ...live.stored, wakeToken: token };
      await db.patchLink(linkId, { wakeToken: token });
      this.emitState();
    }
    live.link.sendWake({ ...own, token });
  }

  // ---------- wake-up push in private groups (WISP 9xx · Group Mesh § Wake-up push) ----------

  /** An edge of a private group: where a member shares how to wake it. A community has none between two members. */
  private meshEdge(stored: StoredLink): boolean {
    return !!stored.group && !!stored.groupPeer && !stored.groupEntry && !this.groups.isCommunityGroup(stored.group);
  }

  /**
   * A group's roster changed, or I am out of it: a member that holds this profile's subscription with no edge left
   * (a group on hubs dropped it) and is no longer in the group, or a group I left or forgot, replaces it.
   */
  private groupMembersChanged(groupId: string): void {
    this.quietOutsideEdges(groupId);
    const holders = this.settings.wakeHeldBy?.[groupId];
    if (!holders?.length) return;
    const members = this.membership(groupId)?.members;
    if (members && holders.every(key => members.has(key))) return;
    void this.rotateWake().then(() => this.emitState());
  }

  /**
   * A group I left or forgot: its history is gone here, and the pages' copy goes too (an empty history, sent in order
   * with what came before). A page hears only what changes in a history it holds: a community left and joined again
   * by its link showed its old history under the new messages until a reload (bug hunt r5b, 2026-09-29).
   */
  private groupHistoryGone(groupId: string): void {
    const linkId = `group:${groupId}`;
    this.newestAt.delete(linkId);
    this.placedAt.delete(linkId);
    this.reactionNotes.delete(linkId);
    this.events.onMessages(linkId, []);
  }

  private async setGroupWakeMuted(groupId: string, muted: boolean): Promise<void> {
    const list = this.settings.wakeMutedGroups ?? [];
    if (list.includes(groupId) === muted) return;
    // Members told to forget the subscription may keep it anyway: as for a muted chat, the app replaces it.
    // Those whose edges a group on hubs dropped hold it too, with no edge left to tell them.
    if (muted && ([...this.links.values()].some(live => live.stored.group === groupId && this.meshEdge(live.stored) && live.stored.wakeToken) || this.settings.wakeHeldBy?.[groupId]?.length)) await this.rotateWake();
    const next = muted ? [...list, groupId] : list.filter(id => id !== groupId);
    this.settings = { ...this.settings, wakeMutedGroups: next.length ? next : undefined };
    if (!next.length) delete this.settings.wakeMutedGroups;
    await db.putSettings(this.settings);
    for (const live of this.links.values()) {
      if (live.stored.group !== groupId || !this.meshEdge(live.stored)) continue;
      // Muted: every member forgets it (now, or when its edge opens); unmuted: each gets a new token.
      if (live.stored.wakeToken) { live.stored = { ...live.stored, wakeToken: undefined }; await db.patchLink(live.stored.id, { wakeToken: undefined }); }
      await this.shareGroupWake(live.stored.id);
    }
    this.emitState();
  }

  private sendGroupWake(live: LiveLink, target: WakeTarget | null): void {
    if (!live.link?.groupsSupport) return;
    // An older member's app drops a frame it does not know.
    try { live.link.sendGroupFrame(groupWakeFrame(live.stored.group!, target)); } catch { /* the edge closed: said again when it opens */ }
  }

  /**
   * Tells the member at the other end of this edge how to wake this app, under this edge's token; in a muted group, to
   * forget it (said whenever the edge opens: the member may have been away when the group was muted).
   */
  private async shareGroupWake(linkId: string): Promise<void> {
    const live = this.links.get(linkId);
    const own = this.settings.wake;
    if (!live?.link?.groupsSupport || !this.meshEdge(live.stored) || this.outsideEdge(linkId)) return;
    if (this.settings.wakeMutedGroups?.includes(live.stored.group!)) { this.sendGroupWake(live, null); return; }
    if (!own) return;
    let token = live.stored.wakeToken;
    if (!token) {
      token = newWakeToken();
      live.stored = { ...live.stored, wakeToken: token };
      await db.patchLink(linkId, { wakeToken: token });
      this.emitState();
    }
    this.sendGroupWake(live, { ...own, token });
  }

  /** A `group-wake` frame on an edge: the member it is pinned to shares how to wake it, or says to forget it. */
  private receiveGroupWake(linkId: string, frame: Record<string, unknown>): void {
    const live = this.links.get(linkId);
    if (!live || !this.meshEdge(live.stored) || this.outsideEdge(linkId)) return;
    let window = this.groupWakeReceived.get(linkId);
    if (!window) this.groupWakeReceived.set(linkId, window = new RateWindow(GROUP_WAKE_RECEIVE_LIMIT, 60_000));
    if (!window.take()) return;
    const target = parseGroupWakeFrame(frame, live.stored.group!);
    if (target === undefined) return;
    live.stored = { ...live.stored, peerWake: target ?? undefined };
    void db.patchLink(linkId, { peerWake: target ?? undefined });
    this.emitState();
  }

  /**
   * A message of mine in a private group names members: each one it names by key, that shared how and that I cannot
   * reach now, is woken, within the limits. Never waits, never fails the send.
   */
  private wakeMentioned(groupId: string, text: string, mentions: readonly GroupMention[]): void {
    if (!mentions.length || !this.networkOn || this.groups.isCommunityGroup(groupId)) return;
    const edges = this.memberEdges(groupId);
    const wakes = groupWakes({
      group: groupId, mentions, text, limiter: this.groupWakeLimiter,
      target: member => { const id = edges.get(member); return id ? this.links.get(id)?.stored.peerWake && id : undefined; },
      reachable: member => this.groups.reachable(groupId, member),
    });
    for (const { target: linkId } of wakes) this.postWake(linkId, this.links.get(linkId)!.stored.peerWake!, "message");
  }

  /** The contact is away: one wake-up, if it shared how and none went to it lately. Never waits, never fails a send. */
  private wakePeer(live: LiveLink, kind: WakeKind = "message"): void {
    const target = live.stored.peerWake, linkId = live.stored.id;
    if (!target || !live.stored.profile || live.stored.group || !this.networkOn) return;
    if (!(kind === "call" ? this.callWakeLimiter : this.wakeLimiter).take(linkId)) return;
    this.postWake(linkId, target, kind);
  }

  /** Posts one wake-up to the target a link holds; a subscription gone (404, 410) is forgotten. */
  private postWake(linkId: string, target: WakeTarget, kind: WakeKind): void {
    let request: PushRequest;
    try { request = wakeRequest(target, Date.now(), kind); } catch { return; }
    void this.postPush(request).then((status) => {
      // The subscription is gone (the contact turned it off, or its browser dropped it): forget it until it shares a new one.
      if ((status === 404 || status === 410) && this.links.get(linkId)?.stored.peerWake?.endpoint === target.endpoint) {
        const current = this.links.get(linkId)!;
        current.stored = { ...current.stored, peerWake: undefined };
        void db.patchLink(linkId, { peerWake: undefined });
        this.emitState();
      }
    }).catch(() => { /* no network, or refused and no relay: the message still waits for the contact */ });
  }

  /**
   * A call to a contact whose app is closed (WISP 401 § Wake-up push, calls): one "call" wake-up, so its app shows
   * "Incoming call"; the caller waits for the chat to go live and calls then. True when the contact can be woken
   * this way (it shared a target and the chat is not live), whether or not a push went just now (one per 30 s).
   */
  async wakeForCall({ linkId }: { linkId: string }): Promise<boolean> {
    const live = this.links.get(linkId);
    if (!live?.stored.peerWake || !live.stored.profile || live.stored.group || live.link?.isDataLinkOpen || !this.networkOn) return false;
    this.wakePeer(live, "call");
    // It is looked for at once too: the woken app answers on the DHT first.
    live.link?.session.pollNow();
    return true;
  }

  /** Posts a wake-up: the host's way, or `fetch`, then the push relay when a page may not post it itself. */
  private async postPush(request: PushRequest): Promise<number> {
    if (this.options.pushSend) return this.options.pushSend(request);
    const quiet = { credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" } as const;
    try {
      const response = await fetch(request.url, { method: "POST", headers: request.headers, body: request.body as BodyInit, signal: AbortSignal.timeout(10_000), ...quiet });
      return response.status;
    } catch (error) {
      const relay = this.settings.pushRelay;
      if (!relay) throw error;
      const response = await fetch(relay, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(relayRequest(request)), signal: AbortSignal.timeout(15_000), ...quiet,
      });
      const answer = await response.json().catch(() => null) as { status?: unknown } | null;
      return typeof answer?.status === "number" ? answer.status : response.status;
    }
  }

  removeLink({ linkId }: { linkId: string }): void {
    const live = this.links.get(linkId);
    if (!live) return;
    void this.outboxes.get(linkId)?.stop();
    this.outboxes.delete(linkId);
    this.editQueues.get(linkId)?.stop();
    this.editQueues.delete(linkId);
    this.editBuffer.forget(linkId);
    void live.link?.stop(true); void live.caps?.stop();
    this.links.delete(linkId);
    this.identities.forget(linkId);
    this.nostrSocial.forgetLink(linkId);
    this.hold.forgetLink(linkId);
    this.fileDesk.drop(linkId);
    // Its wake-up target and token go with the row: this chat can no longer wake the contact, nor be woken. The
    // contact still has the subscription, so the app replaces it.
    this.wakeLimiter.reset(linkId);
    this.callWakeLimiter.reset(linkId);
    if (live.stored.wakeToken) void this.rotateWake().then(() => this.emitState());
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

  /**
   * One look at another profile of this device for messages waiting for it (WISP 04 § Checking other profiles): reads
   * only, over this profile's read path, and only when that profile reads the same way. The UI paces it.
   */
  peekProfile({ profile, dbName }: { profile: string; dbName: string }): Promise<PeekResult> {
    return this.profilePeek.peek(profile, dbName);
  }

  /**
   * The window or tab is back in front: every chat looks now, and dropped ones reconnect at once. Back online
   * (`network`): relays left alone for failing on the old network are asked again at once.
   */
  wake(params: { network?: boolean } = {}): void {
    if (params.network) { this.transport.networkChanged?.(); this.directPath.reset(); }
    for (const live of this.links.values()) live.link?.wake();
    this.hold.wake();
    // A wallet source that could not be reached at start-up (no network yet, a server asleep) tries again.
    for (const network of WALLET_NETWORKS) { this.lightnings[network].wake(); this.bitcoins[network].sources.wake(); }
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

  /**
   * `card`: a bot's status card (WISP 4xx · Status Cards), checked here by the sender's rule; the text is its fallback,
   * written from the card when none is given. Only the headless runtime and SDKs send one: the app never offers it.
   */
  async sendMessage(params: { linkId: string; text: string; timestamp?: number; preview?: LinkPreview; replyTo?: string; card?: unknown; button?: string }): Promise<{ error: string | null; refused?: boolean; messageId?: string }> {
    const { linkId } = params;
    const card = params.card === undefined ? undefined : GhostlyNode.cardToSend(params.card);
    if (typeof card === "string") return { error: card, refused: true };
    const text = card && !(typeof params.text === "string" && params.text.trim()) ? statusCardText(card) : params.text;
    if (typeof text !== "string") return { error: "Nothing to send", refused: true };
    const live = this.links.get(linkId);
    const trimmed = text.trim();
    // What a compatibility chat's DHT cannot carry is refused before it is kept: it must not show as sent. Whatever
    // the link's state: one that has not started yet (a chat just added) has no data link either.
    const bytes = new TextEncoder().encode(trimmed).length;
    if (live && !live.stored.profile && !(live.link?.isDataLinkOpen && trimmed.length <= LIMITS.maxChatMessageBytes / 4) && bytes > MAX_DHT_TEXT_BYTES)
      return { error: `Message too large for DHT (${bytes} bytes, max ${MAX_DHT_TEXT_BYTES}). Try a shorter message or share a link instead.`, refused: true };
    if (!live?.link) return { error: "You are offline" };
    if (!trimmed) return { error: null };

    // Picked here (the CLI, a bot): past what just came, so an answer written in the same millisecond goes below it.
    const timestamp = params.timestamp ?? arrivalKey(Date.now(), this.placedAt.get(linkId));
    // Sent: whatever this side was typing is done (the contact clears it on the message too).
    if (live.stored.profile) live.link.setTyping(false);
    if (live.stored.profile) {
      // A reply names a message of this chat, as both sides know it (WISP 400 § Replies); anything else is refused.
      const found = params.replyTo === undefined ? undefined : await this.replyFor(linkId, params.replyTo);
      if (typeof found === "string") return { error: found, refused: true };
      // A button press (`pressButton`, WISP 4xx · Message Buttons) is a reply naming the button, by an id that holds.
      if (params.button !== undefined && !(typeof params.button === "string" && BUTTON_ID.test(params.button) && found)) return { error: "No such button", refused: true };
      const reply = found && params.button !== undefined ? { ...found, button: params.button } : found;
      if (card) return this.sendChatText(live, trimmed, timestamp, undefined, reply, undefined, card);
      return this.sendChatText(live, trimmed, timestamp, params.preview === undefined ? undefined : parseLinkPreview(params.preview, trimmed), reply);
    }
    // A compatibility chat carries text only (WISP 402).
    if (card) return { error: "Status cards need a current chat; this compatibility chat sends text only.", refused: true };
    // A compatibility chat's records have no room for a reply (WISP 402): said, rather than sent without it.
    if (params.replyTo !== undefined) return { error: "Replies need a current chat; this compatibility chat sends text only.", refused: true };
    const via = live.link.isDataLinkOpen ? "datalink" : "pkarr";
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
    return { error, messageId: `me_${timestamp}` };
  }

  /**
   * Text in a chat (WISP 400): over layer 1 while live; on the DHT floor when it fits 256 bytes; held when
   * both sides allow it; otherwise kept as `waiting` ("Sends when live") and sent by itself, in order, once
   * the chat can carry it. Only what must never wait, or a security stop, is refused.
   */
  private async sendChatText(live: LiveLink, trimmed: string, timestamp: number, preview?: LinkPreview, reply?: MessageReply, forwarded?: number, card?: StatusCard): Promise<{ error: string | null; refused?: boolean; messageId?: string }> {
    const { link } = live, linkId = live.stored.id;
    if (!link) return { error: "You are offline" };
    this.chatInUse(live);
    const bytes = new TextEncoder().encode(trimmed).length;
    if (bytes > LIMITS.maxChatMessageBytes) return { error: `Message exceeds ${LIMITS.maxChatMessageBytes} UTF-8 bytes.`, refused: true };
    const stop = this.chatStopped(live);
    if (stop) return { error: stop };
    // Someone else used the invite first: the contact reads nothing of this side's, so nothing waits to go either.
    if (!link.isDataLinkOpen && link.dhtDelivery?.inviteTaken) return { error: INVITE_TAKEN, refused: true };
    const wireId = toBase64Url(randomBytes(16)), id = `me_${wireId}`;
    const delivery = link.isDataLinkOpen ? "stream" : link.textDelivery === "dht" ? "dht" : "unavailable";
    // Not live: the contact's app may be closed. Wake it, if it shared how; it then connects and takes this message.
    if (delivery !== "stream") this.wakePeer(live);
    // A card rides with the row; the DHT floor and a hold carry its text alone (WISP 4xx · Status Cards).
    const answers = { ...(reply && { replyTo: reply }), ...(forwarded && { forwarded }), ...(card && { card }) };
    if (delivery === "stream" || (delivery === "dht" && bytes <= DHT_TEXT_BYTES)) {
      const validationError = link.validateText(trimmed, timestamp, wireId, reply && pairedWireReply(reply));
      if (!validationError) {
        await this.storeMessage({ linkId, id, wireId, text: trimmed, sender: "me", timestamp, via: delivery === "dht" ? "pkarr" : "datalink", delivery: "sending", ...(preview && { preview }), ...answers });
        await this.outboxFor(linkId).transmit(id);
        // The durable row carries delivery errors and an explicit retry action.
        return { error: null, messageId: id };
      }
      if (/Payment tokens|does not match/.test(validationError)) return { error: validationError, refused: true };
    }
    if (this.holdingFor(live) && bytes <= HOLD_LIMITS.maxTextBytes) {
      // Longer than the DHT carries, and both sides allow held items: it waits in this device's storage, sealed for them.
      await this.storeMessage({ linkId, id, wireId, text: trimmed, sender: "me", timestamp, via: "hold", delivery: "sending", ...(preview && { preview }), ...answers,
        ...(card?.kind === "buttons" && { buttonsRestore: "due" as const }) });
      // The durable row carries the outcome; the promise only says whether it could start.
      void this.hold.hold(linkId, { kind: "text", id: wireId, messageId: id, bytes, timestamp }).catch(() => {});
      return { error: null, messageId: id };
    }
    const reason = delivery === "dht" && bytes <= DHT_TEXT_BYTES ? "Waits for the text before it to be confirmed."
      : delivery === "dht" ? `Longer than the ${DHT_TEXT_BYTES} bytes the DHT carries: it is sent when you are live.`
      : "Sent when your contact is reachable.";
    await this.storeMessage({ linkId, id, wireId, text: trimmed, sender: "me", timestamp, via: "datalink", delivery: "waiting", deliveryError: reason, ...(preview && { preview }), ...answers });
    await this.outboxFor(linkId).wait(id, reason);
    return { error: null, messageId: id };
  }

  /**
   * The message of a chat a reply answers, by its id here or the id both sides know it by (`replyRef`): what the
   * reply keeps of it, or why there is nothing to reply to. A group's reply needs the author's member key too.
   */
  private async replyFor(linkId: string, messageId: unknown): Promise<MessageReply | string> {
    if (typeof messageId !== "string" || !messageId) return "No message to reply to";
    const messages = await db.getMessages(linkId);
    const original = messages.find(m => m.id === messageId) ?? messages.find(m => replyRef(m) === messageId);
    const ref = original && replyRef(original);
    if (!original || !ref) return "That message is not in this chat, or cannot be replied to";
    if (linkId.startsWith("group:") && !original.member) return "That message cannot be replied to";
    return replyToOriginal(original, ref);
  }

  /**
   * A received reply, or one sent before its original was here, against this chat's own history: the original found
   * here gives the line and the author (and it is then checked); one not found keeps what the wire said, unchecked.
   */
  private async resolveReply(message: StoredMessage): Promise<StoredMessage> {
    const reply = message.replyTo;
    if (!reply || reply.messageId) return message;
    const history = await db.getMessages(message.linkId);
    const original = history.find(m => m.id !== message.id && replyRef(m) === reply.id);
    if (!original) return message;
    const resolved: StoredMessage = { ...message, replyTo: { ...replyToOriginal(original, reply.id), ...(reply.member && !original.member && { member: reply.member }), ...(reply.button && { button: reply.button }) } };
    // A press on one of my buttons (WISP 4xx · Message Buttons), when it is still open for this person.
    const press = buttonPress(resolved, original, history);
    return press ? { ...resolved, press } : resolved;
  }

  /** A paired row's reply as it goes on the wire again (a resend, a hold). */
  /** `localStorage["ghostly-test-no-edit"]`: this app offers no edit/1, as an older one (the e2e's old contact). Nothing else reads it. */
  private static testNoEdit(): boolean {
    try { return typeof localStorage !== "undefined" && localStorage.getItem("ghostly-test-no-edit") === "1"; } catch { return false; }
  }

  private static wireReply(message: StoredMessage): WireReply | undefined {
    return message.replyTo && pairedWireReply(message.replyTo);
  }

  /** The chat is on the DHT by choice: this side's DHT only, or the contact's (its records say so). It goes live for neither. */
  private static dhtByChoice(live: LiveLink | undefined): boolean {
    return live?.stored.deliveryMode === "dht" || live?.link?.dhtDelivery?.peerMode === "dht";
  }

  /** A status card a caller asks to send, by the sender's rule (WISP 4xx · Status Cards), or why it cannot go. */
  private static cardToSend(raw: unknown): StatusCard | string {
    const checked = checkStatusCard(raw);
    return "error" in checked ? `Status card: ${checked.error}` : checked.card;
  }

  /**
   * A chat stopped by a security rejection (a stream authenticated a participation key other than the pinned one):
   * nothing goes until the person acts. Another key on the DHT or the link's signals is ignored instead (WISP 400).
   */
  private chatStopped(live: LiveLink): string | null {
    if (live.pairing?.keyMismatch) return live.pairing.error ?? "This chat stopped: your contact's key changed.";
    return null;
  }

  /**
   * Edits a text of mine in a 1:1 chat (WISP 400 § Edits): the new text shows here at once, and goes to the contact
   * (`editsFor`) once the chat is live and both sides offer edit/1. Only texts, at most `MAX_EDITS_PER_MESSAGE` times each,
   * and never empty (deleting is for that). What an edit says is checked like a message: its length, its preview.
   */
  async editMessage(params: { linkId: string; messageId: string; text: string; preview?: LinkPreview; mentions?: GroupMention[]; card?: unknown }): Promise<{ error: string | null; refused?: boolean; messageId?: string }> {
    const { linkId } = params;
    const refuse = (error: string) => ({ error, refused: true });
    // A card's update (WISP 4xx · Status Cards): the whole new card, and its fallback text unless one is given.
    const card = params.card === undefined ? undefined : GhostlyNode.cardToSend(params.card);
    if (typeof card === "string") return refuse(card);
    if (card && !(typeof params.text === "string" && params.text.trim())) params = { ...params, text: statusCardText(card) };
    // A group's (WISP 9xx § Edits): said to its members, with the mentions the new text keeps or adds.
    if (typeof linkId === "string" && linkId.startsWith("group:")) {
      const mentions = Array.isArray(params.mentions) ? params.mentions : [];
      return card ? this.groupEdits.edit(linkId.slice("group:".length), params.messageId, params.text, mentions, card) : this.groupEdits.edit(linkId.slice("group:".length), params.messageId, params.text, mentions);
    }
    const live = this.links.get(linkId);
    if (!live) return refuse("No such chat");
    if (!live.stored.profile) return refuse("Editing needs a current chat; this compatibility chat cannot edit.");
    if (live.stored.group) return refuse("No such chat");
    if (typeof params.messageId !== "string" || typeof params.text !== "string") return refuse("No message to edit");
    const message = await db.getMessage(linkId, params.messageId) ?? (await db.getMessages(linkId)).find(m => m.sender === "me" && m.wireId === params.messageId);
    if (!message || !canEdit(message)) return refuse("Only your own text messages can be edited");
    const text = params.text.trim();
    if (!text) return refuse("An edit cannot be empty. Delete the message instead.");
    if (isJoinNotice(text)) return refuse("An edit cannot read as a join notice.");
    if (new TextEncoder().encode(text).length > LIMITS.maxChatMessageBytes) return refuse(`Message exceeds ${LIMITS.maxChatMessageBytes} UTF-8 bytes.`);
    const stop = this.chatStopped(live);
    if (stop) return { error: stop };
    const preview = card || params.preview === undefined ? undefined : parseLinkPreview(params.preview, text);
    if (text === message.text && (preview?.u ?? "") === (message.preview?.u ?? "") && JSON.stringify(card ?? null) === JSON.stringify(message.card ?? null)) return { error: null, messageId: message.id };
    // A message with a card takes more edits: a bot updates a long task often (WISP 4xx · Status Cards).
    const seq = (message.edit?.seq ?? 0) + 1, most = card ? STATUS_CARD_LIMITS.edits : MAX_EDITS_PER_MESSAGE;
    if (seq > most) return refuse(`This message was edited ${most} times, the most one takes.`);
    const edited = withEdit(message, { seq, at: Date.now(), text, preview, card, pending: true });
    await db.patchMessage(linkId, message.id, () => ({ text: edited.text, edit: edited.edit, preview: edited.preview, card: edited.card }));
    await this.messagesChanged(linkId, [message.id]);
    void this.editsFor(linkId).flush().catch(() => {});
    return { error: null, messageId: message.id };
  }

  /**
   * An edit from the contact (WISP 400 § Edits), already checked on the session that authenticated it. It can only
   * change the contact's own messages: the id is looked up among them, never among mine. True: confirm it (shown, not
   * newer than what shows, or its message was deleted here); false: its message is not here yet, and it waits a minute.
   */
  private async receiveEdit(linkId: string, edit: WireEdit): Promise<boolean> {
    const live = this.links.get(linkId);
    if (!live?.stored.profile || live.stored.group) return false;
    const id = `peer_${edit.id}`;
    if (live.stored.deletedIds?.includes(id)) return true;
    const message = await db.getMessage(linkId, id);
    if (!message) { this.editBuffer.hold(linkId, edit); return false; }
    await this.applyPeerEdit(linkId, message, edit);
    return true;
  }

  /**
   * The contact's edit on its message here, when it is newer than what shows. Not a new message: no sound, no unread, no
   * move. A card's update is paced: at most one applied per message a second, the highest number winning.
   */
  private async applyPeerEdit(linkId: string, message: StoredMessage, edit: WireEdit): Promise<void> {
    if (!takesPeerEdit(message, edit.m) || (message.edit?.seq ?? 0) >= edit.e) return;
    if (edit.sc) return this.cardEdits.take(`${linkId}\n${message.id}`, edit.e, () => this.applyPeerEditNow(linkId, message, edit));
    return this.applyPeerEditNow(linkId, message, edit);
  }

  private async applyPeerEditNow(linkId: string, message: StoredMessage, edit: WireEdit): Promise<void> {
    const updated = await db.patchMessage(linkId, message.id, current => {
      if (!takesPeerEdit(current, edit.m) || (current.edit?.seq ?? 0) >= edit.e) return null;
      const next = withEdit(current, { seq: edit.e, at: heardTime(edit.ts), text: edit.m, preview: edit.pv, card: edit.sc });
      return { text: next.text, edit: next.edit, preview: next.preview, card: next.card };
    });
    if (updated) await this.messagesChanged(linkId, [message.id]);
  }

  /** The contact's capability record says its app takes edits on the DHT floor too (WISP 403 § Edits). */
  private takesDhtEdits(live: LiveLink | undefined): boolean {
    return !!live?.caps?.peer?.capabilities.includes(EDIT_CAPABILITY);
  }

  /**
   * A question of mine with buttons went on the DHT floor or into a hold, which carry its text alone (WISP 4xx · Message
   * Buttons): its buttons are due to go again live. Once: a row that had them restored already stays so.
   */
  private async buttonsWentBare(linkId: string, message: Pick<StoredMessage, "id" | "card" | "buttonsRestore">): Promise<void> {
    if (message.card?.kind !== "buttons" || message.buttonsRestore) return;
    await db.patchMessage(linkId, message.id, current => current.sender === "me" && current.card?.kind === "buttons" && !current.buttonsRestore ? { buttonsRestore: "due" } : null);
  }

  /**
   * Buttons the contact may not have (WISP 4xx · Message Buttons): a question whose text went on the DHT floor or into a
   * hold reached the contact as text alone, and a copy under the same id that comes live later is taken as the one
   * already there. Once the chat is live with an app that shows buttons (`buttons/1`) and takes edits, each such
   * question goes again as an edit of its buttons alone: the same text, so no version and no edit mark. Once per
   * message (the row says so, across restarts); the edit queue carries it (a card's edit goes only live, and a later
   * edit of the bot's replaces it, the highest number winning). An app without `buttons/1` (1.0.0 would mark it edited)
   * gets none: the row waits for one that shows buttons. The edit is marked `restore`: the bot's own event stream says
   * nothing of it, while its number counts, so a later edit of the bot's takes the next one.
   */
  private async restoreButtons(linkId: string): Promise<void> {
    const live = this.links.get(linkId), link = live?.link;
    if (!live?.stored.profile || live.stored.group || !link?.supportsEdits || !link.sessionOffers.peer?.includes(BUTTONS_CAPABILITY)) return;
    const due = (await db.getMessages(linkId)).filter(m => m.sender === "me" && m.buttonsRestore === "due");
    const changed: string[] = [];
    for (const message of due) {
      const at = Date.now();
      const patched = await db.patchMessage(linkId, message.id, current => {
        if (current.sender !== "me" || current.buttonsRestore !== "due") return null;
        const seq = (current.edit?.seq ?? 0) + 1;
        // Its buttons gone since (an edit that left none), or no edit left to carry them: nothing to restore.
        if (current.card?.kind !== "buttons" || !current.wireId || seq > STATUS_CARD_LIMITS.edits) return { buttonsRestore: "sent" };
        const next = withEdit(current, { seq, at, text: current.text, preview: current.preview, card: current.card, pending: true });
        return { edit: { ...next.edit!, restore: true }, buttonsRestore: "sent" };
      });
      if (patched?.edit?.pending) changed.push(message.id);
    }
    if (changed.length) await this.messagesChanged(linkId, changed);
  }

  /** My edits in one 1:1 chat on their way to the contact. */
  private editsFor(linkId: string): EditQueue {
    let queue = this.editQueues.get(linkId);
    if (!queue) {
      queue = new EditQueue({
        read: () => db.getMessages(linkId),
        ready: () => {
          const live = this.links.get(linkId), link = live?.link;
          return !!link && (link.supportsEdits || (link.textDelivery === "dht" && this.takesDhtEdits(live)));
        },
        send: (edit, message) => {
          const live = this.links.get(linkId), link = live?.link;
          if (!link) return "You are offline";
          // On the DHT floor an edit follows its message's receipt: the contact must have the message to find it.
          if (!link.isDataLinkOpen && message.delivery && message.delivery !== "delivered") return "Waits for its message's receipt";
          return link.sendEdit(edit, { dht: this.takesDhtEdits(live) });
        },
        receiptMs: () => this.links.get(linkId)?.link?.isDataLinkOpen ? 20_000 : DHT_MESSAGE_TTL,
        settle: async (messageId, seq) => {
          const updated = await db.patchMessage(linkId, messageId, current => {
            if (!current.edit?.pending || current.edit.seq !== seq) return null;
            const { pending: _done, ...edit } = current.edit;
            return { edit };
          });
          if (updated) await this.messagesChanged(linkId, [messageId]);
        },
      });
      this.editQueues.set(linkId, queue);
    }
    return queue;
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
      await this.messagesChanged(linkId, [messageId]);
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
          if (delivery === "sent" || delivery === "delivered") {
            const message = await db.getMessage(linkId, id);
            if (message) this.messageFeedback("sent", message);
          }
          await this.messagesChanged(linkId, [id]);
        },
      }, async message => {
        const live = this.links.get(linkId), link = live?.link;
        if (!link) return "You are offline. It is sent again once you are back.";
        // The path as it is when the message goes: the details keep it, whatever the session does after.
        const at = Date.now(), snapshot = pathSnapshot(live, message.via);
        const reply = GhostlyNode.wireReply(message);
        const error = message.card ? await link.sendMessage(message.text, message.timestamp, message.wireId, message.preview, reply, message.forwarded, message.card)
          : message.forwarded ? await link.sendMessage(message.text, message.timestamp, message.wireId, message.preview, reply, message.forwarded)
          : reply ? await link.sendMessage(message.text, message.timestamp, message.wireId, message.preview, reply)
          : await link.sendMessage(message.text, message.timestamp, message.wireId, ...(message.preview ? [message.preview] : []));
        await this.noteTextSend(linkId, message, snapshot, at, error, link);
        // On the DHT floor a question goes without its buttons: they go again once live (`restoreButtons`).
        if (!error && message.via === "pkarr") await this.buttonsWentBare(linkId, message);
        return error;
      }, message => message.via === "pkarr" ? DHT_MESSAGE_TTL : 20_000, message => {
        const pending = this.links.get(linkId)?.stored.dhtDeliveryState?.pending;
        return message.via === "pkarr" && pending && pending.message[0] === message.wireId ? pending.expires : undefined;
      }, { resender: {
        // Only while the chat can carry it: a live link, or the DHT path with nothing else awaiting a receipt.
        // In a live chat, what already went through the DHT fallback waits for the live link. A chat on the DHT by
        // choice, either side's, has no live link to wait for: there it goes on the DHT again.
        ready: message => {
          const live = this.links.get(linkId), link = live?.link;
          if (message.via === "pkarr" && !GhostlyNode.dhtByChoice(live) && link?.textDelivery !== "stream") return false;
          return !!link?.canSendText && !!message.wireId && !link.validateText(message.text, message.timestamp, message.wireId, GhostlyNode.wireReply(message));
        },
        requeueExpired: () => !GhostlyNode.dhtByChoice(this.links.get(linkId)),
        via: message => {
          const delivery = this.links.get(linkId)?.link?.textDelivery;
          return delivery === "dht" ? "pkarr" : delivery === "stream" ? "datalink" : message.via;
        },
        // The contact stays away and both sides allow held items: store-and-forward takes it, under the same id.
        divert: async message => {
          const live = this.links.get(linkId), bytes = new TextEncoder().encode(message.text).length;
          if (!live || !this.holdingFor(live) || !message.wireId || message.file || message.paymentId || bytes > HOLD_LIMITS.maxTextBytes) return false;
          await db.updateDelivery(linkId, message.id, "sending", undefined, { via: "hold", resendUntil: undefined });
          await this.buttonsWentBare(linkId, message);
          await this.messagesChanged(linkId, [message.id]);
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
      : { frame: "paired-message", protocol: "chat/1", plaintextBytes, wireBytes: utf8Encode(pairedMessageFrame(message.wireId ?? "", message.timestamp, message.text, message.preview, GhostlyNode.wireReply(message), message.forwarded, message.card)).length };
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
    return { wire: { frame: "paired-message", protocol: "chat/1", plaintextBytes, wireBytes: utf8Encode(pairedMessageFrame(message.id ?? "", message.timestamp, message.text, message.preview, undefined, message.forwarded, message.card)).length } };
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
    // The contact's last acknowledgement comes once the file is stored there (files/2 after it is written, files/3 once
    // its digest checked out): its receipt. A file that went over the live session carries no delivery state while it
    // goes, so the receipt gives it two ticks, as a text gets from its own (WISP 401).
    if (!error && message.sender === "me" && message.delivery !== "delivered") {
      const marked = await db.patchMessage(linkId, message.id, m => m.delivery === "delivered" ? null : { delivery: "delivered", deliveryError: undefined });
      if (marked) { await this.messagesChanged(linkId, [message.id]); this.emitState(); }
    }
  }

  /**
   * The contact's app answered for a payment of mine (`pay-res`): its message gets two ticks, as a text gets from its
   * receipt. A payment goes with no delivery state of its own, so its mark read one tick for good. 1:1 chats only: a
   * group's payments live in the group's history, under other ids.
   */
  private async notePaymentReceipt(linkId: string, paymentId: string): Promise<void> {
    const message = (await db.getMessages(linkId)).find(m => m.sender === "me" && m.paymentId === paymentId);
    if (!message || message.delivery === "delivered") return;
    const marked = await db.patchMessage(linkId, message.id, m => m.delivery === "delivered" ? null : { delivery: "delivered", deliveryError: undefined });
    if (marked) { await this.messagesChanged(linkId, [message.id]); this.emitState(); }
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
      const message = await db.getMessage(linkId, messageId);
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
      live.lastMessageAt = (await db.getMessagePage(linkId, { limit: 1 })).messages[0]?.timestamp ?? 0;
      await this.messagesChanged(linkId, [messageId]);
      this.emitState();
    })();
  }

  /** Local id of a file we send: the id on the wire is ours too, but lives in its own key space. */
  private static outgoingFileId(linkId: string, wireId: string): string {
    return `${linkId}-out-${wireId}`;
  }

  /**
   * Sends a file, or sends it again (the same `timestamp`). `replyTo` quotes a message of the chat (WISP 401 § Replies),
   * as a text reply does; sent again, the file keeps the reply its message has (`transferFile`). Without a reply, it
   * does what it does before any wait, so a second call for the same file finds it already transferring. `forwarded`:
   * the hop count of a forwarded file (WISP 400 § Forwards), kept with its message and sent with it every time.
   * Refused before anything could start (offline, a stopped chat, a contact whose app takes no files): the transfer
   * says failed, no message is kept, and the call rejects with the reason, so whoever asked can say it.
   */
  async sendFile({ linkId, file, timestamp, replyTo, forwarded: hops }: { linkId: string; file: MessageFile; timestamp: number; replyTo?: string; forwarded?: number }): Promise<void> {
    let reply: MessageReply | undefined;
    if (replyTo !== undefined) {
      const found = await this.replyFor(linkId, replyTo);
      if (typeof found === "string") throw new Error(found);
      reply = found;
    }
    const forwarded = readForwarded(hops);
    const answers = { ...(reply && { replyTo: reply }), ...(forwarded && { forwarded }) };
    const wire = reply && pairedWireReply(reply);
    const live = this.links.get(linkId);
    const fail = (error: string) => {
      const transfer = { state: "failed" as const, transferred: 0, size: file.size, error };
      this.transfers.set(file.id, transfer);
      void fileStore.updateTransfer(file.id, transfer).catch(() => {});
      this.emitState();
    };
    const refuse = (error: string): never => { fail(error); throw new Error(error); };
    if (!live?.link) return refuse("You are offline");
    if (this.transfers.get(file.id)?.state === "transferring") return;
    const wireId = file.id.slice(`${linkId}-out-`.length);
    if (file.id !== GhostlyNode.outgoingFileId(linkId, wireId)) return refuse("Invalid file id");
    // A file too large to hold waits for the chat to be live instead, like one sent where nothing holds it.
    const holdable = file.size <= HOLD_LIMITS.maxBundleBytes - 4096;
    if (!live.link.isDataLinkOpen) this.wakePeer(live);
    if (!GhostlyNode.takesFiles(live.link) && this.holdingFor(live) && holdable) {
      // The contact is away: the file waits in this device's storage, sealed for them.
      live.files.wireIds.add(wireId);
      this.transfers.set(file.id, { state: "transferring", transferred: 0, size: file.size });
      void this.storeMessage({ linkId, id: `me_${timestamp}`, text: fileMessageText(file), sender: "me", timestamp, via: "hold", delivery: "sending", file, ...answers })
        .then(() => this.hold.hold(linkId, { kind: "file", id: wireId, messageId: `me_${timestamp}`, ref: file.id, bytes: file.size, timestamp })).catch(() => {});
      return;
    }
    if (!GhostlyNode.takesFiles(live.link) && live.stored.profile && !live.link.isDataLinkOpen) {
      // Not live and nothing holds it: it waits here, with a cancel, and goes when the chat is live (WISP 500).
      if (this.chatStopped(live)) return refuse(this.chatStopped(live)!);
      live.files.wireIds.add(wireId);
      void this.storeMessage({ linkId, id: `me_${timestamp}`, text: fileMessageText(file), sender: "me", timestamp, via: "datalink", file,
        delivery: "waiting", deliveryError: "Sent when you are live.", ...answers });
      return;
    }
    if (!GhostlyNode.takesFiles(live.link)) return refuse("Connect to an updated peer to send files");
    live.files.wireIds.add(wireId);
    void this.storeMessage({
      linkId,
      id: `me_${timestamp}`,
      text: fileMessageText(file),
      sender: "me",
      timestamp,
      via: "datalink",
      file,
      ...answers,
    });
    this.transferFile(live, file, wireId, timestamp, fail, wire, forwarded);
  }

  /**
   * The file of a stored message goes over the open session: offered with files/3 when both sides agree it,
   * else whole with files/2, which takes up to 100 MB.
   */
  private transferFile(live: LiveLink, file: MessageFile, wireId: string, timestamp: number, fail: (error: string) => void, reply?: WireReply, forwarded?: number): void {
    const { link } = live;
    if (!link) return fail("You are offline");
    this.transfers.set(file.id, { state: "transferring", transferred: 0, size: file.size });
    void (async () => {
      // Sent again: the reply its message carries goes with it again, and so does its hop count.
      if (!reply || !forwarded) {
        const message = (await db.getMessages(live.stored.id)).find(m => m.id === `me_${timestamp}`);
        reply ??= message && GhostlyNode.wireReply(message);
        forwarded ??= message?.forwarded;
      }
      const large = await GhostlyNode.largeFilesAgreed(link), at = Date.now();
      await this.noteDetails(live.stored.id, `me_${timestamp}`, details => ({ ...withSend(details, { at, ...pathSnapshot(live, "datalink"), result: "sent" }), sentAt: at, wire: fileWire(large ? "files/3" : "files/2", file.size) }));
      if (large) {
        // A transfer that ended for good (cancelled, declined) keeps saying why, rather than a bare failure with Retry.
        await this.fileDesk.offer(live.stored.id, file, wireId, timestamp, reply, forwarded).catch((error) => { if (!this.fileDesk.reshow(live.stored.id, file.id)) throw error; });
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
        { id: wireId, name: file.name, size: file.size, mime: file.mime, timestamp, ...(file.voice && { voice: file.voice }), ...(file.video && { video: file.video }), ...(file.image && { image: file.image }), ...(reply && { reply }), ...(forwarded && { forwarded }) },
        source,
      );
    })().catch((error) => fail(error instanceof Error ? error.message : String(error)));
  }

  fileAction({ linkId, fileId, action }: { linkId: string; fileId: string; action: "accept" | "decline" | "pause" | "resume" | "cancel" | "resend" | "request" }): void {
    const live = this.links.get(linkId);
    if (!live) throw new Error("No such chat");
    if (!["accept", "decline", "pause", "resume", "cancel", "resend", "request"].includes(action)) throw new Error("Unknown file action");
    const now = this.fileDesk.act(linkId, fileId, action);
    // Sent again or asked again with no live session: it goes when the chat is live, and the chat tries now.
    if (!now && (action === "resend" || action === "request") && live.link && !live.link.isDataLinkOpen) void this.connect({ linkId }).catch(() => {});
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
    // A session that just opened has not heard the contact's capabilities yet (files/3 comes in them): asked a little.
    if (waiting.some((m) => m.file) && !GhostlyNode.takesFiles(live.link)) await GhostlyNode.largeFilesAgreed(live.link);
    for (const message of waiting) {
      if (message.file) {
        if (!GhostlyNode.takesFiles(live.link)) { await db.updateDelivery(linkId, message.id, "failed", "Your contact's app cannot receive files."); continue; }
        const file = message.file, wireId = file.id.slice(`${linkId}-out-`.length);
        await db.putMessage(sentNow(message));
        this.transferFile(live, file, wireId, message.timestamp, error => {
          this.transfers.set(file.id, { state: "failed", transferred: 0, size: file.size, error });
          this.emitState();
        }, GhostlyNode.wireReply(message));
      } else {
        // The desk's replay has sent every pending request of this chat on the open session.
        if (live.link.supportsPayments) {
          const at = Date.now();
          await db.putMessage({ ...sentNow(message), details: { ...withSend(message.details, { at, ...pathSnapshot(live, "datalink"), result: "sent" }), sentAt: at } });
        } else await db.updateDelivery(linkId, message.id, "failed", "Your contact's app cannot receive payment requests.");
      }
    }
    if (waiting.length) await this.messagesChanged(linkId, waiting.map(m => m.id));
  }

  private receiveFile(
    linkId: string,
    wire: { id: string; name: string; size: number; mime: string; timestamp: number; voice?: MessageFile["voice"]; video?: MessageFile["video"]; image?: MessageFile["image"]; reply?: WireReply; forwarded?: number },
  ): FileSink | string {
    const files = this.links.get(linkId)?.files;
    if (!files) return "refused";
    // A known id could only be a replay or an attempt to pass for a file we already have.
    if (files.wireIds.has(wire.id)) return "duplicate file id";
    if (files.receivedBytes + wire.size > LIMITS.maxStoredIncomingBytesPerPeer) return "no room for more files";

    // The local id is ours, never the peer's: whatever it announces cannot replace a stored file.
    const { reply: _reply, ...announced } = wire;
    const file: MessageFile = { ...announced, id: `${linkId}-in-${toBase64Url(randomBytes(12))}` };
    files.wireIds.add(wire.id);
    files.receivedBytes += wire.size;
    files.incoming.set(wire.id, { localId: file.id, size: wire.size });
    let cancelled = false;
    // The bytes go to storage as they arrive, in order: never gathered whole in memory.
    const appender = fileBytes().then((bytes) => new FileAppender(bytes, file.id));
    let writing: Promise<void> = appender.then(() => {});
    const discard = () => appender.then((a) => a.bytes.remove(file.id)).catch(() => {});
    this.transfers.set(file.id, { state: "transferring", transferred: 0, size: file.size });
    // The app has its transfer before its message: a file shown with no transfer and no bytes reads as gone, and one
    // that arrived within the state's usual wait said "No longer available" until it was all here.
    this.flushState();
    // files/2 names a file's message by the sender's time, as the sender's reactions, edits and deletes do. Another
    // file (or a message) already at that time keeps its place, and this one gets an id of its own: its bytes never
    // land without a message. The same file sent again after its transfer failed lands in the message it had.
    const first = `peer_${wire.timestamp}`, own = `${first}_${wire.id}`;
    const messageIds = (files.messageIds ??= new Map());
    const holder = messageIds.get(first);
    if (holder === undefined) messageIds.set(first, wire.id);
    const storeFileMessage = (id: string) => this.storeMessage({
      linkId,
      id,
      // The id both sides know the file by: what a reply to it names (WISP 400 § Replies).
      wireId: wire.id,
      text: fileMessageText(file),
      sender: "peer",
      timestamp: wire.timestamp,
      via: "datalink",
      file: { id: file.id, name: file.name, size: file.size, mime: file.mime, ...(file.voice && { voice: file.voice }), ...(file.video && { video: file.video }), ...(file.image && { image: file.image }) },
      ...(wire.reply && { replyTo: receivedPairedReply(wire.reply) }), ...(wire.forwarded && { forwarded: wire.forwarded }),
      details: { wire: fileWire("files/2", wire.size) },
    });
    const messageStored = (async (): Promise<string> => {
      let id = holder === undefined || holder === wire.id ? first : own;
      if (id === first && (holder === wire.id || await db.hasMessage(linkId, first))) {
        const again = await db.patchMessage(linkId, first, (m) => m.sender === "peer" && m.wireId === wire.id && m.file ? { file: { ...m.file, id: file.id } } : null);
        if (again) { await this.messagesChanged(linkId, [first]); return first; }
        if (holder !== wire.id) id = own;
      }
      await storeFileMessage(id);
      return id;
    })();
    void messageStored.catch(() => {});
    return {
      write: (chunk) => (writing = writing.then(async () => { if (!cancelled) await (await appender).append(chunk); })),
      // The message keeps the announced type for display; the bytes are served as something inert.
      close: async (digest?: string) => {
        const messageId = await messageStored;
        await writing;
        if (cancelled) throw new Error("Transfer cancelled");
        const live = this.links.get(linkId);
        // Deleted while it was still arriving: the bytes have nowhere to land, and give their room back.
        if (live?.stored.deletedIds?.includes(messageId)) {
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
          metadata: { name: wire.name, size: wire.size, mime: wire.mime, timestamp: wire.timestamp, voice: wire.voice, video: wire.video, image: wire.image },
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
    if (linkId && !error && transfer.direction === "in" && transfer.state === "transferring") this.cueFeedback({ cue: "downloaded", key: fileId }, this.chatOf(linkId));
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
    const pairing = live.pairing, mark = transportMark(log.entries, log.history);
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
    if (!changed) return;
    this.saveTransportLog(live, log);
    const cue = transportCue(mark, log.entries, log.history);
    if (cue) this.cueFeedback(cue, linkId);
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
    // The name a rename would give it (`groupName`): one line, a new line read as a space, 64 characters at most. It
    // was cut at 48 code units without a word (through an emoji, at times), and its lines were joined with nothing between.
    const clean = groupName(name);
    if (!clean) throw new Error(`A group's name is 1 to ${MAX_GROUP_NAME_LENGTH} characters on one line`);
    return { groupId: await this.groups.create(clean, profile === "mesh" ? "mesh" : "community") };
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
    if (!this.networkOn) throw new Error("Go online to join a group");
    return { groupId: await this.groups.joinByLink(link) };
  }
  async sendGroupMessage({ groupId, text: given, mentions, replyTo, card: raw, button }: { groupId: string; text: string; mentions?: GroupMention[]; replyTo?: string; card?: unknown; button?: string }): Promise<{ error: string | null; messageId?: string; refused?: boolean }> {
    // A bot's status card (WISP 4xx · Status Cards), its fallback text written from it unless one is given.
    const card = raw === undefined ? undefined : GhostlyNode.cardToSend(raw);
    if (typeof card === "string") return { error: card };
    const text = card && !(typeof given === "string" && given.trim()) ? statusCardText(card) : given;
    if (typeof text !== "string") return { error: "Nothing to send" };
    // A reply names a message of this group, by its author's member key (WISP 9xx § Replies).
    const reply = replyTo === undefined ? undefined : await this.replyFor(`group:${groupId}`, replyTo);
    if (typeof reply === "string") return { error: reply };
    const named = Array.isArray(mentions) ? mentions : [];
    if (button !== undefined && !(typeof button === "string" && BUTTON_ID.test(button) && reply)) return { error: "No such button" };
    const wireReply = reply && { i: reply.id, s: reply.snippet, f: reply.member!, ...(button !== undefined && { b: button }) };
    const sent = card ? await this.groups.send(groupId, text, named, wireReply, undefined, card) : await this.groups.send(groupId, text, named, wireReply);
    // Members it names whose apps are closed are woken (WISP 9xx · Group Mesh § Wake-up push).
    if (!sent.error) this.wakeMentioned(groupId, text, named);
    return sent;
  }
  groupMessages({ groupId }: { groupId: string }): Promise<StoredMessage[]> { return this.groups.messages(groupId); }

  /**
   * Presses a button of a message someone else sent to a chat or a group (`group:<id>`), WISP 4xx · Message Buttons:
   * a reply to it whose text is the button's label and whose `r` names the button, so the author learns who pressed
   * what, and an app without buttons reads an ordinary reply. Refused: my own message, a button it does not have,
   * buttons the author closed, a question I already answered with a `once` button, a second press within a second.
   */
  async pressButton(params: { linkId: string; messageId: string; buttonId: string }): Promise<{ error: string | null; refused?: boolean; paced?: true; messageId?: string }> {
    const { linkId, messageId, buttonId } = params ?? {};
    if (typeof linkId !== "string" || typeof messageId !== "string" || typeof buttonId !== "string") return { error: "No button to press", refused: true };
    const history = await db.getMessages(linkId);
    const message = history.find(m => m.id === messageId);
    if (!message) return { error: "That message is not in this chat", refused: true };
    if (message.sender === "me") return { error: "Buttons on your own message do nothing", refused: true };
    const state = buttonsState(message, replyRef(message), history);
    const button = state?.card.buttons.find(b => b.id === buttonId);
    if (!state || !button) return { error: "That message has no such button", refused: true };
    if (!state.open) return { error: state.card.closed ? "These buttons are closed" : "You already answered", refused: true };
    const key = `${linkId}\n${messageId}`, now = Date.now();
    // `paced`: nothing is wrong, the tap came too soon after the last one; an app says nothing of it.
    if (now - (this.pressedAt.get(key) ?? -Infinity) < BUTTON_PRESS_MS) return { error: "One press a second", refused: true, paced: true };
    if (this.pressedAt.size > 500) this.pressedAt.clear();
    this.pressedAt.set(key, now);
    if (linkId.startsWith("group:")) return this.sendGroupMessage({ groupId: linkId.slice("group:".length), text: button.label, replyTo: messageId, button: button.id });
    return this.sendMessage({ linkId, text: button.label, replyTo: messageId, button: button.id });
  }
  /**
   * Forwards messages of a chat or a group (`group:<id>`) to up to `FORWARD_TARGETS` others (WISP 400 § Forwards): each
   * as a new message of mine, in the order they were written, carrying one more hop than it had and nothing of who wrote
   * it or where. A text goes as written; a file from the bytes on this device (a copy per chat, nothing fetched again),
   * through the chat's own path, so a large one still waits for the contact's consent. A group takes texts only. What one
   * chat refuses does not stop the others: each says what it got.
   */
  async forwardMessages(params: { linkId: string; messageIds: string[]; to: string[] }): Promise<{ results: ForwardResult[] }> {
    const { linkId } = params;
    if (typeof linkId !== "string" || !linkId) throw new Error("No chat to forward from");
    const ids = Array.isArray(params.messageIds) ? [...new Set(params.messageIds.filter((id): id is string => typeof id === "string"))] : [];
    const targets = Array.isArray(params.to) ? [...new Set(params.to.filter((to): to is string => typeof to === "string" && !!to))] : [];
    if (!ids.length) throw new Error("No message to forward");
    if (ids.length > FORWARD_MESSAGES) throw new Error(`Forward at most ${FORWARD_MESSAGES} messages at once`);
    if (!targets.length) throw new Error("No chat to forward to");
    if (targets.length > FORWARD_TARGETS) throw new Error(`Forward to at most ${FORWARD_TARGETS} chats at once`);
    if (linkId.startsWith("group:") ? !this.membership(linkId.slice("group:".length)) : this.links.get(linkId)?.stored.group !== undefined || !this.links.has(linkId))
      throw new Error("Chat not found");
    const history = await db.getMessages(linkId);
    const chosen = ids.map(id => history.find(m => m.id === id));
    if (chosen.some(m => !m)) throw new Error("That message is not in this chat");
    const messages = (chosen as StoredMessage[]).sort((a, b) => a.timestamp - b.timestamp);
    for (const message of messages) {
      const kind = forwardKind(message);
      if (typeof kind !== "string") throw new Error(kind.refused);
    }
    // Each new message its own time, even within one millisecond: a file's row is named after it.
    let last = 0;
    const now = () => (last = Math.max(Date.now(), last + 1));
    const results: ForwardResult[] = [];
    for (const to of targets) {
      const result: ForwardResult = { to, messageIds: [], error: null };
      results.push(result);
      const note = (error: string) => { result.error ??= error; };
      const groupId = to.startsWith("group:") ? to.slice("group:".length) : undefined;
      const live = groupId ? undefined : this.links.get(to);
      if (groupId ? !this.membership(groupId) : !live || live.stored.group !== undefined) { note(groupId ? "You are not in this group" : "Chat not found"); continue; }
      for (const message of messages) {
        const hops = forwardedAgain(message.forwarded);
        try {
          if (forwardKind(message) === "text") {
            const sent = groupId ? await this.groups.send(groupId, message.text, [], undefined, hops)
              : !live!.link ? { error: "You are offline" }
              : live!.stored.profile ? await this.sendChatText(live!, message.text.trim(), now(), message.preview, undefined, hops)
              : await this.sendMessage({ linkId: to, text: message.text, timestamp: now() });
            if (sent.error) note(sent.error); else if (sent.messageId) result.messageIds.push(sent.messageId);
            continue;
          }
          if (groupId) { note("Groups take no files yet"); continue; }
          if (!live!.link) { note("You are offline"); continue; }
          const original = message.file!, wireId = toBase64Url(randomBytes(12)), timestamp = now();
          const file: MessageFile = { id: GhostlyNode.outgoingFileId(to, wireId), name: original.name, size: original.size, mime: original.mime,
            ...(original.voice && { voice: original.voice }), ...(original.video && { video: original.video }), ...(original.image && { image: original.image }) };
          await copyForForward(original.id, { linkId: to, wireId, timestamp, file });
          try {
            await this.sendFile({ linkId: to, file, timestamp, forwarded: hops });
          } catch (error) {
            // Refused before it could start (the contact's app takes no files, a stopped chat): no message was kept, so
            // neither is the copy, and the chat says why.
            this.transfers.delete(file.id);
            await removeStored(file.id).catch(() => {});
            throw error;
          }
          result.messageIds.push(`me_${timestamp}`);
        } catch (error) {
          note(error instanceof Error ? error.message : String(error));
        }
      }
    }
    return { results };
  }
  /** How many edges took my message (or its edit number `edit`) so far: what `group send --wait sent` waits for. */
  groupTaken({ groupId, messageId, edit }: { groupId: string; messageId: string; edit?: number }): number { return this.groups.taken(groupId, messageId, edit); }

  /**
   * Reacts to a message of a chat or a group (WISP 400 § Reactions): shown here at once; a 1:1 chat keeps it until the
   * contact confirms it (the live session, or DHT envelopes meanwhile), a group sends it to its members.
   */
  async react({ linkId, messageId, emoji }: { linkId: string; messageId: string; emoji: string }): Promise<{ error: string | null; refused?: boolean }> {
    if (typeof linkId !== "string" || !linkId) return { error: "No chat to react in" };
    if (linkId.startsWith("group:")) {
      const groupId = linkId.slice("group:".length);
      // Not a member (removed, say): refused with the reason the group shows, and nothing is kept here.
      if (!this.membership(groupId)) return { error: this.groups.views().find(g => g.id === groupId)?.statusReason ?? "You are not in this group", refused: true };
      const result = await this.reactions.mine(linkId, messageId, emoji);
      return "error" in result ? result : this.sendGroupReaction(groupId, result.reaction);
    }
    const live = this.links.get(linkId);
    if (!live || live.stored.group) return { error: "No such chat" };
    // A compatibility chat's records have no room for one (WISP 402): said, rather than kept here only.
    if (!live.stored.profile) return { error: "Reactions need a current chat; this compatibility chat sends text only." };
    const result = await this.reactions.mine(linkId, messageId, emoji, live.stored.reactionsOut);
    if ("error" in result) return result;
    const reactionsOut = queueReaction(live.stored.reactionsOut ?? [], result.reaction);
    live.stored = { ...live.stored, reactionsOut };
    await db.patchLink(linkId, { reactionsOut });
    this.flushReactions(linkId);
    return { error: null };
  }

  /**
   * Says this side's reactions the contact has not confirmed: on the live session once both sides say `react/1`, at
   * the pace allowed, and again after a while when no receipt came. Off it, they ride on the DHT envelopes.
   */
  private flushReactions(linkId: string): void {
    const live = this.links.get(linkId), link = live?.link;
    const pending = live?.stored.reactionsOut ?? [];
    clearTimeout(this.reactionTimers.get(linkId));
    this.reactionTimers.delete(linkId);
    if (!link || !pending.length) return;
    if (!link.supportsReactions) { link.reactionsPending(); return; }
    let sent = this.reactionsSent.get(linkId);
    if (!sent) this.reactionsSent.set(linkId, sent = new Map());
    let pace = this.reactionPace.get(linkId);
    if (!pace) this.reactionPace.set(linkId, pace = new ReactionWindow(REACTION_LIMITS.send));
    const now = Date.now();
    let wait = REACTION_RESEND_MS;
    for (const reaction of pending) {
      const at = sent.get(reaction.n);
      if (at !== undefined && now - at < REACTION_RESEND_MS) { wait = Math.min(wait, at + REACTION_RESEND_MS - now); continue; }
      if (!pace.take()) { wait = Math.min(wait, pace.wait()); break; }
      if (link.sendReaction(reaction)) return;
      sent.set(reaction.n, now);
    }
    this.reactionTimers.set(linkId, setTimeout(() => this.flushReactions(linkId), Math.max(wait, 50)));
  }

  /** The contact confirmed this side's reaction `n` (on the DHT: every one up to `n`). */
  private async reactionReceipt(linkId: string, n: number, upTo = false): Promise<void> {
    const live = this.links.get(linkId);
    const before = live?.stored.reactionsOut ?? [];
    const reactionsOut = before.filter(r => upTo ? r.n > n : r.n !== n);
    if (!live || reactionsOut.length === before.length) return;
    live.stored = { ...live.stored, reactionsOut };
    for (const r of before) if (!reactionsOut.includes(r)) this.reactionsSent.get(linkId)?.delete(r.n);
    await db.patchLink(linkId, { reactionsOut });
    if (!reactionsOut.length) { clearTimeout(this.reactionTimers.get(linkId)); this.reactionTimers.delete(linkId); }
    // An envelope carries only so many: once the contact took those, the rest go.
    else if (upTo) this.flushReactions(linkId);
  }

  /** A group reaction goes to every member: over each edge in a private group, through the group in a community. */
  private async sendGroupReaction(groupId: string, reaction: WireReaction): Promise<{ error: string | null }> {
    if (this.groups.isCommunityGroup(groupId)) {
      try { await this.groups.sendCommunityApp(groupId, { t: COMMUNITY_REACTION_FRAME, ...wireReaction(reaction) }); return { error: null }; }
      catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
    }
    // Signed, so that hubs pass it on to members I have no edge with (older apps read the wire fields only).
    const frame = { t: GROUP_REACTION_FRAME, g: groupId, ...wireReaction(reaction), ...this.groups.signReaction(groupId, wireReaction(reaction)) };
    // An edge that is down hears it when it opens (`resendGroupReactions`).
    for (const edge of this.memberEdges(groupId).values()) { try { this.links.get(edge)?.link?.sendGroupFrame(frame); } catch { /* said again when it opens */ } }
    return { error: null };
  }

  /** An edge of a private group opened: the member hears my latest reactions again, in case it missed them. */
  private async resendGroupReactions(groupId: string, linkId: string): Promise<void> {
    if (this.outsideEdge(linkId)) return;
    const mine = groupReactionsToResend(await db.getMessages(`group:${groupId}`), REACTION_LIMITS.pending);
    for (const reaction of mine) { try { this.links.get(linkId)?.link?.sendGroupFrame({ t: GROUP_REACTION_FRAME, g: groupId, ...reaction, ...this.groups.signReaction(groupId, reaction) }); } catch { return; } }
  }

  /**
   * A reaction from a member of a group: over the edge pinned to them or signed and passed on by a hub (private, read by
   * `Groups`), or signed by them (community).
   */
  private async receiveGroupReaction(groupId: string, member: string, raw: Record<string, unknown> | WireReaction): Promise<void> {
    const membership = this.membership(groupId);
    if (!membership?.members.has(member) || member === membership.me) return;
    const reaction = readReaction(raw);
    if (reaction) await this.reactions.receive(`group:${groupId}`, member, reaction);
  }

  /**
   * Pins a message of a chat or a group, or unpins (WISP 400 § Pinned message): one per chat, the last pin winning. A
   * 1:1 chat keeps it until the contact confirms it on a live session; a group sends it to its members, where the rule
   * (`mayPin`) allows it.
   */
  async pinMessage({ linkId, messageId, remove }: { linkId: string; messageId?: string; remove?: boolean }): Promise<{ error: string | null }> {
    if (typeof linkId !== "string" || !linkId) return { error: "No chat to pin in" };
    const host = { messages: (chat: string) => db.getMessages(chat), message: (chat: string, id: string) => db.getMessage(chat, id) };
    if (linkId.startsWith("group:")) {
      const groupId = linkId.slice("group:".length), view = this.groups.views().find(g => g.id === groupId);
      if (!view || view.status !== "active") return { error: "You are not in this group" };
      if (!mayPinIn(view)) return { error: "Only the admin pins in a community" };
      const pin = await myPin(host, linkId, messageId, !!remove, this.groups.pinOf(groupId));
      if ("error" in pin) return pin;
      if (this.groups.isCommunityGroup(groupId)) {
        try { await this.groups.sendCommunityApp(groupId, { t: COMMUNITY_PIN_FRAME, id: pin.id, n: pin.n }); } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
        await this.groups.setPin(groupId, pin);
        return { error: null };
      }
      const frame = this.groups.pinFrame(groupId, pin);
      if (!frame) return { error: "You are not in this group" };
      await this.groups.setPin(groupId, { ...pin, k: frame.k, sig: frame.sig });
      // An edge that is down hears it when it opens (`edgeUp`).
      for (const member of this.memberEdges(groupId).keys()) this.sendGroupPinFrame(groupId, member);
      return { error: null };
    }
    const live = this.links.get(linkId);
    if (!live || live.stored.group) return { error: "No such chat" };
    if (!live.stored.profile) return { error: "Pins need a current chat; this compatibility chat sends text only." };
    const pin = await myPin(host, linkId, messageId, !!remove, live.stored.pin);
    if ("error" in pin) return pin;
    await this.keepLinkPin(linkId, pin, { id: pin.id, n: pin.n });
    this.flushPin(linkId);
    return { error: null };
  }

  /** Keeps a pin of a 1:1 chat when it is newer than the chat's; `out`: mine, to say until the contact confirms it. */
  private async keepLinkPin(linkId: string, pin: StoredPin, out?: WirePin): Promise<void> {
    const live = this.links.get(linkId);
    if (!live || !pinIsNewer(live.stored.pin, pin)) return;
    const patch = { pin, ...(out && { pinOut: out }) };
    live.stored = { ...live.stored, ...patch };
    await db.patchLink(linkId, patch);
    this.emitState();
  }

  /** Says my pin the contact has not confirmed, once both sides offer `pin/1`; again after a while with no receipt. */
  private flushPin(linkId: string): void {
    const live = this.links.get(linkId), pin = live?.stored.pinOut;
    clearTimeout(this.pinTimers.get(linkId));
    this.pinTimers.delete(linkId);
    // One whose number is no longer a safe integer (made past a pin no receiver takes now) is never taken: not said again.
    if (pin && !validReactionNumber(pin.n)) { void this.pinReceipt(linkId, pin.n); return; }
    if (!pin || !live.link?.supportsPins || live.link.sendPin(pin)) return;
    this.pinTimers.set(linkId, setTimeout(() => this.flushPin(linkId), PIN_LIMITS.resendMs));
  }

  /** The contact confirmed my pin `n`: it is not said again. */
  private async pinReceipt(linkId: string, n: number): Promise<void> {
    const live = this.links.get(linkId);
    if (live?.stored.pinOut?.n !== n) return;
    clearTimeout(this.pinTimers.get(linkId));
    this.pinTimers.delete(linkId);
    live.stored = { ...live.stored, pinOut: undefined };
    await db.patchLink(linkId, { pinOut: undefined });
  }

  /** A pin that came, as it is kept: who pinned, and its row when it is here. */
  private async pinCame(chat: string, by: string, pin: WirePin): Promise<StoredPin> {
    const row = await pinnedRow({ messages: c => db.getMessages(c), message: (c, id) => db.getMessage(c, id) }, chat, pin.id);
    return { id: pin.id, n: pin.n, by, at: Date.now(), ...(row && { messageId: row.id }) };
  }

  /**
   * A pin in a group: signed by `member` and passed on over the edge to `via.from` (private), or sealed by them to the
   * group (community). Kept when the rule allows that member and it is newer; a private group's goes on to the
   * other edges, so members with no edge to the pinner get it.
   */
  private async receiveGroupPin(groupId: string, member: string, pin: WirePin | null, via?: { from: string; frame: GroupPinFrame }): Promise<void> {
    const view = this.groups.views().find(g => g.id === groupId);
    if (!pin || !view?.myKey || view.status !== "active" || !view.members.some(m => m.key === member)) return;
    if (!mayPin(view.profile, member, view.members.find(m => m.role === "admin")?.key)) return;
    const kept = await this.pinCame(`group:${groupId}`, member === view.myKey ? "me" : member, pin);
    if (!await this.groups.setPin(groupId, { ...kept, ...(via && { k: via.frame.k, sig: via.frame.sig }) }) || !via) return;
    for (const key of this.memberEdges(groupId).keys()) if (key !== via.from && key !== member) this.sendGroupPinFrame(groupId, key);
  }

  /** A private group's pin, as its pinner signed it, over the edge to `member`; nothing when it is down (said when it opens). */
  private sendGroupPinFrame(groupId: string, member: string): void {
    const pin = this.groups.pinOf(groupId), edge = this.memberEdges(groupId).get(member);
    // One whose number does not hold counts as none: no member takes it.
    if (!pin?.k || !pin.sig || !edge || this.groups.isCommunityGroup(groupId) || !pinNumberHolds(pin.n)) return;
    const frame: GroupPinFrame = { t: "group-pin", g: groupId, id: pin.id, n: pin.n, k: pin.k, sig: pin.sig };
    try { this.links.get(edge)?.link?.sendGroupFrame(frame); } catch { /* said again when it opens */ }
  }
  leaveGroup({ groupId }: { groupId: string }): Promise<void> { return this.groups.leave(groupId); }
  removeGroupMember({ groupId, key }: { groupId: string; key: string }): Promise<void> { return this.groups.remove(groupId, key); }
  makeGroupAdmin({ groupId, key }: { groupId: string; key: string }): Promise<void> { return this.groups.makeAdmin(groupId, key); }
  /** The admin of a private group pins a member as a hub, excludes one, or leaves it to the member's app (`role` null). */
  setGroupHub({ groupId, key, role }: { groupId: string; key: string; role: "pin" | "exclude" | null }): Promise<void> { return this.groups.setHub(groupId, key, role); }
  rotateGroup({ groupId }: { groupId: string }): Promise<void> { return this.groups.rotate(groupId); }
  setGroupPicture({ groupId, picture }: { groupId: string; picture: string | null }): Promise<void> { return this.groups.setPicture(groupId, picture); }
  renameGroup({ groupId, name }: { groupId: string; name: string }): Promise<void> { return this.groups.rename(groupId, name); }
  forgetGroup({ groupId }: { groupId: string }): Promise<void> { this.groupEdits.forget(groupId); return this.groups.forget(groupId); }

  /** Rejects when the signal cannot go now (no live session): it is kept and goes on the next one while fresh. */
  async setCallSignal({ linkId, signal }: { linkId: string; signal: string | null }): Promise<void> {
    await this.links.get(linkId)?.link?.setCallSignal(signal);
  }

  /**
   * WISP 401 § Typing: a `stop` always goes (when a `start` stands); a `start` only while the setting is on, with
   * its kind and status checked here (an unknown kind is plain typing, a status with a link is dropped).
   */
  setTyping({ linkId, typing, kind, status }: { linkId: string; typing: boolean; kind?: TypingKind; status?: string }): void {
    const live = this.links.get(linkId);
    if (!live?.stored.profile || live.stored.group) return;
    if (typing === true && this.settings.sendTyping !== false) live.link?.setTyping(true, typingActivity(kind, status));
    else live.link?.setTyping(false);
  }

  /** WISP 9xx · Group Mesh § Typing: the same word in a private group, on its edges; a community says nothing yet. */
  setGroupTyping({ groupId, typing, kind, status }: { groupId: string; typing: boolean; kind?: TypingKind; status?: string }): void {
    if (typeof groupId !== "string") return;
    if (typing === true && this.settings.sendTyping !== false) this.groups.setTyping(groupId, true, typingActivity(kind, status));
    else this.groups.setTyping(groupId, false);
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

  /**
   * `network`: the Cashu wallet it is added from. A mint's network is its own (a test mint is Testnet's, any other
   * Mainnet's): one of the other network is refused, never filed into that network's wallet (which it would make,
   * unseen from the wallet it was added from). A test mint or one on this machine is known by its address, and is
   * refused from Mainnet before it is contacted. Any other address is Mainnet's only by default: from Testnet it is
   * contacted first, so a typo or a server that is not a mint is named as such, and it is called a mint of real sats
   * only once it answered as a mint.
   */
  async walletAddMint({ url, primary, network }: { url: string; primary?: boolean; network?: WalletNetwork }): Promise<{ url: string; name: string }> {
    const other = !!network && mintNetwork(normalizeMintUrl(url)) !== network;
    if (other && network === "mainnet") throw engineError("testMintOnMainnet");
    const mint = await this.wallet.checkMint(url);
    if (other) throw engineError("realMintOnTestnet");
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
    let card: string | undefined;
    try {
      if (type === "cashu") await this.createCashu(network);
      else if (type === "arkade") await this.creating(this.arkWallets[network], () => this.arkWallets[network].createDefaultNow());
      else if (type === "usdt") await this.creating(this.usdtWallets[network], () => this.usdtWallets[network].createDefaultNow());
      else if (type === "bark") await this.creating(this.barkWallets[network], () => this.barkWallets[network].createDefaultNow());
      else if (type === "spark") await this.creating(this.sparkWallets[network], () => this.sparkWallets[network].create({ network: sparkNetworkFor(network), apiKey: params.apiKey }));
      else if (type === "fedimint") {
        if (!params.invite?.trim()) throw new Error("Paste the federation's invite code (fed11…)");
        await this.creating(this.fedimintWallets[network], () => this.fedimintWallets[network].join(params.invite!));
        void this.lightnings[network].ensureReady();
      } else {
        const sources = type === "lightning" ? (await this.lightningCard(network)).sources : this.bitcoins[network].sources;
        const providerId = params.providerId ?? "";
        const descriptor = sources.view.offered.find((d) => d.id === providerId);
        if (!descriptor) throw new Error(`Choose a ${type === "lightning" ? "Lightning" : "Bitcoin"} source that runs on ${networkLabel(network)}`);
        // What the person left blank takes the network's default (a BDK wallet's chain), the rest as typed.
        const values = { ...Object.fromEntries(descriptor.fields.flatMap((f) => f.defaults?.[network] ? [[f.name, f.defaults[network]!]] : [])), ...(params.values ?? {}) };
        // Lightning: one more card, next to the network's others (the same source may be added again, not the same wallet).
        if (type === "lightning") card = await this.creating(this.lightnings[network], () => this.lightnings[network].add(providerId, values));
        else await this.creating(sources, () => sources.set(providerId, values));
      }
    } catch (error) {
      await this.refreshWallet();
      throw Object.assign(new Error(createFailure(label, error)), { cause: error });
    }
    await this.refreshWallet();
    const made = this.walletView.wallets?.find((w) => w.type === type && w.network === network && (card === undefined || w.card === card));
    if (!made) throw new Error(`The ${label} wallet did not come up. Nothing was lost: try again.`);
    // Made, by the first-run setup or by hand: the setup has nothing left to make of it (and never makes it again).
    await this.walletSetup.made(type, network);
    this.walletView = { ...this.walletView, setup: this.walletSetup.view() };
    return made;
  }

  /**
   * A creation that waits on the network gets `createTiming.timeoutMs`; then its waits are cut short, and what it did
   * decides (a wait cut short saves nothing). It is never raced: a wallet saved just in time is reported as made.
   */
  private async creating<T>(wallet: { cutShort(): void; resume(): void }, work: () => Promise<T>): Promise<T> {
    let late = false;
    const timer = setTimeout(() => { late = true; wallet.cutShort(); }, createTiming.timeoutMs);
    try { return await work(); }
    catch (error) { throw late && error instanceof ModeChanged ? new Error("It did not answer in time") : error; }
    finally { clearTimeout(timer); wallet.resume(); }
  }

  /**
   * "Get test coins", pressed by the person on a Testnet wallet: a small fixed amount from that wallet's own faucet.
   * Cashu, and Lightning through the mints: the test mint pays an invoice asked of it on purpose. USDT: Aave's Sepolia
   * faucet, paid with the wallet's own test ETH. Never Mainnet; nothing else asks a faucet, Receive included.
   */
  async walletTestCoins({ type, network, card }: WalletTestCoins): Promise<TestCoinsResult> {
    if (network !== "testnet") throw new Error("Test coins are for Testnet wallets only");
    if (type === "cashu" || (type === "lightning" && ((await this.lightningCard("testnet", card)).view.providerId ?? CASHU_MINT_SOURCE) === CASHU_MINT_SOURCE)) {
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
  async walletRemove({ type, network, acceptLoss, card: asked }: WalletRemove): Promise<void> {
    if (!WALLET_TYPES.includes(type)) throw new Error("Unknown kind of wallet");
    if (network !== "mainnet" && network !== "testnet") throw new Error("Choose Mainnet or Testnet");
    await this.lightnings[network].start();
    await this.refreshWallet();
    // A Lightning card: the one named, else the network's default for receiving (a caller from before cards).
    const card = type === "lightning" ? asked ?? this.lightnings[network].receivingId : undefined;
    const lightningName = card !== undefined ? this.walletView.networks?.[network].lightnings?.find((c) => c.card === card)?.name : undefined;
    // What goes, as a noun: a card is a card, not "the … card wallet".
    const label = lightningName ? `${networkLabel(network)} Lightning card “${lightningName}”` : `${networkLabel(network)} ${WALLET_NAMES[type]} wallet`;
    if (!this.walletView.wallets?.some((w) => w.type === type && w.network === network && (card === undefined || w.card === card))) throw new Error(`There is no ${label} to remove`);
    const first = walletRemoval(type, network, this.walletView.networks?.[network], this.walletView.intents, card);
    if (first.comesWith) throw new Error(`Lightning through the Cashu mints comes with your ${networkLabel(network)} Cashu wallet: remove that wallet to remove it`);
    // Ecash minted now is counted in what it holds, not deleted with its invoice.
    if (first.awaiting.length) { await this.claimPaid(type, network, card); await this.refreshWallet(); }
    const removal = first.awaiting.length ? walletRemoval(type, network, this.walletView.networks?.[network], this.walletView.intents, card) : first;
    if (removal.pending) throw new Error(`A payment through this wallet is not finished yet (${removal.pending}). Cancel it or wait for it to settle, then remove the wallet.`);
    if (removalRisksFunds(removal) && acceptLoss !== true) throw new Error(lossRefusal(label, removal));
    // Its open requests close first, while the chats still carry payment frames: once its last wallet goes, a chat
    // may have no way of paying left, and the contact would never hear of it.
    for (const item of removal.awaiting) if (item.kind === "request" && item.paymentId) await this.closeRequest(item.paymentId, `you removed the ${label} it was paid to`).catch(() => {});
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
      else if (type === "lightning") await this.lightnings[network].remove(card!);
      else await this.bitcoins[network].sources.clear();
    } finally {
      await this.refreshWallet();
    }
    // Another Lightning card of the network still takes what the chats accept on it.
    if (!this.walletView.wallets?.some((w) => w.type === type && w.network === network)) await this.forgetChatNetwork(type as PaymentMethodName, network);
    // Its backup reminder goes with it: another wallet of the kind has its own phrase, and asks again.
    const reminders = this.settings.backupReminders;
    if (reminders && type !== "lightning" && `${type}:${network}` in reminders) { await this.saveBackups(forgetWallet(reminders, `${type}:${network}`)); this.emitState(); }
  }

  /**
   * Before a wallet goes: its own rail is asked about what was paid to it (the mints about its quotes, the source about
   * its invoices, the chain or server about its requests), so money already there is claimed. Bounded: a mint or a
   * server that does not answer leaves what it holds as it was, still counted as awaited.
   */
  private async claimPaid(type: WalletType, network: WalletNetwork, card?: string): Promise<void> {
    const work = type === "cashu" ? this.wallet.checkQuotes(this.networkMints(network))
      : type === "lightning" ? this.lightnings[network].card(card).reconcile()
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
      // Spark on Mainnet runs on the person's own Breez API key: New asks for it.
      if (type === "spark" && network === "mainnet") offers.push({ ...base, available: true, needs: "apiKey" });
      else if (type === "fedimint") offers.push({ ...base, available: true, needs: "invite" });
      else if (type === "lightning") {
        // A network takes several Lightning cards. The Cashu mints' one comes with a Cashu wallet, and is offered again
        // only to a network that has mints and no such card.
        const cards = this.lightnings[network], cashuCard = !cards.has(CASHU_CARD) && this.networkMints(network).length > 0;
        const providers = view.lightning?.offered.filter((d) => d.id !== CASHU_MINT_SOURCE || cashuCard) ?? [];
        const custom = (view.lightnings ?? []).some((c) => c.providerId !== CASHU_MINT_SOURCE);
        offers.push(providers.length ? { ...base, exists: custom, several: true, available: true, needs: "provider", providers } : { ...base, exists: custom, several: true, available: false, reason: `No Lightning source runs on ${networkLabel(network)} here yet` });
      } else if (type === "bitcoin") {
        const providers = view.bitcoin?.offered ?? [];
        offers.push(providers.length ? { ...base, available: true, needs: "provider", providers } : { ...base, available: false, reason: `No on-chain wallet runs on ${networkLabel(network)} here yet` });
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

  /**
   * Removes one mint of a Cashu wallet. Never one that holds sats, nor a network's last mint (that removes the Cashu
   * wallet: `walletRemove`). One that still waits for money (an invoice not paid yet, paid ecash not claimed) goes
   * only with `acceptLoss`: what is paid to it afterwards is claimed, but shows only once the mint is added again.
   */
  async walletRemoveMint({ url, acceptLoss }: { url: string; acceptLoss?: boolean }): Promise<void> {
    const network = mintNetwork(url);
    const mints = this.networkMints(network);
    if (mints.length === 1 && mints[0] === url) throw engineError("lastMint", { network: networkLabel(network) });
    if ((await this.wallet.balanceAt(url)) > 0) throw engineError("mintHoldsSats");
    const waits = async () => mintAwaiting(url, { network, quotes: await this.wallet.quotes(), payments: this.desk.records(), now: Date.now() });
    if ((await waits()).length) {
      // What was already paid to it is claimed first, even when the person agreed: sats that came in meanwhile are
      // what it holds now, and it is never removed holding them.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.wallet.checkQuotes([url]).catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, removalTiming.claimMs); })]);
      clearTimeout(timer);
      if ((await this.wallet.balanceAt(url)) > 0) { await this.refreshWallet(); throw engineError("mintHoldsSats"); }
      const awaiting = await waits();
      if (awaiting.length && acceptLoss !== true) {
        const listed = awaiting.map((a) => { const text = ENGLISH_REMOVAL.item(a.kind, ENGLISH_REMOVAL.sats(a.amount, network)); return text.charAt(0).toLowerCase() + text.slice(1); }).join("; ");
        throw new Error(`This mint still waits for money: ${listed}. Confirm that what is paid to it afterwards shows only once you add the mint again to remove it.`);
      }
    }
    await this.updateSettings({ settings: { mints: this.settings.mints.filter((m) => m !== url) } });
    await this.refreshWallet();
  }

  /**
   * `via: "cashu"`: ecash straight from the network's mints (the Cashu card). Otherwise the Lightning card named, or the
   * network's default for receiving.
   */
  async walletReceiveLightning({ amount, via, network, card }: { amount: number; via?: "cashu"; network?: WalletNetwork; card?: string }) {
    const n = this.net(network);
    // A new invoice is money the wallet now waits for: removing it must say so at once, not after something else changed.
    if (via === "cashu") {
      const quote = await this.wallet.receiveLightning(amount, undefined, n);
      this.awaitingSoon();
      return { quote: quote.quote, invoice: quote.invoice, expiresAt: quote.expiresAt, source: CASHU_MINT_SOURCE };
    }
    const created = await (await this.lightningCard(n, card)).createInvoice(amount);
    this.awaitingSoon();
    return { quote: created.paymentHash, invoice: created.invoice, expiresAt: created.expiresAt, paymentHash: created.paymentHash, source: created.source };
  }

  /** `card`: the Lightning card that will pay; absent, the network's default one. */
  walletQuoteInvoice({ invoice, via, network, card }: { invoice: string; via?: "cashu"; network?: WalletNetwork; card?: string }) {
    const n = this.net(network);
    return via === "cashu" ? this.wallet.quoteInvoice(invoice, n) : this.lightningCard(n, card).then((c) => c.quote(invoice));
  }

  /** `confirmedReal`: the person confirmed a Mainnet payment as real money; without it one is refused. */
  async walletPayQuote({ quote, mint, note, confirmedReal }: { quote: string; mint: string; note?: string; confirmedReal?: boolean }) {
    // A quote of a Lightning card (each knows its own), or a melt quote the Cashu card asked the mints for.
    const network = WALLET_NETWORKS.find((n) => this.lightnings[n].withQuote(quote));
    const lightning = network && this.lightnings[network].withQuote(quote);
    assertConfirmedReal(network ?? mintNetwork(mint), confirmedReal);
    return { paid: lightning ? await lightning.pay(quote, { note }) : await this.wallet.payQuote(quote, mint, note) };
  }

  /** A Lightning address or LNURL (LUD-16, LUD-06): resolved here, in the engine, so every platform fetches the same way. */
  lnurlResolve({ text, network }: { text: string; network?: WalletNetwork }) { return this.lightnings[this.net(network)].resolveDestination(text); }
  lnurlInvoice({ id, amount, comment, network }: { id: string; amount: number; comment?: string; network?: WalletNetwork }) { return this.lightnings[this.net(network)].destinationInvoice(id, amount, comment); }
  /** A Lightning card of a network (the default for receiving without `card`), once the network's cards are open. */
  private async lightningCard(network: WalletNetwork, card?: string) { const cards = this.lightnings[network]; await cards.start(); return cards.card(card); }
  /** The Lightning card that holds this quote, or a refusal: nothing is paid without one. */
  private lightningQuote(network: WalletNetwork, quote: string) {
    const card = this.lightnings[network].withQuote(quote);
    if (!card) throw new Error("This quote is no longer valid: check the invoice again");
    return card;
  }

  checkPayment(params: { linkId: string; paymentId: string }) { return this.desk.checkPayment(params); }

  /**
   * A card's source with new values of its form (secrets are sealed): the same provider only, a card keeps its source.
   * Without `card` (a caller from before cards), "this network's Lightning goes through `providerId`": the card of
   * that very wallet, or a new one, becomes the default for receiving.
   */
  async lightningSetSource({ providerId, values, network, card }: { providerId: string; values: Record<string, string>; network?: WalletNetwork; card?: string }) {
    const cards = this.lightnings[this.net(network)];
    const target = await this.lightningCard(this.net(network), card);
    if (card !== undefined) {
      if (target.view.providerId !== providerId || providerId === CASHU_MINT_SOURCE) throw new Error("A card keeps its source: add another card with New");
      await target.sources.set(providerId, values);
    } else if (providerId === CASHU_MINT_SOURCE) await this.lightningClearSource({ network });
    else await cards.setReceive((await cards.findSame(providerId, values)) ?? (await cards.add(providerId, values)));
    await this.refreshWallet();
  }
  /**
   * Back to the Cashu mints (a caller from before cards): the card named, else the default for receiving, is removed,
   * and the Cashu card becomes the default for receiving.
   */
  async lightningClearSource(params?: { network?: WalletNetwork; card?: string }) {
    const network = this.net(params?.network), cards = this.lightnings[network];
    await cards.start();
    const id = params?.card ?? cards.receivingId;
    if (id !== CASHU_CARD) await cards.remove(id);
    if (!cards.has(CASHU_CARD) && this.networkMints(network).length) await cards.add(CASHU_MINT_SOURCE, {});
    if (cards.has(CASHU_CARD) && this.networkMints(network).length) await cards.setReceive(CASHU_CARD);
    await this.refreshWallet();
  }
  async lightningRetrySource(params?: { network?: WalletNetwork; card?: string }) { await (await this.lightningCard(this.net(params?.network), params?.card)).sources.retryNow(); await this.refreshWallet(); }
  async lightningReconfigureSource({ values, network, card }: { values: Record<string, string>; network?: WalletNetwork; card?: string }) { await (await this.lightningCard(this.net(network), card)).sources.reconfigure(values); await this.refreshWallet(); }
  async lightningRefresh(params?: { network?: WalletNetwork; card?: string }) { const lightning = await this.lightningCard(this.net(params?.network), params?.card); await lightning.sources.refresh(); await lightning.reconcile(); }
  /** Makes a card its network's default for receiving: chat requests and Receive use it unless another is picked. */
  async lightningSetReceive({ network, card }: { network: WalletNetwork; card: string }) { await this.lightnings[this.net(network)].setReceive(card); await this.refreshWallet(); }
  async lightningRename({ network, card, name }: { network: WalletNetwork; card: string; name: string }) { await this.lightnings[this.net(network)].rename(card, name); await this.refreshWallet(); }
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
  usdtReveal(params: { password?: string; network?: WalletNetwork }) { return this.copied("usdt", params?.network, () => this.usdtWallets[this.net(params?.network)].reveal(params?.password)); }
  usdtLock(params?: { network?: WalletNetwork }) { return this.usdtWallets[this.net(params?.network)].lock(); }
  usdtRefresh(params?: { network?: WalletNetwork }) { return this.usdtWallets[this.net(params?.network)].refresh(); }
  usdtExportBackup(params: { password: string; network?: WalletNetwork }) { return this.copied("usdt", params.network, () => this.usdtWallets[this.net(params.network)].exportBackup(params.password)); }
  async usdtRestoreBackup(params: { text: string; password: string; network?: WalletNetwork }) { const { wallet } = await this.restoreInto(this.usdtWallets, params.network, (w) => w.restoreBackup(params.text, params.password)); await wallet.ensureReady(); }
  arkCreate(params: Parameters<EngineApi["arkCreate"]>[0]) { return this.arkWallets[arkMode(params.network)].create(params); }
  arkUnlock(params: { password: string; network?: WalletNetwork }) { return this.arkWallets[this.net(params.network)].unlock(params.password); }
  arkLock(params?: { network?: WalletNetwork }) { return this.arkWallets[this.net(params?.network)].lock(); }
  arkBackup(params: { password?: string; network?: WalletNetwork }) { return this.copied("arkade", params?.network, () => this.arkWallets[this.net(params?.network)].backup(params?.password)); }
  arkExportBackup(params: { password: string; network?: WalletNetwork }) { return this.copied("arkade", params.network, () => this.arkWallets[this.net(params.network)].exportBackup(params.password)); }
  async arkRestoreBackup(params: { text: string; password: string; network?: WalletNetwork }) { const { wallet } = await this.restoreInto(this.arkWallets, params.network, (w) => w.restoreBackup(params.text, params.password)); await wallet.ensureReady(); }
  arkRefresh(params?: { network?: WalletNetwork }) { return this.arkWallets[this.net(params?.network)].refresh(); }
  arkRecover(params?: { network?: WalletNetwork }) { return this.arkWallets[this.net(params?.network)].recover(); }
  barkCreate(params: Parameters<EngineApi["barkCreate"]>[0]) { return this.barkWallets[barkMode(params.network)].create(params); }
  barkBackup(params?: { network?: WalletNetwork }) { return this.copied("bark", params?.network, () => this.barkWallets[this.net(params?.network)].backup()); }
  barkExportBackup(params: { password: string; network?: WalletNetwork }) { return this.copied("bark", params.network, () => this.barkWallets[this.net(params.network)].exportBackup(params.password)); }
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
  /** `confirmedReal`: notes of a Mainnet federation are real money, handed over as text; without it they are refused. */
  async fedimintSpendNotes(params: { federation: string; amount: number; confirmedReal?: boolean }) {
    const wallet = this.fedimintOf(params.federation) ?? this.fedimintWallets.mainnet;
    // Mainnet when the wallet is, or when the federation itself says Bitcoin: either one is real money.
    const network = wallet.network === "mainnet" || wallet.federation(params.federation)?.network === "bitcoin" ? "mainnet" : wallet.network;
    assertConfirmedReal(network, params.confirmedReal);
    const { notes, operationId } = await wallet.spendNotes(params.federation, params.amount);
    return { notes, operation: operationId };
  }
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
  fedimintBackup(params?: { network?: WalletNetwork }) { return this.copied("fedimint", params?.network, () => this.fedimintWallets[this.net(params?.network)].backup()); }
  fedimintExportBackup(params: { password: string; network?: WalletNetwork }) { return this.copied("fedimint", params.network, () => this.fedimintWallets[this.net(params.network)].exportBackup(params.password)); }
  async fedimintRestoreBackup(params: { text: string; password: string; network?: WalletNetwork }) { return (await this.restoreInto(this.fedimintWallets, params.network, (w) => w.restoreBackup(params.text, params.password))).result; }
  fedimintRestorePhrase(params: { mnemonic: string; invites: string[]; network?: WalletNetwork }) { return this.fedimintWallets[this.net(params.network)].restorePhrase(params.mnemonic, params.invites); }
  /** A Spark wallet on the chain named (Mainnet with a Breez API key), or one restored from a phrase. */
  async sparkCreate(params: Parameters<EngineApi["sparkCreate"]>[0]) { await this.sparkWallets[sparkMode(params.network)].create(params); }
  async sparkBackup(params?: { network?: WalletNetwork }) { const { mnemonic, network } = await this.copied("spark", params?.network, () => this.sparkWallets[this.net(params?.network)].backup()); return { mnemonic, network }; }
  sparkExportBackup(params: { password: string; network?: WalletNetwork }) { return this.copied("spark", params.network, () => this.sparkWallets[this.net(params.network)].exportBackup(params.password)); }
  async sparkRestoreBackup(params: { text: string; password: string; apiKey?: string; network?: WalletNetwork }) { const { wallet } = await this.restoreInto(this.sparkWallets, params.network, (w) => w.restoreBackup(params.text, params.password, params.apiKey)); await wallet.ensureReady(); }
  sparkRefresh(params?: { network?: WalletNetwork }) { return this.sparkWallets[this.net(params?.network)].refresh(); }
  /**
   * One seed for both: the Spark wallet of a network becomes that network's Breez Lightning source too. The SDK is
   * shared (same seed, same storage), so there is one wallet and one balance behind the Spark and Lightning cards.
   */
  async sparkUseForLightning(params?: { network?: WalletNetwork }) {
    const network = this.net(params?.network);
    const { mnemonic, apiKey } = await this.sparkWallets[network].backup();
    await this.lightningSetSource({ providerId: BREEZ_SOURCE, values: { mnemonic, ...(apiKey ? { apiKey } : {}) }, network });
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
        if(request.lightningPending || Object.values(this.desk.views()).some(p=>p.kind==="payment" && p.requestId===request.id && p.linkId===params.linkId && !["failed","reclaimed"].includes(p.state)))throw engineError("requestPaymentInFlight");
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
      if(!link || (intent.review.method==="arkade" && !link.supportsArkPayments))throw engineError("reconnectBeforeApprove");
      // A request closed or paid meanwhile says so first: the contact may have turned that way of paying off because of it.
      if (intent.review.requestId) {
        const request = this.desk.payment(intent.review.requestId);
        if (!request || request.state !== "pending" || request.lightningPending) throw engineError("requestNotAwaiting");
      }
      // Reach the contact first, as preparing does: until the chat is live again (after a restart, say), its ways of
      // paying are not known, and Cashu would read as off.
      await link.requirePaymentSupport();
      if(intent.review.method==="usdt" && !link.supportsUsdtPayments)throw new Error("Reconnect a peer supporting USDT before approving");
      if(intent.review.method==="bark" && !link.supportsBarkPayments)throw new Error("Reconnect a peer supporting Bark before approving");
      if(intent.review.method==="bitcoin" && !link.supportsBitcoinPayments)throw new Error("Reconnect a peer taking on-chain Bitcoin before approving");
      if(intent.review.method==="fedimint" && !link.supportsFedimintPayments)throw new Error("Reconnect a peer taking Fedimint before approving");
      if(intent.review.method==="spark" && !link.supportsSparkPayments)throw new Error("Reconnect a peer taking Spark before approving");
      if(intent.review.method==="cashu" && !link.allowsPayment("cashu"))throw new Error("Cashu is off in this chat");
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
  /**
   * Reviews left pending that no Approve can send: past their expiry (a direct send reviewed and never approved, say),
   * or for a request paid some other way or closed meanwhile. Cancelled as Cancel does, so nothing they reserved stays
   * held and they leave the wallet's list of payments to finish; each stays in the store as cancelled. A review
   * approved, submitted or of unknown outcome is never touched.
   */
  async dropStaleReviews(now = Date.now()): Promise<PaymentReview[]> {
    if (this.shuttingDown) return [];
    return this.paymentCoordinator.dropStale(now, (review) => {
      const request = review.requestId ? this.desk.payment(review.requestId) : undefined;
      return !!request && request.linkId === review.linkId && (request.state === "settled" || !!request.closed);
    }).catch(() => []);
  }

  /** `network`: the Cashu card of that network sends (its mints). `confirmedReal`: required on Mainnet. */
  sendPayment(params: { linkId: string; amount: number; memo?: string; timestamp: number; network?: WalletNetwork; confirmedReal?: boolean }) {
    const live = this.links.get(params.linkId);
    // Ecash is a bearer token: it is never held for an away contact, only a request for it is.
    if (live && this.holdingFor(live)) throw new Error("Ecash is not held for an away contact. Send a request instead, or wait until they are back.");
    return this.desk.send({ ...params, network: this.net(params.network) });
  }

  /** `network`: the card's network; the request is paid only by a wallet of that network. */
  /** `card`: the Lightning card the request's invoice comes from; absent, the network's default for receiving. */
  requestPayment(params: { linkId: string; amount: number; memo?: string; timestamp: number; method?: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin" | "fedimint" | "spark"; rail?: "cashu" | "lightning"; network?: WalletNetwork; card?: string }) {
    return this.desk.request({ linkId: params.linkId, amount: params.amount, memo: params.memo, timestamp: params.timestamp, method: params.method, network: this.net(params.network), card: params.card,
      ...(params.rail === "cashu" || params.rail === "lightning" ? { rail: params.rail } : {}) });
  }

  /** A request any member of a group may pay, once (WISP 9xx § Payments). */
  requestGroupPayment(params: { groupId: string; amount: number; memo?: string; timestamp: number; rail: "cashu" | "lightning"; network?: WalletNetwork; card?: string }) {
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

  /**
   * `network`: the card chosen to pay; a request of the other network is refused, nothing spent. `card`: the Lightning card
   * that pays; absent, the network's default one. `confirmedReal`: required on Mainnet.
   */
  payRequest(params: { linkId: string; paymentId: string; via?: "lightning"; maxFee?: number; network?: WalletNetwork; confirmedReal?: boolean; card?: string }) {
    return this.desk.payRequest(params);
  }

  async reclaimPayment({ paymentId }: { paymentId: string }): Promise<void> {
    await this.desk.reclaim(paymentId);
    await this.reviewTakenBack(paymentId);
  }

  /**
   * A reviewed payment whose ecash this wallet took back: its review ends failed, at once. The mint reads that ecash
   * spent (this wallet redeemed it), which the review would otherwise take for the contact being paid, and a request
   * whose review reads paid can never be reviewed again. Only when the ecash is back for certain (`reclaimed`).
   */
  private async reviewTakenBack(id: string): Promise<void> {
    if (this.desk.payment(id)?.state !== "reclaimed") return;
    const intent = await intentRepository.get(id);
    if (!intent || intent.review.method !== "cashu" || !["submitted", "unknown", "settled"].includes(intent.review.state)) return;
    await intentRepository.put({ ...intent, review: { ...intent.review, state: "failed", error: engineText("paymentTakenBack") } });
    this.emitState();
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
    // The backup reminders are the engine's: only a wallet's backup, a profile backup or "Later" changes them.
    delete settings.backupReminders;
    const wasOnline = this.networkOn;
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
    if (settings.pushRelay !== undefined) {
      if (typeof settings.pushRelay !== "string") throw new Error("Enter a relay address (https://…)");
      settings.pushRelay = settings.pushRelay.trim();
      const problem = settings.pushRelay && pushRelayProblem(settings.pushRelay);
      if (problem) throw new Error(problem);
    }
    // Only through setWakeSubscription, which checks it and gives every chat a new token.
    delete (settings as Partial<Settings>).wake;
    delete (settings as Partial<Settings>).wakeRotate;
    delete (settings as Partial<Settings>).wakeMutedGroups;
    delete (settings as Partial<Settings>).wakeHeldBy;
    // The first-run wallet setup's record: the engine's alone.
    delete (settings as Partial<Settings>).walletSetup;
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
    // Send typing indicator: absent means on; turned off, a `start` standing anywhere is ended now.
    if (settings.sendTyping !== undefined) {
      if (settings.sendTyping !== false) delete this.settings.sendTyping;
      else this.settings.sendTyping = false;
      await db.putSettings(this.settings);
      if (settings.sendTyping === false) { for (const live of this.links.values()) live.link?.setTyping(false); this.groups.stopTyping(); }
    }
    // Load public profiles: absent means on; turned off, nothing read before is kept.
    if (settings.publicProfiles !== undefined) {
      if (settings.publicProfiles !== false) delete this.settings.publicProfiles;
      else this.settings.publicProfiles = false;
      await db.putSettings(this.settings);
      if (settings.publicProfiles === false) { await this.publicProfiles.clear(); this.publicActivity.clear(); }
    }
    // Contacts connected now are told at once, the others on their next session.
    if (settings.avatar !== undefined || settings.shareProfile !== undefined) {
      for (const live of this.links.values()) if (!this.quietEdge(live.stored)) live.link?.setAvatar(this.sharedAvatar);
    }
    if (settings.nick !== undefined || settings.shareProfile !== undefined) {
      // GhostLink tells a paired peer directly; a legacy one still reads the record.
      for (const live of this.links.values()) if (!this.quietEdge(live.stored)) live.link?.setNick(this.sharedNick);
      // A chat that is not live learns the name from the capability record.
      this.capsChanged();
    }
    if (settings.hyperdhtRelay !== undefined) {
      // The default is kept as no setting at all, so a later default reaches whoever never chose.
      if (settings.hyperdhtRelay === DEFAULT_HYPERDHT_RELAY) delete this.settings.hyperdhtRelay;
      await db.putSettings(this.settings);
      if (this.hyperdhtRelay !== relayBefore && this.networkOn) await this.relayChanged();
    }
    if (settings.pushRelay !== undefined) {
      if (!this.settings.pushRelay) delete this.settings.pushRelay;
      await db.putSettings(this.settings);
    }
    if (settings.holdStorage !== undefined) {
      if (!this.settings.holdStorage) delete this.settings.holdStorage;
      await db.putSettings(this.settings);
      this.hold.storageChanged();
    }
    if (wasOnline && !this.networkOn) {
      await Promise.allSettled(
        [...this.links.values()].map(async (live) => {
          await live.link?.stop(true); await live.caps?.stop(); live.caps = undefined;
          live.link = null;
          live.status = "offline";
          live.dataLink = "idle";
        }),
      );
    } else if (!wasOnline && this.networkOn) {
      for (const live of this.links.values()) this.startLink(live.stored.id, await db.getMessages(live.stored.id));
      this.hold.start();
      this.startGroupEntries();
      this.prepareSpare(STARTUP_QUIET_MS);
      void this.did.publishNow().catch(() => {});
    }
    if (wasOnline && !this.networkOn) this.stopGroupEntries();
    if (wasOnline && !this.networkOn) await this.hold.stop();
    this.emitState();
  }

  // -- internals -----------------------------------------------------------

  /**
   * A chat is in `links` the moment it is being added, before it is saved and started. Another ensureLink or
   * joinLink for it meanwhile (a sync, the automatic "joined" message) waits for that here, rather than taking
   * an id whose chat cannot send yet ("You are offline"), and fails with it if it fails.
   */
  private linksAdding = new Map<string, Promise<string>>();
  private async existingLink(id: string): Promise<string> {
    return (await this.linksAdding.get(id)) ?? id;
  }

  private addLink(params: LinkParams, inviteCode?: string): Promise<string> {
    const id = identityFromSeedB64(params.seedB64).pubKeyZ32.slice(0, 16);
    const adding = this.addLinkNow(params, inviteCode).finally(() => { if (this.linksAdding.get(id) === adding) this.linksAdding.delete(id); });
    this.linksAdding.set(id, adding);
    return adding;
  }

  private async addLinkNow({ participationSeedB64, ...params }: LinkParams, inviteCode?: string): Promise<string> {
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
    if (this.networkOn) this.startLink(stored.id, []);
    // The other side is due any moment: the joiner's inviter is polling for this very moment and its offer
    // (or its answer) is a poll away; an inviter's contact is reading the invite right now more often than
    // not. Both look fast for a while, as a group's entry session does.
    if (params.profile) this.links.get(stored.id)?.link?.expectPeer();
    if (params.profile && inviteCode && this.networkOn) this.warmInviteKey(inviteCode);
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
      this.warmKey(identity);
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
    this.edgeRtcOff.delete(linkId);
    this.groupWakeReceived.delete(linkId);
    this.quietEdges.delete(linkId);
    // Its native slot, if it held one, is free: a group link waiting for one tries at the next tick.
    this.groupNativeWaiting.delete(linkId);
    this.groupNativeRetryAt = 0;
    // A member who held the subscription and is no longer in the group (removed, or I left): the app replaces it.
    // An edge a group on hubs no longer keeps is still a member's: nothing to replace.
    // An edge a group on hubs no longer keeps is still a member's: it is remembered as holding the subscription, which
    // is replaced once that member leaves the roster (`groupMembersChanged`).
    if (live.stored.wakeToken && this.meshEdge(live.stored)) {
      const group = live.stored.group, peer = live.stored.groupPeer!;
      if (!this.membership(group)?.members.has(peer)) void this.rotateWake().then(() => this.emitState());
      else if (this.settings.wake && !this.settings.wakeHeldBy?.[group]?.includes(peer)) {
        this.settings = { ...this.settings, wakeHeldBy: { ...this.settings.wakeHeldBy, [group]: [...this.settings.wakeHeldBy?.[group] ?? [], peer] } };
        await db.putSettings(this.settings);
      }
    }
    // An entry session is over once the admission is (or was given up): nobody waits on it, so it goes
    // without a last packet saying so, which would only spend two of the relays' requests at a busy moment.
    await live.link?.stop(!live.stored.groupEntry); await live.caps?.stop();
    await db.deleteLink(linkId);
  }

  /**
   * An edge's session opened or ended: kept, so that an app starting again knows which edges were live when it quit
   * (`edgeLive`, `resume`). Nothing is written while the app shuts down: an edge live then was live when it quit.
   */
  private noteEdgeLive(linkId: string, up: boolean): void {
    const live = this.links.get(linkId);
    if (!live || this.shuttingDown || !!live.stored.edgeLive === up) return;
    const since = up ? Date.now() : undefined;
    live.stored = { ...live.stored, edgeLive: up || undefined, edgeLiveSince: since };
    void db.patchLink(linkId, { edgeLive: up || undefined, edgeLiveSince: since }).catch(() => {});
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
    if (this.networkOn) this.startLink(id, []);
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
    if (this.networkOn) this.startLink(id, []);
    // The other side is due any moment (the admin's app answers a knock in seconds): look fast meanwhile.
    this.links.get(id)?.link?.expectPeer();
    return id;
  }

  private startGroupEntries(): void {
    if (this.groupEntryTimer || this.shuttingDown || this.options.deferGroups) return;
    this.groupEntryTimer = setInterval(() => { void this.groups.tick().catch(() => {}); this.retryGroupNative(); }, 1_000);
  }
  private stopGroupEntries(): void {
    if (this.groupEntryTimer) clearInterval(this.groupEntryTimer);
    this.groupEntryTimer = null;
  }

  private startEdge(linkId: string): void {
    const live = this.links.get(linkId);
    if (!live || live.link || this.options.deferGroups) return;
    const { stored } = live;
    const group = stored.group!, peer = stored.groupPeer!, entry = !!stored.groupEntry;
    const role = stored.groupEntry ?? "edge";
    // A private group's edge to someone out of its roster (a member removed while away, kept to tell it so:
    // `StoredGroup.farewells`) carries the group's own frames only, which `Groups` answers: no payment, no note about
    // one, no reaction said again, no way to wake this app.
    const member = () => entry || this.groups.isCommunityGroup(group) || this.groups.inRoster(group, peer);
    let seen = false;
    // Native where one side has no WebRTC (WISP 9xx § Transports): an edge back after a restart resumes on a native transport both run.
    const native = this.keepsGroupNative(stored);
    const resumeOn: PairedTransport | undefined = native
      ? TRANSPORTS.find(t => t !== "webrtc/1" && t in this.nativeFactories && !!stored.peerTransports?.includes(t)) : "webrtc/1";
    live.pairing = { status: "connecting" };
    live.link = new GhostLink({
      ownRecords: true,
      // An edge carries payments with its member (WISP 9xx § Payments), as a chat does; an entry session does not.
      paymentMethods: entry ? { cashu: false, lightning: false, arkade: false, usdt: false, bark: false, bitcoin: false, fedimint: false, spark: false } : stored.paymentMethods,
      arkPaymentsSupport: !entry,
      usdtPaymentsSupport: !entry,
      barkPaymentsSupport: !entry,
      params: stored,
      rtcAvailable: typeof RTCPeerConnection !== "undefined" && !this.edgeRtcOff.has(linkId),
      // Live when this app last ran: the member likely watches for this app to come back, and is dialled at once,
      // whichever end's turn it is, rather than left to its offer and a read at the background pace (WISP 100).
      // WebRTC, unless one side has none: then the native transport both run.
      resume: !entry && stored.edgeLive ? resumeOn : undefined,
      // How the member's app said to dial it, where one side has no WebRTC (`_tr`, `onPacketTransports`).
      native: { peerDescriptors: stored.peerDescriptors, peerTransports: stored.peerTransports, peerFallback: stored.peerFallback, automatic: true },
      packetTransports: !this.options.webrtcGroupLinks,
      // An offer from before that session began is not answered after a restart (a relay that missed its clearing).
      resumeFloor: !entry && stored.edgeLive ? stored.edgeLiveSince : undefined,
      // Pinned in advance to the member the roster names: there is nothing to trust on first use.
      pairing: { credentials: { seedB64: stored.participationSeed!, peerKey: peer, requireSignedSignals: true, verifiedPeerKey: peer },
        pinPeer: async key => { if (key !== peer) throw new Error("Not the member this edge belongs to"); }, trustOnFirstUse: false },
      transport: this.groupTransport,
      nick: !entry && this.quietEdge(stored) ? undefined : this.sharedNick,
      // A private group's edges look at Pkarr more slowly as it grows: one edge per member (WISP 9xx § Cost per member).
      pollIntervals: entry || this.groups.isCommunityGroup(group) ? this.pollIntervals : meshEdgeIntervals(this.pollIntervals, () => this.groups.meshSize(group)),
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
          : !member() ? this.groups.handleEdgeFrame(group, peer, frame)
          : (frame as { t?: unknown }).t === "group-pay" ? this.groupPayments.receive(group, peer, frame)
          : (frame as { t?: unknown }).t === GROUP_WAKE_FRAME ? this.receiveGroupWake(linkId, frame as Record<string, unknown>)
          : this.groups.handleEdgeFrame(group, peer, frame),
        onGroupsSupport: supported => {
          if (supported) traceJoin(group, "link.ready", { role });
          if (!entry) this.noteEdgeLive(linkId, supported);
          if (supported) {
            if (entry) this.groups.entryReady(group, linkId, peer);
            else if (!member()) this.groups.edgeReady(group, peer, linkId);
            else {
              this.groups.edgeReady(group, peer, linkId); void this.groupPayments.edgeReady(group, linkId).catch(() => {});
              if (!this.groups.isCommunityGroup(group)) void this.resendGroupReactions(group, linkId).catch(() => {});
              // Live again: the next mention while it is away may wake it at once; and it learns how to wake me.
              this.groupWakeLimiter.reset(peer);
              void this.shareGroupWake(linkId).catch(() => {});
            }
          }
          this.emitState();
        },
        // The member's packet says what its app runs here: one with no WebRTC is reached over a native transport, and
        // this side starts its endpoints for it (and says how to dial them in its own packet). Kept for the next start.
        onPacketTransports: (peerTransports, peerDescriptors) => {
          const patch = { peerTransports, peerDescriptors, peerFallback: true };
          live.stored = { ...live.stored, ...patch };
          void db.patchLink(linkId, patch).catch(() => {});
          if (this.keepsGroupNative(live.stored)) void this.ensureNativeEndpoints(linkId);
        },
        ...(entry ? {} : {
          onPaymentRequest: (request: PaymentRequest) => member() ? this.desk.onPaymentRequest(linkId, request) : undefined,
          onPaymentAsk: (ask: PaymentAsk) => member() ? this.desk.onPaymentAsk(linkId, ask) : undefined,
          onPayment: (payment: Payment) => member() ? this.desk.onPayment(linkId, payment) : undefined,
          onPaymentResult: (result: PaymentResult) => member() ? this.desk.onPaymentResult(linkId, result) : undefined,
          // The member says its name on every session over the edge, and an empty one when it removed it.
          onPeerNick: (nick: string | null) => this.groups.edgeNick(group, peer, nick ?? undefined),
        }),
        onPresence: presence => {
          if (presence.online && !seen) { seen = true; traceJoin(group, "link.presence", { role }); }
          if (presence.lastPacketAt !== live.presence.lastPacketAt) traceJoin(group, "link.packet", { role, packetAt: presence.lastPacketAt });
          live.presence = presence;
          // An open edge's name comes from `onPeerNick`. A closed one keeps the last name: an edge going down says no
          // name, and taking that would drop the member's name and set it again on every drop and reopen.
          if (!entry && presence.nick && !live.link?.isDataLinkOpen) this.groups.edgeNick(group, peer, presence.nick);
          this.emitState(); },
        onPairingState: state => { live.pairing = state; this.emitState(); },
        onDirectEvidence: evidence => {
          this.directPath.note(peer, evidence);
          if (!entry && evidence !== "open" && evidence !== "closed") void this.edgeWithoutRtc(linkId);
        },
        onDataLinkState: state => {
          traceJoin(group, `link.${state}`, { role });
          // The last moment the member was reachable on it: when it opens, and when it stops being open.
          if (state === "open" || live.dataLink === "open") live.lastSyncAt = Date.now();
          if (state === "open" && !entry) this.groups.edgeOpen(group, peer);
          // Payments with this member that did not get through go again, never twice.
          if (state === "open" && !entry && member()) void this.desk.replay(linkId).catch(() => {});
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
    if (native) void this.ensureNativeEndpoints(linkId);
  }

  /**
   * Whether a group's link (an edge, an entry session) runs native endpoints (WISP 9xx § Transports): where this app has
   * no WebRTC (the Linux Desktop), and where the member's has none, as its packet said. Between two apps that have
   * WebRTC it runs none, as before: a group of eight would otherwise hold seven listeners per transport for nothing.
   */
  private keepsGroupNative(stored: StoredLink): boolean {
    if (this.options.webrtcGroupLinks) return false;
    return typeof RTCPeerConnection === "undefined" || this.edgeRtcOff.has(stored.id) || (!!stored.peerTransports && !stored.peerTransports.includes("webrtc/1"));
  }

  /**
   * An edge's WebRTC attempt exchanged both descriptions and connected nothing, or found no candidate at all
   * (`DirectEvidence`): a network that lets no direct connection through (a VPN, a firewall, on either side). WebRTC is
   * all an edge between two apps that have it runs, and there is no TURN server unless someone set one, so the edge
   * never went live, and the member stayed unreachable for as long as that network lasted. The edge starts again as on an
   * app with no WebRTC (WISP 9xx § Transports): it runs its native endpoints and says so in its packet (`_tr`, with no
   * `webrtc/1`), the member's app starts its own for it as it does for a Linux Desktop, and the two meet over Iroh
   * through its relay. For this run of the app only.
   */
  private async edgeWithoutRtc(linkId: string): Promise<void> {
    const live = this.links.get(linkId), link = live?.link;
    if (!live || !link || !live.stored.group || live.stored.groupEntry || this.shuttingDown || this.options.webrtcGroupLinks) return;
    if (this.edgeRtcOff.has(linkId) || this.keepsGroupNative(live.stored) || !Object.keys(this.nativeFactories).length) return;
    this.edgeRtcOff.add(linkId);
    traceLink(live.myPubKeyZ32, "edge-rtc-off", {});
    live.link = null;
    // No goodbye: the edge is back in a moment, and the member must not take this for a leave.
    await link.stop(false).catch(() => {});
    if (this.links.get(linkId) !== live || live.link || this.shuttingDown || !this.networkOn) return;
    this.startEdge(linkId);
  }

  private startLink(linkId: string, messages: StoredMessage[]): void {
    const live = this.links.get(linkId);
    if (!live || live.link) return;
    const { stored } = live;
    if (stored.group) return this.startEdge(linkId);
    if (stored.profile) live.pairing = { status: "connecting" };
    const lastSeenTimestamp = messages.reduce(
      (max, m) => (m.sender === "peer" && m.via === "pkarr" ? Math.max(max, m.sentAt ?? m.timestamp) : max),
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
      // Call media is a WebRTC connection of its own, whatever carries the chat: the page's, or the host's own
      // (Ghostly Desktop on Linux, where WebKitGTK has none, brings GStreamer's).
      callsSupport: this.options.callsSupport ?? typeof RTCPeerConnection !== "undefined",
      callsMissing: this.options.callsUnavailable,
      largeFilesSupport: true,
      // 1:1 chats only: group edges (startEdge) never offer it.
      typingSupport: true,
      reactionsSupport: this.options.reactions !== false,
      // 1:1 chats only, as typing. `ghostly-test-no-edit` makes this app an older one for the e2e.
      editSupport: !GhostlyNode.testNoEdit(),
      // 1:1 chats only: a group's pin goes in its own frames.
      pinSupport: true,
      // 1:1 chats only: a group's card rides in its own boxes, and its members' apps take a card's edits or drop them.
      statusCardSupport: true,
      buttonsSupport: true,
      // 1:1 chats only, as typing: a wake-up names a chat, and a group edge is none.
      wakeSupport: true,
      servicesSupport: this.options.servicesSupport ?? (this.options.platform ?? "web") !== "web",
      dht: stored.profile ? { state: stored.dhtDeliveryState, save: async state => {
        await db.patchLink(linkId, { dhtDeliveryState: state });
        live.stored = { ...live.stored, dhtDeliveryState: state };
      },
        // Started again: the first control envelope goes after the links' first packets (a text or a receipt at once).
        firstControlAfterMs: STARTUP_QUIET_MS,
        // The capability record's revision rides every envelope; a newer one from the contact is read (WISP 03).
        capsRev: () => live.caps?.rev, peerCapsRev: rev => live.caps?.peerRev(rev),
        // A contact whose record lacks dht-text/1 gets nothing on the DHT: what would go there waits for live.
        peerAcceptsText: () => { const peer = live.caps?.peer; return !peer || peer.capabilities.includes(DHT_TEXT_CAPABILITY); },
        reactions: () => live.stored.reactionsOut ?? [],
      } : undefined,
      native: { peerDescriptors: stored.peerDescriptors, peerTransports: stored.peerTransports,
        peerFallback: stored.peerFallback, preferred: stored.preferredTransport, fallback: stored.transportFallback,
        automatic: stored.preferredTransport === undefined },
      // Live when this app last ran: the contact may still hold that session, and is reached again at once (WISP 100).
      resume: stored.pairedPeerKey && stored.deliveryMode !== "dht" ? this.transportLogOf(live)?.liveAtLastRun : undefined,
      // An offer from before that live stretch began is not answered after a restart (a relay that missed its clearing).
      resumeFloor: stored.pairedPeerKey && stored.deliveryMode !== "dht" ? this.transportLogOf(live)?.liveSinceAtLastRun : undefined,
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
      createPeerConnection: () => this.chatPeer(
        new RTCPeerConnection({ iceServers: [...(RTC_CONFIG.iceServers ?? []), ...this.settings.iceServers.filter((server) => !iceServerProblem(server))] })),
      localFetch: this.localFetch,
      getServices: () => stored.profile ? [{ id: "chat", type: "chat" }] : this.advertisedServices(stored.peerPubKeyZ32),
      // A paired contact learns only the apps granted to it, on the open session; nothing is published.
      getPairedServices: () => this.advertisedServices(stored.peerPubKeyZ32).filter((service) => service.type === "http"),
      getHostedHttpService: (id) => this.hostedService(id, stored.peerPubKeyZ32),
      // Private groups are announced on paired chats; their admission frames arrive here.
      groupsSupport: !!stored.profile,
      events: {
        onPairingProgress: progress => {
          if (knockCue(live.pairingProgress, progress)) this.cueFeedback({ cue: "knock", key: `${linkId}:${progress.startedAt}` }, linkId);
          live.pairingProgress = progress;
          this.emitState();
        },
        onGroupFrame: stored.profile ? frame => this.groups.handleContactFrame(linkId, frame) : undefined,
        onGroupsSupport: () => this.emitState(),
        onDhtDelivery: () => {
          if (stored.profile && !stored.group) void this.outboxes.get(linkId)?.flush().catch(() => {}).then(() => this.editQueues.get(linkId)?.flush()).catch(() => {});
          this.observeTransport(linkId); this.emitState();
        },
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
          if (stored.profile && !stored.group) {
            this.editsFor(linkId).reopened();
            void this.outboxFor(linkId).flush({ reopened: true }).catch(() => {}).then(() => this.editsFor(linkId).flush()).catch(() => {});
          }
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
          // What the contact allows is remembered for requests held while it is away, or waiting for live: its choice,
          // not whether it had a wallet then (it may make one meanwhile), as its capability record says too.
          if (state.status === "ready" && live.link) void this.hold.rememberPeerMethods(linkId, PAYMENT_METHODS.filter(m => live.link!.peerChoosesPayment(m))).catch(() => {});
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
        onMessageReceipt: async id => {
          await this.outboxFor(linkId).received(id);
          // An edit that went on the DHT floor under an id of its own; and a message that waited went: its edit may follow.
          if (stored.profile && !stored.group) await this.editsFor(linkId).receivedOnDht(id).catch(() => {});
          if (stored.profile && !stored.group) void this.editsFor(linkId).flush().catch(() => {});
        },
        onMessageEdit: stored.profile && !stored.group ? edit => this.receiveEdit(linkId, edit) : undefined,
        onEditReceipt: stored.profile && !stored.group ? (id, e) => this.editsFor(linkId).received(id, e) : undefined,
        // Edits agreed on a new session: questions whose buttons went on the floor or into a hold get them now, then what waits goes.
        onEditSupport: supported => {
          if (supported && stored.profile && !stored.group) void this.restoreButtons(linkId).catch(() => {}).then(() => this.editsFor(linkId).flush()).catch(() => {});
        },
        onWakeSupport: supported => { if (supported && stored.profile && !stored.group) void this.shareWake(linkId); },
        onPeerWake: target => {
          if (!stored.profile || stored.group) return;
          live.stored = { ...live.stored, peerWake: target ?? undefined };
          void db.patchLink(linkId, { peerWake: target ?? undefined });
          this.emitState();
        },
        onPeerAck: (ack) => {
          if (stored.profile) return;
          if (ack === live.peerAck) return;
          live.peerAck = ack;
          this.emitState();
        },
        onDirectEvidence: evidence => this.directPath.note(stored.peerPubKeyZ32, evidence),
        // A pinned contact only, by the key that is the person: a group's edges and a contact's other chats are the same device again.
        onPeerClock: (packetAt, readBefore, readAt) => { const peer = live.stored.pairedPeerKey; if (peer && !live.stored.group) this.clock.peer(peer, packetAt, readBefore, readAt); },
        onDataLinkState: (state) => {
          const was = live.dataLink;
          live.dataLink = state;
          if (state === "open") {
            // Live again: the next time it is away, the first message may wake it at once.
            this.wakeLimiter.reset(linkId);
            void this.desk.replay(linkId).catch(() => {}).then(() => this.sendWaiting(linkId)).catch(() => {});
            this.identities.ready(linkId);
          }
          if (state !== "open") { live.proofs?.stop(); this.identities.closed(linkId); }
          if (stored.profile && live.stored.deliveryMode !== "dht" && state !== "open") void this.outboxFor(linkId).disconnected().catch(() => {});
          // Dropped to the DHT: what the contact's app accepts there is read again (WISP 03).
          if (state !== "open" && was === "open") live.caps?.refresh();
          // Back live: what the contact has not confirmed goes again at once, under the same ids.
          // Edits after the messages they change: the contact knows the message first.
          // The edit queue starts over now, before edits are agreed on this session and anything goes (`reopened`).
          if (stored.profile && !stored.group && state === "open") {
            this.editsFor(linkId).reopened();
            void this.outboxFor(linkId).flush({ reopened: true }).catch(() => {}).then(() => this.editsFor(linkId).flush()).catch(() => {});
          }
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
          // A text over the DHT: the chat is in use, and takes a listener to go live as the chat on screen would.
          if (message.via !== "datalink") this.chatInUse(live);
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
            ...(stored.profile && message.reply && { replyTo: receivedPairedReply(message.reply) }),
            ...(stored.profile && message.forwarded && { forwarded: message.forwarded }),
            ...(stored.profile && message.card && { card: message.card }),
          });
        },
        onCallSignal: (signal) => this.events.onCallSignal(linkId, signal),
        // Presence, not a message: only the state shows it, nothing is stored or counted.
        onPeerTyping: () => this.emitState(),
        // Taken (shown, older than what is shown, or waiting for its message) is confirmed; no room left is not.
        onReaction: async reaction => (await this.reactions.receive(linkId, "peer", reaction)) !== "dropped",
        onReactionReceipt: n => this.reactionReceipt(linkId, n),
        onReactionsTaken: n => this.reactionReceipt(linkId, n, true),
        // A new session: everything not confirmed is said again on it.
        onReactionsSupport: supported => { this.reactionsSent.delete(linkId); if (supported) this.flushReactions(linkId); },
        // A pin is always taken (shown, or older than the one shown), so always confirmed.
        onPin: async pin => { await this.keepLinkPin(linkId, await this.pinCame(linkId, "peer", pin)); return true; },
        onPinReceipt: n => this.pinReceipt(linkId, n),
        onPinSupport: supported => { if (supported) this.flushPin(linkId); },
        // Each way of paying is checked where it is used: what this chat does not allow is dropped or refused.
        onPaymentRequest: (request) => this.desk.onPaymentRequest(linkId, request),
        onPaymentAsk: (ask) => this.desk.onPaymentAsk(linkId, ask),
        onPayment: (payment) => this.desk.onPayment(linkId, payment),
        onPaymentResult: async (result) => {
          await this.desk.onPaymentResult(linkId, result);
          // Its receipt, whatever the answer (the bubble says taken or refused): the contact's app has the payment.
          void this.notePaymentReceipt(linkId, result.id).catch(() => {});
        },
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
    const resumed = stored.pairedPeerKey && stored.deliveryMode !== "dht" ? this.transportLogOf(live)?.liveAtLastRun : undefined;
    if (resumed) {
      traceLink(live.myPubKeyZ32, "resume", { transport: resumed });
      this.watchResume(linkId, link);
    }
    // Unused invites need discovery, not two native listeners (`keepsNativeEndpoints`). Saved contacts
    // retain background listeners within the real native capacity.
    const nativeUp = stored.deliveryMode !== "dht" && this.keepsNativeEndpoints(linkId, stored) ? this.ensureNativeEndpoints(linkId) : undefined;
    if (credentials && !stored.group) {
      const caps = live.caps = new CapsExchange({
        params: stored, credentials, transport: this.transport, state: stored.capsState,
        local: () => this.capsContent(linkId),
        save: async state => { await db.patchLink(linkId, { capsState: state }); live.stored = { ...live.stored, capsState: state }; },
        changed: record => this.peerCapsChanged(linkId, record),
        published: () => live.link?.announceCapsRevision(),
        // A record that was not taken left no word anywhere: why a chat had nothing to dial was a guess.
        refused: error => traceLink(live.myPubKeyZ32, "caps-refused", { reason: error.reason }),
      });
      // A saved contact's record goes once this chat's native endpoints are up, with what dials them (or after
      // `STARTUP_QUIET_MS`): started at once, it went out without them and again as each came up, and so did an envelope
      // naming each revision (bug hunt r7a). Mostly it is then the record already out, and nothing goes.
      if (stored.pairedPeerKey && nativeUp) {
        const late = setTimeout(() => caps.start(), STARTUP_QUIET_MS);
        const go = () => { clearTimeout(late); caps.start(); };
        void nativeUp.then(go, go);
      } else caps.start();
      // The contact's record as last read: what its app runs, before any session says more (WISP 03).
      const peer = caps.peer;
      if (peer) {
        link.learnPeerTransports(peer.transports.filter((t): t is PairedTransport => (TRANSPORTS as readonly string[]).includes(t)), dialDescriptors(peer.descriptors));
        link.learnPeerChoice(peer.choice);
      }
    }
    void nativeUp?.then(() => {
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
        // Edits on the DHT floor too (WISP 403 § Edits): an app from before would show one as a new message.
        ...(GhostlyNode.testNoEdit() ? [] : [EDIT_CAPABILITY]),
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
   * Whether a chat keeps native listeners: a contact's, the chat on screen, and one this side joined from a `ghostly1`
   * invite that is still pairing. The joiner dials, and without an endpoint of its own an app with no WebRTC (the Linux
   * Desktop) offered nothing the inviter could take: someone who went back to the chat list right after joining waited
   * out the connect (90 s) before the chat went live. An invite of this side's that nobody used yet keeps none.
   */
  private keepsNativeEndpoints(linkId: string, stored: StoredLink): boolean {
    return !!stored.pairedPeerKey || !!stored.peerParticipationKeyZ32 || this.activeLinkId === linkId;
  }

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
        if (live.link && live.stored.profile && (!live.stored.group || this.keepsGroupNative(live.stored)) && live.stored.deliveryMode !== "dht" && !live.link.availableTransports.includes("hyperdht/1")
          && this.keepsNativeEndpoints(linkId, live.stored)) void this.ensureNativeEndpoints(linkId);
      }
    }, RELAY_RETRY_MS);
  }

  /** A new relay (or none): chats give up their endpoints on the old one, as soon as none of them carries a session. */
  private async relayChanged(): Promise<void> {
    if (!this.relaysHyperdht) return;
    for (const [linkId, live] of this.links) {
      const link = live.link;
      if (!link?.availableTransports.includes("hyperdht/1")) {
        if (this.hyperdhtRelay && link && this.keepsNativeEndpoints(linkId, live.stored)) void this.ensureNativeEndpoints(linkId);
        continue;
      }
      if (!link.canReleaseEndpoint("hyperdht/1")) continue;
      await link.releaseEndpoint("hyperdht/1");
      if (live.transportErrors) delete live.transportErrors["hyperdht/1"];
      if (this.hyperdhtRelay) void this.ensureNativeEndpoints(linkId);
    }
    this.emitState();
  }

  /**
   * A text going or coming in a 1:1 chat with no live session: the chat is in use, and takes the native listeners it
   * lacks as the chat on screen would (a bot answering its ninth contact has no chat on screen).
   */
  private chatInUse(live: LiveLink): void {
    const link = live.link;
    if (live.stored.group || !link || link.isDataLinkOpen || !this.keepsNativeEndpoints(live.stored.id, live.stored)) return;
    if (Object.keys(this.nativeFactories).every(t => link.availableTransports.includes(t as NativeTransport))) return;
    void this.ensureNativeEndpoints(live.stored.id, true);
  }

  /**
   * Whether the chat goes live only over a native transport: this app has no WebRTC, or its contact has none (its record
   * lists no `webrtc/1`). Not known yet (no record read) counts as only natively, as a chat before its first record must.
   */
  private reachedOnlyNatively(live: LiveLink): boolean {
    const theirs = live.stored.capsState?.peer?.transports ?? live.stored.peerTransports;
    return typeof RTCPeerConnection === "undefined" || !theirs || !theirs.includes("webrtc/1");
  }

  /** `inUse`: a text is going or coming in the chat now, which counts as the chat on screen does for taking a listener. */
  private ensureNativeEndpoints(linkId: string, inUse = false): Promise<void> {
    const expected = this.links.get(linkId)?.link;
    // Each transport's listener starts in that transport's own queue, the transports side by side. HyperDHT with its
    // DHT out of reach (UDP blocked, a VPN) takes 6 s to listen, and a browser's Iroh up to 10 s for its relay: in one
    // queue, every chat after the first waited that long per chat before its Iroh listener even started, and a chat
    // whose WebRTC cannot connect has nothing else to go live on.
    const starts = Object.entries(this.nativeFactories).map(([transport, factory]) => {
      const key = transport as NativeTransport;
      const operation = (this.nativeQueues.get(key) ?? Promise.resolve()).then(() => factory ? this.startNativeEndpoint(linkId, expected, key, factory, inUse) : false);
      this.nativeQueues.set(key, operation.then(() => {}, () => {}));
      return operation;
    });
    return Promise.all(starts).then(full => {
      const live = this.links.get(linkId), link = live?.link;
      if (this.shuttingDown || !live || !link || link !== expected) return;
      // A group's link with no native endpoint because none was free: its member's row says so, and it is tried
      // again as slots free up (`retryGroupNative`).
      if (live.stored.group && this.keepsGroupNative(live.stored)) {
        const waiting = full.some(Boolean) && !link.availableTransports.some(t => t !== "webrtc/1");
        if (waiting) this.groupNativeWaiting.add(linkId); else this.groupNativeWaiting.delete(linkId);
      }
      this.emitState();
    });
  }

  /** One transport's listener for one chat, in that transport's queue. True when a group's link found no slot free. */
  private async startNativeEndpoint(linkId: string, expected: GhostLink | null | undefined, key: NativeTransport,
    factory: (seedB64: string) => Promise<NativeEndpoint>, inUse: boolean): Promise<boolean> {
    const live = this.links.get(linkId), link = live?.link;
    if (this.shuttingDown || !live?.stored.profile || live.stored.deliveryMode === "dht" || !link || link !== expected) return false;
    // A group's link runs them only where one side has no WebRTC (`keepsGroupNative`).
    const group = !!live.stored.group;
    if (group && !this.keepsGroupNative(live.stored)) return false;
    if (link.availableTransports.includes(key)) return false;
    live.transportErrors ??= {};
    try {
      // The native SDKs each allow eight listeners. Reclaim an idle listener
      // only for the selected chat, never an established native connection.
      const owners = [...this.links.values()].filter(other => other.link?.availableTransports.includes(key));
      // A group's links take at most half of them, and never one a chat holds: 1:1 chats keep what they had
      // before group links went native (WISP 9xx § Transports). One that finds none waits for a slot.
      if (group && (owners.length >= NATIVE_SLOTS || owners.filter(other => other.stored.group).length >= GROUP_NATIVE_SLOTS)) return true;
      if (owners.length >= NATIVE_SLOTS) {
        const now = Date.now();
        const taking = !group && (this.activeLinkId === linkId || inUse);
        // A chat takes a slot from a group's link first, one that carries no session: the link waits for another.
        const groupVictim = owners.filter(other => other.stored.group && other.link?.canReleaseEndpoint(key))
          .sort((a, b) => (a.link?.isDataLinkOpen ? 1 : 0) - (b.link?.isDataLinkOpen ? 1 : 0))[0];
        // Then from a chat that carries none, unless that chat took it from an idle session moments ago (no ping-pong).
        const victim = groupVictim ?? (taking ? owners
          .filter(other => other !== live && other.stored.id !== this.activeLinkId && other.link?.canReleaseEndpoint(key)
            && now - (other.nativeTakenAt?.[key] ?? 0) >= NATIVE_HOLD_MS)
          .sort((a, b) => a.lastMessageAt - b.lastMessageAt)[0] : undefined);
        // Every one carrying a session: from the 1:1 chat whose session has gone unused longest, once that is
        // NATIVE_HOLD_MS, and never one with a call on or a file moving. Group links keep theirs. Only for a chat
        // that can go live no other way: one whose contact has WebRTC, on an app with WebRTC, ends nobody's session.
        const idle = victim || !taking || !this.reachedOnlyNatively(live) ? undefined : owners
          .filter(other => other !== live && !other.stored.group && other.stored.id !== this.activeLinkId && !this.fileDesk.moving(other.stored.id)
            && other.link?.canYieldEndpoint(key, NATIVE_HOLD_MS))
          .sort((a, b) => a.link!.lastActivityAt - b.link!.lastActivityAt)[0];
        const idleFor = idle ? now - idle.link!.lastActivityAt : 0;
        if (idle && await idle.link!.yieldEndpoint(key, NATIVE_HOLD_MS)) {
          traceLink(live.myPubKeyZ32, "native-take", { transport: key, idle: idleFor, active: this.activeLinkId === linkId });
          live.nativeTakenAt = { ...live.nativeTakenAt, [key]: Date.now() };
          idle.transportErrors ??= {};
          idle.transportErrors[key] = "Listener given to a chat in use: this one was quiet. Open this chat to take one back; your messages and transport identity are saved.";
        } else if (!victim) {
          traceLink(live.myPubKeyZ32, "native-no-slot", { transport: key, active: this.activeLinkId === linkId });
          // Each busy for now (dialling, switching, carrying a session): the chat on screen asks again in a moment.
          if (this.activeLinkId === linkId && !group) this.retryActiveSlot(linkId);
          throw new Error("All eight native connection slots are in use. This chat takes one once a chat live over one has been quiet for 2 minutes. Disconnect a native connection in another chat to free one now.");
        } else {
          await victim.link!.releaseEndpoint(key);
          victim.transportErrors ??= {};
          victim.transportErrors[key] = "Listener released for another chat. Open this chat to restore it; your messages and transport identity are saved.";
          if (victim.stored.group) this.groupNativeWaiting.add(victim.stored.id);
        }
      }
      if (this.shuttingDown || live.link !== link) return false;
      const seed = live.stored.transportSeeds?.[key] ?? createIdentity().seedB64;
      // Kept before anything is awaited: another transport's listener for this chat starts beside this one, and
      // each must write the seeds the other already drew.
      const transportSeeds = { ...live.stored.transportSeeds, [key]: seed };
      live.stored = { ...live.stored, transportSeeds };
      await db.patchLink(linkId, { transportSeeds });
      const endpoint = await factory(seed);
      if (this.shuttingDown || live.stored.deliveryMode === "dht" || live.link !== link || !this.links.has(linkId)) { await endpoint.close(); return false; }
      link.registerEndpoint(endpoint);
      delete live.transportErrors[key];
      // The record says how to dial it, so a contact whose WebRTC never connects can try it (WISP 03).
      this.capsChanged(linkId);
      // Told now: the chat need not wait for a slower transport's listener to say it runs this one.
      this.emitState();
    } catch (error) {
      live.transportErrors[key] = error instanceof Error ? error.message : "Native adapter could not start. Reopen this chat to retry.";
    }
    return false;
  }

  /**
   * The order saved chats start in, which is the order they take native listeners in (`NATIVE_SLOTS` per transport):
   * the 1:1 chats written in, or live, most recently first; group links keep their places. In the order they were
   * stored, an app with more paired chats than slots left a chat that was live a moment before with no listener, and a
   * contact with no WebRTC (the Linux Desktop) never reached it again (Omarchy, 2026-09-30: "On DHT · retrying live" for
   * minutes after both apps restarted). Not "live when this app last ran" first: a chat that heard its contact leave as
   * both quit is not.
   *
   * On an app with WebRTC, the chats whose contact has none (its capability record lists no `webrtc/1`: a Linux Desktop,
   * a CLI with WebRTC off) come first, each class in that order: they reach this app over a native transport or not
   * live at all, while a contact with WebRTC still has it when no listener is left here.
   */
  private nativeStartOrder(linkIds: string[]): string[] {
    const isChat = (id: string) => { const stored = this.links.get(id)?.stored; return !!stored && !stored.group; };
    const rtc = typeof RTCPeerConnection !== "undefined";
    const rank = new Map(linkIds.filter(isChat).map(id => {
      const live = this.links.get(id)!;
      const theirs = live.stored.capsState?.peer?.transports ?? live.stored.peerTransports;
      return [id, { recent: Math.max(live.lastMessageAt, this.transportLogOf(live)?.lastLiveAt ?? 0),
        nativeOnly: rtc && !!theirs && !theirs.includes("webrtc/1") }] as const;
    }));
    const chats = [...rank.keys()].sort((a, b) => {
      const x = rank.get(a)!, y = rank.get(b)!;
      return Number(y.nativeOnly) - Number(x.nativeOnly) || y.recent - x.recent;
    });
    chats.forEach((id, place) => traceLink(this.links.get(id)!.myPubKeyZ32, "native-order", { place, ...rank.get(id) }));
    let next = 0;
    return linkIds.map(id => rank.has(id) ? chats[next++] : id);
  }

  /**
   * A chat started as "live when this app last ran" (it resumes, and knocks): if this run is not live in it within
   * `RESUME_SPENT_MS`, its history says that stretch is over, so the next start does not resume it again.
   */
  private readonly resumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private watchResume(linkId: string, link: GhostLink): void {
    const before = this.resumeTimers.get(linkId);
    if (before) clearTimeout(before);
    this.resumeTimers.set(linkId, setTimeout(() => {
      this.resumeTimers.delete(linkId);
      const live = this.links.get(linkId), log = live && this.transportLogOf(live);
      if (this.shuttingDown || !live || !log || live.link !== link) return;
      if (!log.notBackAfterRestart(Date.now())) return;
      traceLink(live.myPubKeyZ32, "resume-spent", {});
      this.saveTransportLog(live, log);
    }, RESUME_SPENT_MS));
  }

  /** The chat on screen found every native slot busy: it tries again in a moment, while it stays on screen. */
  private activeSlotRetry: ReturnType<typeof setTimeout> | null = null;
  private retryActiveSlot(linkId: string): void {
    if (this.activeSlotRetry) clearTimeout(this.activeSlotRetry);
    if (this.shuttingDown) return;
    this.activeSlotRetry = setTimeout(() => {
      this.activeSlotRetry = null;
      if (this.activeLinkId === linkId && !this.shuttingDown) void this.ensureNativeEndpoints(linkId);
    }, ACTIVE_SLOT_RETRY_MS);
  }

  /** Group links waiting for a free native slot (`ensureNativeEndpoints`), by link id. */
  private readonly groupNativeWaiting = new Set<string>();
  private groupNativeRetryAt = 0;
  /** Now and then, the group links that found no free native slot try again: a chat or another group may have let one go. */
  private retryGroupNative(): void {
    if (!this.groupNativeWaiting.size || Date.now() < this.groupNativeRetryAt) return;
    this.groupNativeRetryAt = Date.now() + GROUP_NATIVE_RETRY_MS;
    for (const linkId of [...this.groupNativeWaiting]) {
      if (!this.links.get(linkId)?.link) { this.groupNativeWaiting.delete(linkId); continue; }
      void this.ensureNativeEndpoints(linkId);
    }
  }

  /**
   * A group message first stored from a copy a member handed on without its author's whole signature: what the whole
   * copy adds (mentions, a reply, a hop count) joins the stored row; the text and time stay as they were.
   */
  private async completeGroupMessage(message: StoredMessage): Promise<void> {
    if (!(await db.hasMessage(message.linkId, message.id))) return this.storeMessage(message);
    const whole = await this.resolveReply(message);
    const added: Partial<StoredMessage> = { ...(whole.mentions && { mentions: whole.mentions }), ...(whole.mentioned && { mentioned: true }),
      ...(whole.replyTo && { replyTo: whole.replyTo }), ...(whole.forwarded && { forwarded: whole.forwarded }), ...(whole.card && { card: whole.card }), ...(whole.press && { press: whole.press }) };
    if (!Object.keys(added).length) return;
    // A card belongs to its version: an edit taken meanwhile keeps its own.
    const patched = await db.patchMessage(message.linkId, message.id, stored => {
      if (stored.member !== message.member || stored.sender !== message.sender) return null;
      const { card: _card, ...rest } = added;
      return stored.edit ? rest : added;
    });
    if (!patched) return;
    await this.messagesChanged(message.linkId, [message.id]);
    this.emitState();
  }

  /**
   * The pages hear what changed in a chat or group: these rows as stored now (one not there any more is deleted), never
   * the whole history. A host that takes whole histories only (no `onMessageChanges`) gets the whole history, as before.
   */
  private async messagesChanged(linkId: string, ids: readonly string[]): Promise<void> {
    // The chat list's reaction line quotes its message: an edit of that message changes the quote too.
    const reacted = this.reactionNotes.get(linkId);
    if (reacted?.message && ids.includes(reacted.message)) {
      const row = await db.getMessage(linkId, reacted.message);
      const fresh = row && noteAfterChange(reacted, row);
      if (fresh) { this.reactionNotes.set(linkId, fresh); this.emitState(); }
    }
    const onChanges = this.events.onMessageChanges;
    if (!onChanges) return this.events.onMessages(linkId, await db.getMessages(linkId));
    const unique = [...new Set(ids)];
    if (!unique.length) return;
    const rows = await Promise.all(unique.map(id => db.getMessage(linkId, id)));
    onChanges.call(this.events, linkId, { messages: rows.filter((row): row is StoredMessage => !!row), deleted: unique.filter((_, i) => !rows[i]) });
  }

  /**
   * At the start, before anything reads a history: received rows an earlier version stored under a time that has not
   * come yet take a place before now (`settleAhead`). One row is read when nothing is ahead, which is every start but
   * the first after the update.
   */
  private async settleHistory(linkId: string): Promise<void> {
    const now = Date.now();
    const newest = (await db.getMessagePage(linkId, { limit: 1 })).messages[0];
    if (!newest || newest.timestamp <= now) return;
    for (const row of settleAhead(await db.getMessages(linkId), now)) await db.putMessage(row);
  }

  /**
   * A new row with its place in its history. A received row takes it here and now, past the last place given in its
   * chat: the time its sender says is kept beside it (`sentAt`) and shown, and orders nothing (WISP 400, requirement
   * 10). A sender's clock ahead or behind then moves no message past another, and what I send next goes below what I
   * just received. A row of mine keeps its own time; one placed already (it has `sentAt`) is left as it is. A line
   * of a group's history (a membership change, a rename) is not a message: it stays at its commit's time, as before.
   */
  private placed(message: StoredMessage): StoredMessage {
    const now = Date.now(), last = this.placedAt.get(message.linkId) ?? 0;
    if (message.event) return message.sender === "peer" ? { ...message, timestamp: receivedTimestamp(message.timestamp) } : message;
    if (message.sender === "peer" && message.sentAt === undefined) {
      const sentAt = claimedTime(message.timestamp);
      message = { ...message, timestamp: arrivalKey(now, last), ...(sentAt !== undefined && { sentAt }) };
      this.placedAt.set(message.linkId, message.timestamp);
    }
    // Mine count too, up to now: a message that comes in the millisecond I sent one goes below it.
    else this.placedAt.set(message.linkId, Math.max(last, Math.min(message.timestamp, now)));
    return message;
  }

  private async storeMessage(message: StoredMessage): Promise<void> { await this.storeNewMessage(message); }

  /** Stores a message; false when it was there already (or deleted here): nothing new came. */
  private async storeNewMessage(message: StoredMessage): Promise<boolean> {
    // A payment with a member lands in the group's history, from that member, under an id of the edge's own.
    const edge = this.links.get(message.linkId)?.stored;
    if (edge?.group && edge.groupPeer && !edge.groupEntry)
      message = { ...message, linkId: `group:${edge.group}`, id: `${edge.id}:${message.id}`, ...(message.sender === "peer" ? { member: edge.groupPeer } : {}) };
    // …and one with a member of a community, which has no edge: its link through the group names them.
    const pay = parsePayLink(message.linkId);
    if (pay?.member) message = { ...message, linkId: `group:${pay.groupId}`, id: `${message.linkId}:${message.id}`, ...(message.sender === "peer" ? { member: pay.member } : {}) };
    // Its place, in the order rows come (before anything is awaited).
    message = this.placed(message);
    const live = this.links.get(message.linkId);
    // The peer republishes what it sent for a few minutes: what was deleted here stays deleted.
    if (live?.stored.deletedIds?.includes(message.id)) return false;
    // A reply's original, looked for in this chat only: one named from elsewhere is simply not found here.
    message = await this.resolveReply(message);
    // Its details begin here: the path a received message came over, or the one a payment goes over right now.
    if (message.sender === "peer" && live && !message.details?.received) message = { ...message, details: { ...message.details, received: { at: Date.now(), ...pathSnapshot(live, message.via) } } };
    else if (message.sender === "me" && message.paymentId && !message.delivery && live && !message.details?.sends) {
      const at = Date.now();
      message = { ...message, details: { ...withSend(message.details, { at, ...pathSnapshot(live, message.via), result: "sent" }), sentAt: at } };
    }
    if (!(await db.addMessage(message))) return false;
    this.clockSample(message);
    const newest = this.newestAt.get(message.linkId);
    if (!message.event) this.newestAt.set(message.linkId, Math.max(newest ?? 0, writtenAt(message, this.clockLeads.get(message.linkId))));
    if (message.sender === "peer") this.messageFeedback("message", message, newest);
    if (live) live.lastMessageAt = Math.max(live.lastMessageAt, message.timestamp);
    // An edit that came before its message is shown now, and confirmed.
    const early = message.sender === "peer" && message.id.startsWith("peer_") ? this.editBuffer.take(message.linkId, message.id.slice(5)) : undefined;
    if (early) {
      await this.applyPeerEdit(message.linkId, message, early);
      live?.link?.confirmEdit(early.id, early.e);
    }
    await this.messagesChanged(message.linkId, [message.id]);
    this.emitState();
    // Reactions that came before it are shown now, and a member's edit.
    await this.reactions.stored(message);
    await this.groupEdits.stored(message);
    return true;
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
      ...(stored.profile && !stored.group && live.link?.peerTyping ? typingView(live.link.peerTypingActivity) : {}),
      ...(stored.profile && !stored.group && { wakeToken: this.settings.wake ? stored.wakeToken : undefined, peerWakes: !!stored.peerWake, ...(stored.wakeMuted && { wakeMuted: true }) }),
      ...(this.reactionNotes.has(stored.id) && { lastReaction: this.reactionNotes.get(stored.id) }),
      ...(stored.pin && { pin: pinView(stored.pin) }),
      participationKey: stored.participationSeed ? identityFromSeedB64(stored.participationSeed).pubKeyZ32 : undefined,
      peerParticipationKey: stored.pairedPeerKey,
      publicProfiles: EXTERNAL_IDENTITIES_ENABLED ? stored.publicProfiles : undefined,
      profileChoice: EXTERNAL_IDENTITIES_ENABLED ? stored.profileChoice : undefined,
      peerProofSupport: EXTERNAL_IDENTITIES_ENABLED && (live.link?.peerProofSupport ?? false),
      peerProofAdapters: EXTERNAL_IDENTITIES_ENABLED ? live.link?.peerProofAdapters ?? [] : [],
      peerProofs: EXTERNAL_IDENTITIES_ENABLED && stored.peerProofs ? { local: stored.peerProofs.local, remote: stored.peerProofs.remote } : undefined,
      proofError: EXTERNAL_IDENTITIES_ENABLED ? live.proofError : undefined,
      availableTransports: live.link?.availableTransports,
      runnableTransports: live.link ? this.runnableTransports(live) : undefined,
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
      identityTimeline: stored.id === this.activeLinkId && stored.profile && !stored.group ? stored.identities?.timeline ?? [] : undefined,
      identitySharedAt: stored.profile && !stored.group ? lastSharedWithMe(stored.identities?.timeline) || undefined : undefined,
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
      peerLastSeenAt: presenceSeenAt(presence),
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

  /** The state now, not after `emitState`'s wait: for what the app must have before what follows it. */
  private flushState(): void {
    if (this.stateTimer) { clearTimeout(this.stateTimer); this.stateTimer = null; }
    this.events.onState(this.getState());
  }
}
