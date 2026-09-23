import type { WalletMode } from "./mints";
import type { PaymentMethodName } from "@ghostly/core";
import type { UsdtWalletView } from "../engine/paymentAdapters/usdtWallet";
import type { ArkWalletView } from "../engine/paymentAdapters/arkWallet";
import type { BarkWalletView } from "../engine/paymentAdapters/barkWallet";
import type { PaymentReview, PaymentTarget } from "@ghostly/core";
import type { DeliveryMode, DhtDeliveryState, DhtDeliveryView } from "@ghostly/core";
import type { PublicProfile, ProfileChoice } from '../profiles/public';
import type { ProofLedger, ProofAdapter } from "@ghostly/core";
import type { DataLinkState, LinkStatus, ServiceAd, PairingState, NativeTransport, PairedTransport, TransportDescriptors } from "@ghostly/core";

/** A link as stored in IndexedDB. Same fields Desktop keeps in its ChatSession. */
export interface StoredLink {
  deliveryMode?: DeliveryMode;
  dhtDeliveryState?: DhtDeliveryState;
  publicProfiles?: PublicProfile[];
  profileChoice?: ProfileChoice;
  peerProofs?: ProofLedger;
  profile?: "paired-chat/1";
  participationSeed?: string;
  transportSeeds?: Partial<Record<NativeTransport, string>>;
  peerDescriptors?: TransportDescriptors;
  peerTransports?: PairedTransport[];
  peerFallback?: boolean;
  preferredTransport?: PairedTransport;
  transportFallback?: boolean;
  pairedPeerKey?: string;
  /** Absent only in old releases, where first pin required an explicit code comparison. */
  peerTrust?: { version: 1; verifiedKey?: string; verifiedAt?: number };
  requireSignedSignals?: boolean;
  id: string;
  seedB64: string;
  peerPubKeyZ32: string;
  encKeyB64: string;
  createdAt: number;
  label?: string;
  peerNick?: string;
  /** The contact's profile picture, as they last sent it (checked, small JPEG data URL). */
  peerAvatar?: string;
  /** Present on the side that created the link, until the peer shows up. */
  inviteCode?: string;
  /** Messages deleted on this device, by id, so a republished one is not stored again. */
  deletedIds?: string[];
  /** Ways of paying this device allows in this chat. Absent or true: allowed. */
  paymentMethods?: Partial<Record<PaymentMethodName, boolean>>;
}

/** A file attached to a message. The bytes live in the `files` store under `id`. */
export interface MessageFile {
  id: string;
  name: string;
  size: number;
  mime: string;
}

export interface FileTransferView {
  state: "transferring" | "done" | "failed";
  transferred: number;
  size: number;
  error?: string;
}

/** Ecash held by this peer. One row per proof; `reserved` while an operation is using it. */
export interface StoredProof {
  mint: string;
  id: string;
  amount: number;
  secret: string;
  C: string;
  dleq?: unknown;
  /** Handed to the mint for a Lightning payment that has not settled: not spendable, not yet gone. */
  reserved?: boolean;
}

/** A Lightning payment the mint has not settled yet. Its proofs stay in the wallet, reserved, until it does. */
export interface PendingMelt {
  /** The melt quote id. */
  quote: string;
  mint: string;
  /** The invoice, so it is not paid a second time while this one is in flight. */
  request: string;
  /** What the invoice pays. */
  amount: number;
  /** The reserved proofs handed to the mint. */
  secrets: string[];
  /** Everything that left the balance for this payment: the proofs above plus any swap fee. */
  outlay: number;
  /** NUT-08 blank outputs (`OutputData.serialize`), to unblind the fee change once the mint returns it. */
  outputs: unknown[];
  note?: string;
  /** Set when the invoice pays a contact's payment request. */
  paymentId?: string;
  createdAt: number;
}

