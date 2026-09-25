import type { WalletMode } from "./mints";
import type { PairingProgress, PaymentMethodName, VoiceMeta } from "@ghostly/core";
import type { UsdtWalletView } from "../engine/paymentAdapters/usdtWallet";
import type { ArkWalletView } from "../engine/paymentAdapters/arkWallet";
import type { BarkWalletView } from "../engine/paymentAdapters/barkWallet";
import type { FedimintWalletView } from "../engine/paymentAdapters/fedimintWallet";
import type { SparkWalletView } from "../engine/paymentAdapters/sparkWallet";
import type { LightningView } from "../engine/paymentAdapters/providers/lightningService";
import type { BitcoinView } from "../engine/paymentAdapters/providers/bitcoinService";
import type { PaymentReview, PaymentTarget } from "@ghostly/core";
import type { DeliveryMode, DhtDeliveryState, DhtDeliveryView, HoldKind } from "@ghostly/core";
import type { S3Config } from "../backup/s3";
import type { PublicProfile, ProfileChoice } from '../profiles/public';
import type { NostrContactCache, NostrContactView, NostrSocialSettings, NostrSocialState } from "../nostr/types";
import type { ProofLedger, ProofAdapter } from "@ghostly/core";
import type { IdentityDisplay, IdentityLedger, IdentityStatus, SharedIdentity, VerifiedIdentity } from "@ghostly/core";
import type { DataLinkState, LinkStatus, ServiceAd, PairingState, NativeTransport, PairedTransport, TransportDescriptors } from "@ghostly/core";
import type { CommunityState, GroupCommit, GroupRole, GroupState, GroupStatus } from "@ghostly/core";

/** A link as stored in IndexedDB. Same fields Desktop keeps in its ChatSession. */
export interface StoredLink {
  deliveryMode?: DeliveryMode;
  dhtDeliveryState?: DhtDeliveryState;
  publicProfiles?: PublicProfile[];
  profileChoice?: ProfileChoice;
  peerProofs?: ProofLedger;
  /** Identity proofs shared in this chat, both ways (WISP 300). */
  identities?: IdentityLedger;
  /** The contact's Nostr profile, follows and notes, cached under their proven key, loaded only on request. */
  nostrSocial?: Record<string, NostrContactCache>;
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
  /**
   * The name the contact asked to be shown by, as they last said it. `""` means a paired contact said they
   * have none (removed, or not shared); absent means nothing was heard yet.
   */
  peerNick?: string;
  /** The contact's profile picture, as they last sent it (checked, small JPEG data URL). */
  peerAvatar?: string;
  /** Present on the side that created the link, until the peer shows up. */
  inviteCode?: string;
  /** Messages deleted on this device, by id, so a republished one is not stored again. */
  deletedIds?: string[];
  /** Ways of paying this device allows in this chat. Absent or true: allowed. */
  paymentMethods?: Partial<Record<PaymentMethodName, boolean>>;
  /** Store-and-forward for this contact (WISP 4xx, `hold/1`). Absent: off, as for every chat from before it. */
  hold?: HoldState;
  /** An edge of a private group (WISP 900): the group, and the member at the other end. Not a chat. */
  group?: string;
  groupPeer?: string;
  /**
   * Not an edge but an entry session of the group's link (`group-entry/1`): `host` on the admin's
   * side, toward a joiner's member key; `guest` on the joiner's, toward the link's entry key.
   */
  groupEntry?: "host" | "guest";
}

/** What happened to a group's membership, as a line in its history. */
export type GroupEvent = "created" | "joined" | "gone" | "admin" | "rotated" | "removed" | "left" | "forked" | "picture";