/** A Lightning invoice the mint issued for us; paid invoices turn into ecash. */
export interface StoredQuote {
  quote: string;
  mint: string;
  amount: number;
  invoice: string;
  createdAt: number;
  expiresAt: number | null;
  /** Set when the invoice belongs to a payment request sent to a peer. */
  paymentId?: string;
  /**
   * The mint says it issued this quote's ecash, but the wallet never stored it. Kept, not polled: it is the
   * only record of sats the user paid for.
   */
  issuedUnclaimed?: boolean;
}

export type PaymentState =
  | "pending" // sent, no word from the peer yet / request waiting to be paid
  | "settled"
  | "failed"
  | "reclaimed"; // the peer never took the ecash and it is back in the wallet

/** A payment or payment request in a chat, by id. */
export interface StoredPayment {
  /** A request made because the contact asked to pay (its `pay-ask` id), or, on the payer's side, the ask it answers. */
  ask?: string;
  target?: PaymentTarget;
  txid?: string;
  id: string;
  linkId: string;
  kind: "payment" | "request";
  direction: "in" | "out";
  amount: number;
  unit: string;
  memo?: string;
  state: PaymentState;
  error?: string;
  createdAt: number;
  mint?: string;
  /** Outgoing ecash, kept until the peer confirms so it can be reclaimed. */
  token?: string;
  /** Requests: how the payer can pay. */
  invoice?: string;
  mints?: string[];
  requestId?: string;
  /** Requests we pay: a Lightning payment is in flight at the mint, so paying again would pay twice. */
  lightningPending?: boolean;
}

/** What pages see of a payment: everything but the token. */
export type PaymentView = Omit<StoredPayment, "token">;

export interface MintView {
  url: string;
  name: string;
  balance: number;
  /** Null until the mint answered once. */
  info: MintInfoView | null;
}

/** What a mint says about itself and what it charges. */
/** What a pasted piece of ecash says about itself. Mirrors `CashuInspection` in the UI's platform contract. */
export type CashuInspection =
  | { kind: "token"; amount: number; unit: string; mint: string; memo?: string; accepted: boolean }
  | { kind: "request"; amount: number | null; unit: string; mints: string[]; description?: string };

export interface MintInfoView {
  version?: string;
  motd?: string;
  /**
   * Fee for spending ecash, in sats per thousand proofs (NUT-02). A swap,
   * a redeem or a Lightning payment spends a handful of proofs and is charged
   * the sum, rounded up. 0 means spending ecash is free.
   */
  inputFeePpk: number;
  /** Lightning in and out: allowed amounts in sats, null when the mint sets no bound. */
  receive: { min: number | null; max: number | null } | null;
  send: { min: number | null; max: number | null } | null;
}

export type WalletTxKind =
  | "lightning-in"
  | "lightning-out"
  | "ecash-in" // from a contact, or a pasted token
  | "ecash-out"
  | "reclaimed";

/** One movement of the wallet. `fee` is exact: what left the balance beyond `amount`, or what a redeem cost. */
export interface WalletTx {
  id: string;
  timestamp: number;
  mint: string;
  kind: WalletTxKind;
  /** Sats that moved, always positive; the kind gives the direction. */
  amount: number;
  fee: number;
  note?: string;
}

export interface WalletView {
  /** Which wallets are in use: real money, or test networks. Absent means mainnet. */
  mode?: WalletMode;
  /** On Mainnet: test sats held at test mints (a contact may have sent some), shown once in Testnet. */
  waitingTestSats?: number;
  ark?: ArkWalletView;
  /** Second's Ark (Bark): a different Ark server from `ark`, not interchangeable with it. */
  bark?: BarkWalletView;
  usdt?: UsdtWalletView;
  intents?: PaymentReview[];
  mints: MintView[];
  balance: number;
  /** Newest first. */
  history: WalletTx[];
  feesPaid: number;
}