/** A private group as stored: an invitation not yet answered, or a group I am (or was) in. */
export interface StoredGroup {
  id: string;
  createdAt: number;
  /** Pending (or accepted, awaiting the welcome) invitation, on the invitee's side. */
  invitation?: {
    name: string;
    /** The inviter's member key, learned over the contact chat: the admin who must have admitted me. */
    admin: string;
    /** The contact chat it came over. */
    linkId: string;
    e: number;
    n: number;
    /** My member seed, once accepted. */
    seedB64?: string;
    /** Chain pieces that precede the welcome of a long chain. */
    pieces: { t: "group-chain"; g: string; commits: GroupCommit[] }[];
    /** Joining through the group's link: its entry key, the admin's side of `linkId` (an entry session, not a contact chat). */
    entry?: string;
  };
  /** On the admin's side: the group's link is on, with this entry key seed (`group-entry/1`). */
  entry?: { seedB64: string; createdAt: number };
  state?: GroupState;
  /** Member key → the contact chat that invited them (or me): the path for courtesy notices. */
  contacts?: Record<string, string>;
  /**
   * I left: the group is gone from the list and its history from the device. What is kept is the
   * edge to the admin, until the admin's commit removing me arrives or `at` is a week old, so
   * a leave said while the admin was away still reaches it.
   */
  left?: { at: number; admin: string };
  /** A community group (`group-community/1`) I am in: its session state. Mesh groups use `state`. */
  community?: CommunityState;
  /**
   * Joining a community group through its link (`group2/…`), or again after my admission lost a
   * race: my member seed, the entry session, and what arrived of the welcome.
   */
  joining?: { g: string; host: string; seedB64: string; linkId: string; name: string; inviter: string; invitedAt?: number; pieces: unknown[]; since: number };
}

export interface GroupMemberView {
  key: string;
  role: GroupRole;
  me: boolean;
  nick?: string;
  /** The pairwise edge to this member is open (always true for me). */
  online: boolean;
  /** Messages of the current epoch known to be missing from this member. */
  missing: number;
  /** The pairwise edge to this member as the engine sees it: absent for me, and until the edge exists. */
  edge?: GroupEdgeView;
}

/** One edge of a group's mesh (WISP 9xx): a paired link toward one member, which carries the group to and from them. */
export interface GroupEdgeView {
  linkId: string;
  /**
   * `open`: frames flow (the member is reachable). `connecting`: the member answered and the channel is being set up.
   * `waiting`: nothing heard from the member's app yet. `error`: the last attempt failed (`error` says why).
   */
  state: "open" | "connecting" | "waiting" | "error";
  /** The transport carrying the edge while it is open. Edges only offer WebRTC today. */
  transport?: PairedTransport;
  /** When this device last heard from the member on this edge, in ms (0: never). */
  lastSeenAt: number;
  error?: string;
}

/**
 * How far a join through a group's link got, as the joiner can know it: the knock is being left,
 * it is there for the admin's app to read, that app opened the entry session, it let me in.
 */
export type GroupJoinStage = "knocking" | "knocked" | "answered" | "admitted";

export interface GroupView {
  id: string;
  name: string;
  createdAt: number;
  /** Which kind of group: a private mesh of up to eight (`group-mesh/1`) or a community (`group-community/1`). */
  profile: "mesh" | "community";
  /** Absent while it is only an invitation. */
  status?: GroupStatus | "lost";
  statusReason?: string;
  epoch?: number;
  myKey?: string;
  isAdmin: boolean;
  members: GroupMemberView[];
  /** On the invitee's side, until the welcome arrives. */
  invitation?: { linkId: string; contact: string; admin: string; members: number; accepted: boolean; viaLink?: boolean; stage?: GroupJoinStage };
  /** The group's link while it is on (`group1/<id>/<entry key>`); only the admin who made it sees it. */
  entryLink?: string;
  /** Contacts (by chat id) invited by me and not yet in. */
  invited: string[];
  /** Contact chats that are members, by chat id → member key. */
  memberLinks: Record<string, string>;
  lastMessageAt: number;
  canSend: boolean;
  /** The group's picture (a JPEG data URL the engine checked), set by its admin; absent for none. */
  picture?: string;
  /** Community groups: how this device is connected (a hub for others, or through hubs). */
  community?: { hub: boolean; hubs: number; connected: number };
}