export interface StoredMessage {
  wireId?: string;
  delivery?: "sending" | "sent" | "delivered" | "failed";
  deliveryError?: string;
  linkId: string;
  id: string;
  text: string;
  sender: "me" | "peer";
  timestamp: number;
  via: "pkarr" | "datalink";
  nick?: string;
  file?: MessageFile;
  paymentId?: string;
}

/** A local web application the user chose to share. */
export interface StoredService {
  id: string;
  name: string;
  /** Normalized loopback URL, e.g. `http://localhost:3400` */
  target: string;
  enabled: boolean;
  createdAt: number;
  /**
   * The contacts allowed to reach this service, by participation key. Absent or
   * empty means nobody: a service is granted per contact, never to everyone at
   * once, and a service from before this existed starts closed rather than
   * keeping an exposure its owner never chose.
   */
  sharedWith?: string[];
}

export interface IceServerSetting {
  urls: string;
  username?: string;
  credential?: string;
}

export interface Settings {
  online: boolean;
  nick: string;
  /** This profile's picture, shown to paired contacts: a small square JPEG data URL. */
  avatar?: string;
  relays: string[];
  /** Extra ICE servers (typically TURN) on top of the built-in STUN set. */
  iceServers: IceServerSetting[];
  /** Cashu mints this peer holds ecash at and accepts ecash from. The first is where invoices are created. */
  mints: string[];
  /** False until the default mints were put in place once; after that the list is the user's. */
  mintsInitialized: boolean;
  /** Real money, or test networks: every wallet follows it. Absent means mainnet. */
  walletMode?: WalletMode;
}

export interface LinkView {
  discoveryError?: string;
  publicProfiles?: PublicProfile[];
  profileChoice?: ProfileChoice;
  peerProofs?: Pick<ProofLedger, "local" | "remote">;
  peerProofSupport?: boolean;
  peerProofAdapters?: ProofAdapter[];
  participationKey?: string;
  peerParticipationKey?: string;
  proofError?: string;
  profile?: "paired-chat/1";
  pairing?: PairingState;
  peerVerified?: boolean;
  /** `methods`: ways of paying both sides allow in this chat right now. */
  capabilities?: { files: boolean; payments: boolean; methods?: Record<PaymentMethodName, boolean> };
  /** Ways of paying this device allows in this chat. */
  paymentMethods?: Record<PaymentMethodName, boolean>;
  availableTransports?: PairedTransport[];
  deliveryMode?: DeliveryMode;
  dhtDelivery?: DhtDeliveryView;
  canSendText?: boolean;
  textDelivery?: "stream" | "dht" | "unavailable";
  transportErrors?: Partial<Record<PairedTransport, string>>;
  preferredTransport?: PairedTransport;
  transportFallback?: boolean;
  id: string;
  myPubKeyZ32: string;
  peerPubKeyZ32: string;
  label?: string;
  peerNick?: string;
  /** The contact's profile picture, as they last sent it (checked, small JPEG data URL). */
  peerAvatar?: string;
  inviteCode?: string;
  createdAt: number;
  status: LinkStatus;
  dataLink: DataLinkState;
  peerOnline: boolean;
  peerLastSeenAt: number;
  /** `null` when the peer does not advertise (offline, or a legacy client). */
  peerServices: ServiceAd[] | null;
  lastMessageAt: number;
  /** Newest of my messages the peer acknowledged through Pkarr. */
  peerAck: number;
  lastSyncAt: number;
  poll: { polling: boolean; nextAt: number; interval: number };
}

export interface ServiceView extends StoredService {
  /** Requests served since the engine started. */
  requests: number;
}

export interface EngineState {
  settings: Settings;
  transport: { protocol: string; relays: string[] };
  links: LinkView[];
  services: ServiceView[];
  /** Transfers since the peer started, by file id. */
  transfers: Record<string, FileTransferView>;
  wallet: WalletView;
  payments: Record<string, PaymentView>;
}