/** One item held in this device's storage for the contact, or on its way there. */
export interface HeldEntry {
  seq: number;
  /** The id on the wire: the text's wire id, the file's wire id or the payment id. */
  id: string;
  /** The chat message this item is, for its delivery state. */
  messageId: string;
  kind: Exclude<HoldKind, "manifest">;
  /** What to rebuild the bundle from: the file's local id or the payment id; text is on the message. */
  ref?: string;
  /** The object's name in storage, chosen before the first upload and kept across retries. */
  name: string;
  bytes: number;
  ts: number;
  expires: number;
  state: "queued" | "held" | "failed";
  error?: string;
}

/** Everything store-and-forward keeps per chat: the switch, what the contact said, sequences and the outbox. */
export interface HoldState {
  /** This device offers `hold/1` in this chat: it accepts held items, and holds items for the contact when it can. */
  enabled: boolean;
  /** The contact's app accepts held items, as it last said (handshake or session). */
  peerAllows?: boolean;
  /** This device's mailbox folder for the contact in its storage, chosen once. */
  mailbox?: string;
  /** Sequence of the last item held for the contact. */
  outSeq: number;
  /** Highest sequence received from the contact and stored. */
  inSeq: number;
  /** Highest sequence the contact said it received of what was held for it. */
  peerAck: number;
  /** This device's pointer revision, and the contact's last seen one. */
  pointerRev: number;
  peerPointerRev: number;
  /** When the manifest and its addresses were last signed (they live seven days). */
  manifestSignedAt?: number;
  outbox: HeldEntry[];
  /** Items from the contact refused on the way in (changed, oversized, not for this chat). */
  refused: number;
  /** Their sequences, the last 32, told to the contact on this device's pointer. */
  refusedSeqs?: number[];
  /** Ways of paying the contact allowed at the last session, for requests held while it is away. */
  peerPaymentMethods?: PaymentMethodName[];
}

/** A file attached to a message. The bytes live in the `files` store under `id`. */
export interface MessageFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  /** A voice message: its length and the shape of its sound. */
  voice?: VoiceMeta;
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
  /** Fedimint requests: the federations the payee takes ecash of (their ids). */
  federations?: string[];
  /** Fedimint payments: the federation of the notes, and the client operation that spent (or redeems) them. */
  federation?: string;
  fedimintOp?: string;
  requestId?: string;
  /** Requests we pay: a Lightning payment is in flight at the mint, so paying again would pay twice. */
  lightningPending?: boolean;
  /** Requests we pay: this device paid it over Lightning (the payee's wallet cannot say who paid an invoice). */
  paidHere?: boolean;
  /**
   * A request to a whole group (WISP 9xx § Payments): the group's id. Its `linkId` is `group:<id>`, it went to
   * every member over their edges, and the first member whose payment settles it pays it; later ones are refused.
   */
  group?: string;
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
  /** Federations joined with an invite code, and their ecash. */
  fedimint?: FedimintWalletView;
  /** Spark, wallet to wallet (the Breez SDK's Spark wallet; it can also be the Breez Lightning source). */
  spark?: SparkWalletView;
  usdt?: UsdtWalletView;
  /** The Lightning source of this mode (the Cashu mints by default) and its latest operations. */
  lightning?: LightningView;
  /** The on-chain Bitcoin source of this mode, if one is set up. */
  bitcoin?: BitcoinView;
  intents?: PaymentReview[];
  mints: MintView[];
  balance: number;
  /** Newest first. */
  history: WalletTx[];
  feesPaid: number;
}

export interface StoredMessage {
  wireId?: string;
  /**
   * `held`: in this device's storage, waiting for the contact to come back (WISP 4xx).
   * `queued`: unconfirmed, and sent again by itself under the same id once the chat can carry it.
   */
  delivery?: "sending" | "sent" | "queued" | "held" | "delivered" | "failed";
  deliveryError?: string;
  /** Until when a `queued` message is sent again by itself; after that it waits for Retry. */
  resendUntil?: number;
  linkId: string;
  id: string;
  text: string;
  sender: "me" | "peer";
  timestamp: number;
  /** `hold`: through the sender's storage while the other side was away (WISP 4xx). */
  via: "pkarr" | "datalink" | "hold";
  nick?: string;
  file?: MessageFile;
  paymentId?: string;
  /** Group messages: the member key of the sender. */
  member?: string;
  /** Group history lines that are not messages. */
  event?: GroupEvent;
  /** Group history: a payment between members, as the group knows it (WISP 9xx § Payments). */
  groupPay?: GroupPayNote;
}

/** The ways of paying a group note can name. */
export type GroupPayRail = "cashu" | "lightning" | "arkade" | "bark" | "bitcoin" | "spark" | "usdt" | "fedimint";

/**
 * A payment between two members as the whole group sees it (WISP 9xx § Payments): who pays whom, how much, over
 * what, and how it stands. No money and nothing to pay with: that travels only on the edge between the two.
 */
export interface GroupPayNote {
  id: string;
  /** `request`: a member asks to be paid; `payment`: a member sends without a request. */
  kind: "request" | "payment";
  /** Who pays: a member key, or `*` for a request any member may pay once. */
  from: string;
  /** Who is paid. */
  to: string;
  /** In the unit's smallest denomination (sats, token base units). */
  amount: string;
  unit: string;
  decimals: number;
  rail: GroupPayRail;
  /** Test money (test mints, test networks): worth nothing. */
  test?: boolean;
  memo?: string;
  /** The request answers the payer's own ask (Ark, Bark, on-chain, USDT): the payer started it. */
  ask?: boolean;
  createdAt: number;
  /** `sent`: the payer says it paid, the payee has not confirmed. `closed`: failed, refused or taken back. */
  state: "open" | "sent" | "paid" | "closed";
  /** Who paid it: the payee's word, or, when its wallet cannot tell (an invoice), the only member who said so. */
  by?: string;
  /** Members who said they paid it. */
  claims?: string[];
  /** The last note this device said about it, sent again when an edge opens. */
  mine?: GroupPayFrame;
}

/** `group-pay` on an edge (WISP 9xx § Payments). Old apps drop it. */
export interface GroupPayFrame {
  t: "group-pay";
  g: string;
  id: string;
  k: "req" | "pay";
  f: string;
  to: string;
  v: string;
  u: string;
  d: number;
  r: GroupPayRail;
  x?: 1;
  m?: string;
  a?: 1;
  ts: number;
  st: GroupPayNote["state"];
  by?: string;
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
  /**
   * Whether contacts are told this profile's name and picture (WISP 401 § name and picture). Absent means
   * yes; off, every chat and group member is told there is none, and the join notice names nobody.
   */
  shareProfile?: boolean;
  relays: string[];
  /** Extra ICE servers (typically TURN) on top of the built-in STUN set. */
  iceServers: IceServerSetting[];
  /** Cashu mints this peer holds ecash at and accepts ecash from. The first is where invoices are created. */
  mints: string[];
  /** False until the default mints were put in place once; after that the list is the user's. */
  mintsInitialized: boolean;
  /** Real money, or test networks: every wallet follows it. Absent means mainnet. */
  walletMode?: WalletMode;
  /** The Nostr social layer: relays, automatic profile loading, publication. Absent means the defaults, everything off. */
  nostr?: NostrSocialSettings;
  /**
   * Where items are held for away contacts (WISP 4xx): the profile's S3 storage and its random space
   * (WISP 1000/1002), as set up under Profile → Backups. Kept here for the peer, which may run outside the
   * page; never copied into a backup.
   */
  holdStorage?: { s3: S3Config; space: string } | null;
}

/**
 * What `updateSettings` takes: any settings, and of the Nostr ones only those that change. The rest of the
 * Nostr settings stay as stored, so a switch flipped from a page that has not seen the last save yet does not
 * put back what that save replaced.
 */
export type SettingsPatch = Partial<Omit<Settings, "nostr">> & { nostr?: Partial<NostrSocialSettings> };

/** What pages see of store-and-forward in one chat. */
export interface LinkHoldView {
  /** The switch of this chat on this device. */
  enabled: boolean;
  /** The contact's app accepts held items, as it last said; undefined until it said anything. */
  peerAllows?: boolean;
  /** This device has storage to hold items in (Profile → Backups → S3 storage). */
  storage: boolean;
  /** Items can be held for the contact right now: switch on, contact allows it, storage set up, contact pinned. */
  canHold: boolean;
  /** Items held for the contact and not yet picked up. */
  outstanding: number;
  bytes: number;
  maxBytes: number;
  maxItems: number;
  ttlMs: number;
  /** Items from the contact refused on the way in. */
  refused: number;
  /** The last problem holding or picking up, for people. */
  error?: string;
}

/** A proof of this profile (Identities). */
export interface IdentityProofView {
  id: string;
  provider: string;
  subject: string;
  /** The proof key the statement authorizes. */
  key: string;
  verified: VerifiedIdentity;
  issuedAt: number;
  /** Seconds: the earlier of the statement's and the evidence's expiry. */
  expiresAt: number;
  createdAt: number;
  /** Chats it is currently shared in (or queued for). */
  sharedWith: number;
}

/** A contact's proof, as this app checked it. */
export interface ReceivedIdentityView {
  id: string;
  provider: string;
  subject: string;
  verified: VerifiedIdentity;
  /** A public name/picture looked up on request. */
  display?: IdentityDisplay;
  status: IdentityStatus;
  verifiedAt: number;
  checkedAt: number;
  expiresAt: number;
  error?: string;
  /** The provider's checks can go stale and the last one is old enough to repeat. */
  recheckDue: boolean;
}

export interface LinkIdentitiesView {
  /** Both sides offer identity proofs and the channel is open now. */
  support: boolean;
  /** Providers the contact's app said it can verify. */
  contactProviders?: string[];
  shared: SharedIdentity[];
  received: ReceivedIdentityView[];
  error?: string;
}

export interface LinkView {
  /** Identity proofs in this chat; absent for chats that are not paired. */
  identities?: LinkIdentitiesView;
  /** The contact's Nostr data, one entry per key they proved in this chat. */
  nostr?: NostrContactView[];
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
  /**
   * How far this chat's first pairing got (`@ghostly/core` `PairingProgress`): from the invite being
   * published to `live`. Absent for chats paired before this app start, DHT-only invites and legacy chats.
   */
  pairingProgress?: PairingProgress;
  peerVerified?: boolean;
  /** `methods`: ways of paying both sides allow in this chat right now. */
  capabilities?: { files: boolean; payments: boolean; methods?: Record<PaymentMethodName, boolean> };
  /** Ways of paying this device allows in this chat. */
  paymentMethods?: Record<PaymentMethodName, boolean>;
  /** Both sides announced private groups on the open session: this contact can be invited. */
  groups?: boolean;
  availableTransports?: PairedTransport[];
  deliveryMode?: DeliveryMode;
  dhtDelivery?: DhtDeliveryView;
  canSendText?: boolean;
  /** `hold`: the contact is away and what is sent now waits in this device's storage for it. */
  textDelivery?: "stream" | "dht" | "hold" | "unavailable";
  hold?: LinkHoldView;
  transportErrors?: Partial<Record<PairedTransport, string>>;
  preferredTransport?: PairedTransport;
  transportFallback?: boolean;
  id: string;
  myPubKeyZ32: string;
  peerPubKeyZ32: string;
  label?: string;
  /**
   * The name the contact asked to be shown by, as they last said it. `""` means a paired contact said they
   * have none (removed, or not shared); absent means nothing was heard yet.
   */
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
  /** This profile's identity proofs. */
  identityProofs: IdentityProofView[];
  /** The Nostr social layer: the person's own keys' data and the effective settings. */
  nostr: NostrSocialState;
  /** Private groups and pending invitations (WISP 900). */
  groups: GroupView[];
  /** The links of groups' edges: not chats, but payments with a member travel on them. */
  edges?: LinkView[];
}
