import type { DiscoveryStatus, GroupMention, ImageMeta, LinkPreview, PairingProgress, PaymentMethodName, RoutineCard, StatusCard, TaskCard, TypingKind, VideoMeta, VoiceMeta, WirePin, WireReaction } from "@ghostly/core";
import type { UsdtWalletView } from "../engine/paymentAdapters/usdtWallet";
import type { ArkWalletView } from "../engine/paymentAdapters/arkWallet";
import type { BarkWalletView } from "../engine/paymentAdapters/barkWallet";
import type { FedimintWalletView } from "../engine/paymentAdapters/fedimintWallet";
import type { SparkWalletView } from "../engine/paymentAdapters/sparkWallet";
import type { LightningView } from "../engine/paymentAdapters/providers/lightningService";
import type { LightningCardView } from "../engine/paymentAdapters/providers/lightningCards";
import type { BitcoinView } from "../engine/paymentAdapters/providers/bitcoinService";
import type { PaymentReview, PaymentTarget, VapidKeys, WakeTarget, WalletNetwork } from "@ghostly/core";
import type { ProviderDescriptorView } from "../engine/paymentAdapters/providers/types";
import type { CapsState, DeliveryMode, DhtDeliveryState, DhtDeliveryView, HoldKind } from "@ghostly/core";
import type { S3Config } from "../backup/s3";
import type { BackupReminders } from "./backupReminder";
import type { TransportCause, TransportEntry, TransportEvent } from "../engine/transportLog";
import type { PublicProfile, ProfileChoice } from '../profiles/public';
import type { NostrContactCache, NostrContactView, NostrSocialSettings, NostrSocialState } from "../nostr/types";
import type { ProofLedger, ProofAdapter } from "@ghostly/core";
import type { IdentityDisplay, IdentityLedger, IdentityStatus, IdentityTimelineEntry, SharedIdentity, VerifiedIdentity } from "@ghostly/core";
import type { DataLinkState, LinkStatus, LiveAttempt, ServiceAd, PairingState, NativeTransport, PairedTransport, TransportDescriptors, TransportWait } from "@ghostly/core";
import type { CommunityState, GroupByeFrame, GroupCommit, GroupRole, GroupState, GroupStatus } from "@ghostly/core";

/** A link as stored in IndexedDB. Same fields Desktop keeps in its ChatSession. */
export interface StoredLink {
  /**
   * Paired 1:1 chats: how to wake the contact's closed web app, as it shared it (`wake/1`, WISP 401 § Wake-up push).
   * Absent until it does, and again once it stops sharing or its push service says the subscription is gone.
   */
  peerWake?: WakeTarget;
  /** Paired 1:1 chats: this side's token for this chat in its own wake-ups; a new one whenever the subscription changes. */
  wakeToken?: string;
  /** Paired 1:1 chats: muted here, so the contact is told to forget this side's subscription until it is unmuted. */
  wakeMuted?: boolean;
  deliveryMode?: DeliveryMode;
  dhtDeliveryState?: DhtDeliveryState;
  /** This side's layer-0 capability record and the contact's last good one (WISP 03). */
  capsState?: CapsState;
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
  /** Absent: no choice for this chat, the app's rule applies ("Automatic"). */
  preferredTransport?: PairedTransport;
  transportFallback?: boolean;
  /** The chat's connection story, newest last (see engine/transportLog.ts). Local only. */
  transportLog?: TransportEntry[];
  /** Every connection event, for the connection panel, newest last (see engine/transportLog.ts). Local only. */
  transportHistory?: TransportEvent[];
  pairedPeerKey?: string;
  /** The inviter's participation key, from a `ghostly1` code (the joiner's side): the only key that may be pinned. */
  peerParticipationKeyZ32?: string;
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
  /**
   * Files of mine whose offer went on the DHT floor (WISP 403 § Files) and that were deleted here before they went live,
   * by wire id: the next session that carries files/3 says each is cancelled (`pf-abort`), so the contact's bubble does too.
   */
  withdrawnFiles?: string[];
  /** This side's reactions the contact has not confirmed yet (WISP 401 § Reactions), in the order of their numbers. */
  reactionsOut?: WireReaction[];
  /** The chat's pinned message (WISP 400 § Pinned message): the latest pin, either side's; `id` "" once unpinned. */
  pin?: StoredPin;
  /** This side's pin the contact has not confirmed yet (WISP 401 § Pinned message): said on each live session until it does. */
  pinOut?: WirePin;
  /** Ways of paying this device allows in this chat. Absent or true: allowed. */
  paymentMethods?: Partial<Record<PaymentMethodName, boolean>>;
  /**
   * For a way of paying, the networks this chat accepts it on (its cards on the Accept side). Absent for a method:
   * every network. A request, a payment or an ask of a network off here is refused, and the contact is told.
   */
  paymentNetworks?: Partial<Record<PaymentMethodName, WalletNetwork[]>>;
  /** Store-and-forward for this contact (WISP 404, `hold/1`). Absent: off, as for every chat from before it. */
  hold?: HoldState;
  /** An edge of a private group (WISP 900): the group, and the member at the other end. Not a chat. */
  group?: string;
  groupPeer?: string;
  /**
   * Not an edge but an entry session of the group's link (`group-entry/1`): `host` on the admin's
   * side, toward a joiner's member key; `guest` on the joiner's, toward the link's entry key.
   */
  groupEntry?: "host" | "guest";
  /**
   * An edge whose session is up: set when it opens, cleared when it drops while this app runs (not when the app quits).
   * Still set when the app starts, it was live when the app last ran, and is dialled at once (`resume`). Local only.
   */
  edgeLive?: boolean;
  /** When that session opened: a member's offer from before it is not answered after a restart (`resumeFloor`). Local only. */
  edgeLiveSince?: number;
}

/** What happened to a group's membership, as a line in its history. */
export type GroupEvent = "created" | "joined" | "gone" | "admin" | "rotated" | "removed" | "left" | "forked" | "picture" | "renamed";

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
   * Members whose apps said (`paired-groups` version 3, on their edge or the link that admitted them) that they take
   * rosters past eight: an admin grows the group past eight only when every other member is here (WISP 902 § Bounds).
   */
  large?: string[];
  /**
   * Past 16 members, with hubs (WISP 902 · Group Mesh § Hubs): the hubs I kept edges with (as a hub, the other hubs),
   * where my edges go when the app starts again, before the beacon is read.
   */
  hubs?: string[];
  /** Members whose edge came up without `paired-groups` version 4: their apps take no hubs, so hubs keep edges with them. */
  legacy?: string[];
  /**
   * I left: the group is gone from the list and its history from the device. What is kept is the
   * edge to the admin, until the admin's commit removing me arrives or `at` is a week old, so
   * a leave said while the admin was away still reaches it. With hubs, the edges to my hubs too, and my
   * signed leave (`bye`) that they carry to the admin.
   */
  left?: { at: number; admin: string; hubs?: string[]; bye?: GroupByeFrame };
  /**
   * On the admin's side: members I removed while they could not be told (their edge was down, and no contact chat
   * carried the notice), by member key. `e`: the epoch of the commit that removed them; `at`: when. The edge to each
   * stays until it opens and that commit goes over it (`told`, the first time), or `at` is a week old: a member removed
   * while its app was closed otherwise never learns it, since every member closes the edge to someone out of the
   * roster. `opened`: when the edge's connection first opened; it closes a while after, told or not.
   */
  farewells?: Record<string, { at: number; e: number; told?: number; answered?: number; opened?: number }>;
  /** The group's pinned message (WISP 400 § Pinned message): the latest pin; `id` "" once unpinned. */
  pin?: StoredPin;
  /**
   * When the latest message of another member (`peer`) and the latest one that names me (`mention`) reached this
   * device, where that is later than the message's own time (`cameAt`): what makes the group unread survives a restart.
   */
  came?: { peer?: number; mention?: number };
  /** A community group (`group-community/1`) I am in: its session state. Mesh groups use `state`. */
  community?: CommunityState;
  /**
   * Joining a community group through its link (`group2/…`), or again after my admission lost a
   * race: my member seed, the entry session, and what arrived of the welcome.
   */
  joining?: { g: string; host: string; seedB64: string; linkId: string; name: string; inviter: string; invitedAt?: number; pieces: unknown[]; since: number; check?: boolean };
}

export interface GroupMemberView {
  key: string;
  role: GroupRole;
  me: boolean;
  nick?: string;
  /** The pairwise edge to this member is open, or a hub I am connected to reaches them (always true for me). */
  online: boolean;
  /** Reached through a hub, not an edge of mine (WISP 902 · Group Mesh § Hubs). */
  viaHub?: boolean;
  /** A hub of the group now (listed in its beacon), and what the admin said: pinned as a hub, or never one. */
  hub?: boolean;
  hubRole?: "pin" | "exclude";
  /** Messages of the current epoch known to be missing from this member. */
  missing: number;
  /** The pairwise edge to this member as the engine sees it: absent for me, and until the edge exists. */
  edge?: GroupEdgeView;
}

/** One edge of a group's mesh (WISP 902): a paired link toward one member, which carries the group to and from them. */
export interface GroupEdgeView {
  linkId: string;
  /**
   * `open`: frames flow (the member is reachable). `connecting`: the member answered and the channel is being set up.
   * `waiting`: nothing heard from the member's app yet. `error`: the last attempt failed (`error` says why).
   */
  state: "open" | "connecting" | "waiting" | "error";
  /** The transport carrying the edge while it is open: WebRTC, or Iroh or HyperDHT where one side has none. */
  transport?: PairedTransport;
  /**
   * Waiting because this device has no free native slot for it (a member reached over Iroh or HyperDHT, and the
   * device's native listeners held by chats and other group links): it is tried again as one frees up.
   */
  noSlot?: true;
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
  /** Which kind of group: a private mesh of up to 32 (`group-mesh/1`) or a community (`group-community/1`). */
  profile: "mesh" | "community";
  /** Absent while it is only an invitation. */
  status?: GroupStatus | "lost";
  statusReason?: string;
  epoch?: number;
  myKey?: string;
  isAdmin: boolean;
  /**
   * Admin work is off for this group on this device (WISP 06 § Forced takeover): no commit is signed and no door duty
   * taken until the person turns on "Manage groups from this device" (`setGroupManage`).
   */
  adminOff?: true;
  members: GroupMemberView[];
  /** On the invitee's side, until the welcome arrives. */
  /** `waiting`: joining a community through its link, how many others were knocking with me when I last knocked. */
  invitation?: { linkId: string; contact: string; admin: string; members: number; accepted: boolean; viaLink?: boolean; stage?: GroupJoinStage; waiting?: number };
  /** The group's link while it is on (`group1/<id>/<entry key>`); only the admin who made it sees it. */
  entryLink?: string;
  /** Contacts (by chat id) invited by me and not yet in. */
  invited: string[];
  /** Contact chats that are members, by chat id → member key. */
  memberLinks: Record<string, string>;
  lastMessageAt: number;
  /** When the latest message from another member arrived (what makes the group unread; mine and membership lines do not); absent for none. */
  lastPeerMessageAt?: number;
  /** When the latest message that names me arrived; absent for none. */
  lastMentionAt?: number;
  /** The latest reaction in the group, for the chat list. */
  lastReaction?: ReactionNote;
  /** The group's pin (WISP 400 § Pinned message): `id` "" once unpinned; absent when nothing was ever pinned. */
  pin?: PinView;
  canSend: boolean;
  /** The group's picture (a JPEG data URL the engine checked), set by its admin; absent for none. */
  picture?: string;
  /**
   * A private group past 16 members that runs on hubs (WISP 902 · Group Mesh § Hubs): `hub` when I am one. Absent for
   * the full mesh.
   */
  hubs?: { hub: boolean };
  /** Community groups: how this device is connected (a hub for others, or through hubs). */
  community?: { hub: boolean; hubs: number; connected: number };
  /** Private groups: the members typing now, in the order they started (WISP 902 · Group Mesh § Typing). Never stored. */
  typing?: GroupTypingView[];
  /** Private groups: this side's wake-up tokens, one per member it shared its subscription with (the push worker's table). */
  wakeTokens?: string[];
  /** Private groups: its members were told not to wake this side while the group is muted (`setWakeMuted`). */
  wakeMuted?: boolean;
  /**
   * The names of authors no longer in the roster (removed, left, or back with a new member key), by
   * member key, so their earlier messages still say who wrote them. Absent when there are none.
   */
  formerNames?: Record<string, string>;
}

/** A member typing in a group: `kind` when it is not plain typing, and a bot's status line, sanitized as in a 1:1 chat. */
export interface GroupTypingView { key: string; kind?: Exclude<TypingKind, "typing">; status?: string }

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
  /** A video: its length, size and a small first frame, when the sender sent them. */
  video?: VideoMeta;
  /** A picture: its size as it is shown, when the sender sent it. */
  image?: ImageMeta;
}

export interface FileTransferView {
  state: "transferring" | "done" | "failed";
  transferred: number;
  size: number;
  error?: string;
  /**
   * files/3 (WISP 501 rev 0.3), while `transferring`: where it stands when it is not moving. `waiting`: no live
   * connection (it goes on by itself); `asking`: the receiver's person has not decided (on the receiving side,
   * this person); `queued`: accepted, waiting its turn; `paused`; `verifying`: every byte there, checking the digest.
   */
  stage?: "preparing" | "waiting" | "asking" | "queued" | "paused" | "verifying";
  /** files/3: the transfer can be paused, resumed and cancelled from here. */
  direction?: "in" | "out";
  pausedBy?: "me" | "peer";
  /** Bytes per second lately, while moving. */
  rate?: number;
  /** Receiving, `asking`: bytes this device can still take for files, when it says. */
  room?: number | null;
  /** Failed but the sender can offer it again (files/3). */
  retry?: boolean;  /**
   * files/3, unfinished and not moving for a while (or not since the app started): the sender can send it again
   * (`resend`), the receiver ask for it again (`request`). Either goes on from what the receiver holds.
   */
  stalled?: boolean;
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
  /**
   * Brought back by a profile restore: a copy of ecash as it was when the backup was made, which the profile it was
   * copied from (or this one, before the backup was restored) may have spent since. The mint is asked once, and a
   * proof it reads spent is dropped (see `CashuWallet.checkRestored`).
   */
  unchecked?: boolean;
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

/**
 * A swap at a mint, written down before the mint is asked, with everything that finishes it: the mint signs the
 * outputs of `swap` and nothing else, so its signatures can be asked for again (NUT-09) for as long as this is kept.
 * Deleted in the transaction that stores what the swap brought, or once the mint says it never happened.
 */
export interface PendingSwap {
  id: string;
  mint: string;
  /** `receive`: a token redeemed into this wallet. `send`: this wallet's ecash split, for a token or a Lightning payment. */
  kind: "receive" | "send";
  /** cashu-ts' `SerializedSwapPreview`: the inputs and the blinded outputs with their secrets. As secret as the ecash itself. */
  swap: unknown;
  createdAt: number;
  /** When the request to the mint ended with no answer. The mint may still act on it for a moment after that. */
  attemptEndedAt?: number;
  /**
   * The inputs were given back (the swap was overdue with nothing signed), and it holds nothing any more. Still asked
   * about for a while: a request that reached the mint late is recovered from what is written here.
   */
  released?: boolean;
  /** What it brought is stored; only the chat of its payment is still to be told (the app closed in between). */
  finished?: boolean;
  /**
   * Its inputs read spent at a mint that cannot say what it signed (no NUT-09): how many times that was the answer.
   * Kept, since the outputs are the only way back to that ecash, and asked about less and less often (`askAt`).
   */
  stuck?: number;
  /** Not asked about before this time. */
  askAt?: number;
  /** Came with a restored copy of the profile: what it brings is as old as the copy, and is checked like the copy's ecash. */
  restored?: boolean;
  /** `receive`: the token being redeemed. Redeeming it again while this is kept finishes this swap, and makes no other. */
  token?: string;
  /** `receive`: the history line of the ecash, written with it. */
  tx?: WalletTx;
  /** `receive`: the payment record written with the ecash (a contact's payment received, or one of ours taken back). */
  payment?: StoredPayment;
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
  /** The mint said this invoice is paid, and its ecash is not claimed yet (the claim is tried again every round). */
  paid?: boolean;
  /**
   * The mint marks its invoices paid by itself (a test mint, `paysItsOwnInvoices`): its "paid" says nothing about a
   * payer. Not polled, never minted by itself: a payer saying it paid (`CashuWallet.vouch`) lets it be minted.
   */
  held?: boolean;
  /** Asked for on purpose, as test coins from a test mint ("Get test coins"): minted as soon as the mint says paid. */
  testCoins?: boolean;
  /**
   * The blinded outputs the mint is asked to sign for this invoice (`OutputData.serialize`), written down before it
   * is asked: the ecash it issues is for these, and its signatures for them can be asked for again (NUT-09).
   */
  outputs?: unknown[];
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
  /**
   * Real money or test coins: only a wallet of this network pays a request, or made a payment. Absent on records
   * from before wallets had their own network: its target, mints or invoice say (see `paymentNetwork`).
   */
  network?: WalletNetwork;
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
   * A request to a whole group (WISP 902 § Payments): the group's id. Its `linkId` is `group:<id>`, it went to
   * every member over their edges, and the first member whose payment settles it pays it; later ones are refused.
   */
  group?: string;
  /**
   * A request closed by the one who made it (their wallet for it was removed): it can no longer be paid, and a
   * payment still made to what it named is lost. Set on both sides, with `state` "failed".
   */
  closed?: boolean;
}

/** What pages see of a payment: everything but the token. */
export type PaymentView = Omit<StoredPayment, "token">;

export interface MintView {
  url: string;
  name: string;
  balance: number;
  /** Null until the mint answered once. */
  info: MintInfoView | null;
  /** What it still waits for (see `mintAwaiting`), when it does: removing it asks about these first. */
  awaiting?: WalletAwaitingView[];
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
  | "reclaimed"
  | "fee"; // a Lightning payment failed, and the mint kept its fee for preparing it (`amount` 0)

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

/** The kinds of wallet a profile can have: each is one card of the deck, on one network. */
export type WalletType = "cashu" | "lightning" | "arkade" | "bark" | "spark" | "bitcoin" | "fedimint" | "usdt";
export const WALLET_TYPES: readonly WalletType[] = ["cashu", "lightning", "arkade", "bark", "spark", "bitcoin", "fedimint", "usdt"];

/** One network's wallets, whole: what `WalletView` shows of the network in use, for either network. */
export interface NetworkWalletsView {
  ark?: ArkWalletView;
  bark?: BarkWalletView;
  fedimint?: FedimintWalletView;
  spark?: SparkWalletView;
  usdt?: UsdtWalletView;
  /** The network's default Lightning card for receiving (what a caller from before cards reads as its Lightning). */
  lightning?: LightningView;
  /** Every Lightning card of the network, in the order they were added: each its own source, balance and history. */
  lightnings?: LightningCardView[];
  bitcoin?: BitcoinView;
  /** This network's Cashu mints (test mints and mints on this machine are Testnet's). */
  mints: MintView[];
  balance: number;
  /** Cashu: sats held for a payment or a swap the mints have not settled yet. Not in `balance`, and not gone. */
  setAside?: number;
  /** Cashu: swaps at these mints that are not finished yet, and the sats in them. Removing the wallet names them. */
  openSwaps?: number;
  swapsAmount?: number;
  /** Cashu: sats in swaps whose inputs read spent at a mint that cannot say what it gave for them. Not in `setAside`. */
  unconfirmed?: number;
  /** This network's history, newest first. */
  history: WalletTx[];
  feesPaid: number;
  /** What this network's wallets still wait for: removing one reads it (see `walletRemoval`). Always set by the engine. */
  awaiting?: WalletAwaitingView[];
}

/**
 * Something one wallet still waits for. `request`: a request of ours still open in a chat that only this wallet can
 * be paid through; `invoice`: an invoice of its own, not paid and not expired; `paid`: an invoice the mint says is
 * paid whose ecash is not claimed yet; `unclaimed`: ecash the mint says it issued for an invoice of ours that this
 * wallet never received; `sent`: ecash sent from it that the contact has not taken yet. Removing the wallet loses
 * what is paid to the first four; `sent` Cashu comes back once its mint is added again.
 */
export interface WalletAwaitingView {
  /** The wallet it goes through (Lightning through the Cashu mints is the Cashu wallet's). */
  type: WalletType;
  /** `swap`: sats in an exchange with a Cashu mint that the mint has not settled yet (`PendingSwap`). */
  kind: "request" | "invoice" | "paid" | "unclaimed" | "sent" | "swap";
  /** In the wallet's base unit: sats, or the token's smallest unit for USDT. */
  amount: number;
  /** The chat payment it belongs to, when it does. */
  paymentId?: string;
  /** Lightning: the card it goes through. */
  card?: string;
}

/**
 * A wallet the profile has: one type on one network, one of each but Lightning, which a network can have several
 * cards of. `id` is `<type>:<network>`, and `lightning:<network>:<card>` for a Lightning card. Its seed and secrets
 * stay in the engine; `config` holds only what can be shown (a server, a source).
 */
export interface WalletInstanceView {
  id: string;
  type: WalletType;
  network: WalletNetwork;
  config: Record<string, string>;
  /** Lightning: the card's id on its network, its name, and whether it is the network's default for receiving. */
  card?: string;
  name?: string;
  receive?: boolean;
  /**
   * At home on another device (WISP 06 § Wallets that stay home): that device's name ("" when this device does not know
   * it), and when its coins expire (Ark, Bark). It is never opened here, and takes no payment here.
   */
  home?: { device: string; expiresAt?: number };
}

/**
 * What New can make: one type on one network. `available` false: `reason` says why (Mainnet not validated yet,
 * one already there). `needs`: the one thing it asks for, when it cannot be made in one click.
 */
export interface WalletOffer {
  type: WalletType;
  network: WalletNetwork;
  available: boolean;
  reason?: string;
  /** Already made: its card is in the deck. */
  exists?: boolean;
  /** A network can have several of it (Lightning): New adds one more, whatever `exists` says. */
  several?: boolean;
  needs?: "invite" | "provider" | "apiKey";
  /** Lightning and on-chain: the sources that can be picked on this network. */
  providers?: ProviderDescriptorView[];
}

/** What New asks the engine to make (see `walletCreate`). */
export interface WalletCreate {
  type: WalletType;
  network: WalletNetwork;
  /** Lightning and on-chain: the source, and the values of its form (blank ones take the network's default). */
  providerId?: string;
  values?: Record<string, string>;
  /** Fedimint: the federation's invite code. */
  invite?: string;
  /** Spark on Mainnet: the person's Breez API key. */
  apiKey?: string;
}

/** What Remove asks the engine to take away (see `walletRemove`). */
export interface WalletRemove {
  type: WalletType;
  network: WalletNetwork;
  /** Lightning: the card to remove; absent, the network's default for receiving. */
  card?: string;
  /** The person confirmed that what it holds on this device becomes unreachable without its backup. */
  acceptLoss?: boolean;
}

/** "Get test coins" on a Testnet wallet: which one asks its faucet. */
export interface WalletTestCoins {
  type: WalletType;
  network: WalletNetwork;
  /** Lightning: the card asking (only the Cashu mints' card has a faucet); absent, the default one. */
  card?: string;
}

/** What the faucet gave: `amount` in the wallet's own unit ("test sats", "TEST-USDT"). */
export interface TestCoinsResult {
  amount: number;
  unit: string;
  /** Asked, and on its way (a transaction the chain has not confirmed): it shows up in a few seconds. */
  pending?: boolean;
}

/**
 * The first-run wallet setup of a new profile: the Mainnet kinds still to make, and why the last try at each failed.
 * Kept in the settings. Absent on a profile from before it, which is never set up by itself.
 */
export interface WalletSetupRecord {
  /** Kinds not made yet, tried again at each start. A kind with no Mainnet wallet here yet (on-chain) waits quietly. */
  left: WalletType[];
  /** Why the last try failed, per kind still left. */
  failed?: Partial<Record<WalletType, string>>;
}

/** What the Wallet page shows of the first-run setup: whether it runs now, and each kind it could not make. */
export interface WalletSetupView {
  running: boolean;
  failed: { type: WalletType; network: WalletNetwork; reason: string }[];
}

export interface WalletView {
  /** The first-run setup, while it runs or has a kind it could not make; absent otherwise. */
  setup?: WalletSetupView;
  /** Both networks' wallets, open side by side. The flat fields below are Mainnet's, for a caller naming no network. */
  networks?: Record<WalletNetwork, NetworkWalletsView>;
  /** The wallets this profile has, in the deck's order. */
  wallets?: WalletInstanceView[];
  /** What New can make on each network. */
  offers?: WalletOffer[];
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
  lightnings?: LightningCardView[];
  /** The on-chain Bitcoin source of this mode, if one is set up. */
  bitcoin?: BitcoinView;
  intents?: PaymentReview[];
  mints: MintView[];
  balance: number;
  /** Cashu: see `NetworkWalletsView`. */
  setAside?: number;
  openSwaps?: number;
  swapsAmount?: number;
  unconfirmed?: number;
  /** Newest first. */
  history: WalletTx[];
  feesPaid: number;
  /** Each Mainnet wallet's backup reminder, by wallet id: the page works out which asks now (`backupDue`). */
  backupReminders?: BackupReminders;
}

export interface StoredMessage {
  wireId?: string;
  /**
   * `held`: in this device's storage, waiting for the contact to come back (WISP 404).
   * `queued`: unconfirmed, and sent again by itself under the same id once the chat can carry it.
   * `waiting`: not sent yet; it goes by itself when the chat can carry it (live, or the DHT text before it
   * confirmed), and can be cancelled meanwhile ("Sends when live", WISP 400).
   */
  delivery?: "sending" | "sent" | "queued" | "waiting" | "held" | "delivered" | "failed";
  deliveryError?: string;
  /** Until when a `queued` message is sent again by itself; after that it waits for Retry. */
  resendUntil?: number;
  /**
   * A file of mine that waits for the live link, said on the DHT floor meanwhile (WISP 403 § Files): `sent` its offer
   * went, `seen` the contact's app took it (its bubble is in place there), `unfit` it cannot go there (it waits as before).
   */
  fileOnFloor?: "sent" | "seen" | "unfit";
  linkId: string;
  id: string;
  text: string;
  sender: "me" | "peer";
  /**
   * The row's place in its history, which is sorted by it (WISP 400, requirement 10). Mine: when I sent it. Received:
   * when it was first stored on this device (`arrivalKey`), never the sender's clock, so a conversation reads in the
   * order things happened here. A row received before `sentAt` existed keeps the sender's time it was stored under.
   */
  timestamp: number;
  /** Received: when the sender says it sent it, by its own clock. Shown (`shownTime`), never sorted by. */
  sentAt?: number;
  /** `hold`: through the sender's storage while the other side was away (WISP 404). */
  via: "pkarr" | "datalink" | "hold";
  nick?: string;
  file?: MessageFile;
  paymentId?: string;
  /** Group messages: the member key of the sender. */
  member?: string;
  /** Group history lines that are not messages. */
  event?: GroupEvent;
  /** Group history: a payment between members, as the group knows it (WISP 902 § Payments). */
  groupPay?: GroupPayNote;
  /** Group messages: the places of the text that name members, by member key (WISP 902 § Mentions). */
  mentions?: GroupMention[];
  /** A group message someone else sent that names me (or everyone). */
  mentioned?: true;
  /** How this message travelled, as the engine saw it go or come (the message's details view). */
  details?: MessageDetails;
  /** A link preview that came with the text (WISP 401 § Link previews): made by the sender's app, never fetched here. */
  preview?: LinkPreview;
  /** The message this one answers (WISP 400 § Replies). */
  replyTo?: MessageReply;
  /**
   * Reactions to it (WISP 400 § Reactions), one per person: `me`, `peer` (a 1:1 chat's contact) or a group member's
   * key. One taken back stays with an empty emoji, so an older reaction arriving late does not bring it back.
   */
  reactions?: Record<string, MessageReaction>;
  /** A text edited after it was sent (WISP 400 § Edits): `text` is the latest version. */
  edit?: MessageEdit;
  /**
   * A forwarded text or file (WISP 400 § Forwards): how many times it has been forwarded, this hop included. Only the
   * count: never who wrote it first, nor where it came from.
   */
  forwarded?: number;
  /**
   * A bot's status card (WISP 405 · Status Cards): a task or a routine shown instead of `text`, which is its fallback.
   * It belongs to the version it came with: an edit brings its own, or leaves the message a text.
   */
  card?: StatusCard;
  /**
   * A reply that presses a button of this side's own message (WISP 406 · Message Buttons), as the author's engine took
   * it: set only when the button was open for this person. What `button.pressed` reports.
   */
  press?: MessagePress;
  /**
   * A question of mine with buttons whose text went on the DHT floor or into a hold, which carry text alone (WISP 406 ·
   * Message Buttons): `due` until its buttons go again live, as an edit of the buttons alone; `sent` once they did.
   */
  buttonsRestore?: "due" | "sent";
}

/**
 * A message that carries a task or a routine card, as the Tasks board reads it across every chat and group
 * (`statusCardIndex`): where it is (`linkId`: a chat's id, or `group:<id>`), its message, who sent it (`member`: a group
 * member's key, absent for my own), when it was sent and when its last edit was made. Nothing else of the message.
 */
export interface CardIndexRow {
  linkId: string;
  id: string;
  card: TaskCard | RoutineCard;
  sender: "me" | "peer";
  member?: string;
  timestamp: number;
  editedAt?: number;
}

/** A page of a chat's history, oldest first, and whether older messages remain (`messagePage`). */
export interface MessagePage { messages: StoredMessage[]; more: boolean }

/**
 * A chat's pin as kept (WISP 400 § Pinned message): the message's id both sides know (`id`, "" unpinned), the pinner's
 * number (the highest wins), who pinned (`me`, `peer`, or a member's key) and when it came here. `messageId`: the row
 * here, when it was here then. A private group's keeps the pinner's signature (`k`, `sig`), to pass it on.
 */
export interface StoredPin extends WirePin { by: string; at: number; messageId?: string; k?: string; sig?: string }

/** A chat's pin, as the pages and the CLI see it. `id`: the id both sides know the message by ("" once unpinned); `messageId`: the row here. */
export interface PinView { id: string; by: string; at: number; messageId?: string }

/** One person's reaction to a message: the emoji ("" once taken back), their number (the highest wins), when it came. */
export interface MessageReaction { e: string; n: number; at: number }

/** The latest reaction in a chat, as the chat list says it: "Ana reacted ❤️ to "…"". */
export interface ReactionNote {
  at: number;
  /** Who reacted: `me`, `peer`, or a group member's key. */
  by: string;
  emoji: string;
  /** A line of the message it went to. */
  snippet: string;
  /** The message was mine. */
  mine: boolean;
  /** The message's id here: an edit of it changes `snippet`. */
  message?: string;
}

/** How a message was edited (WISP 400 § Edits). */
export interface MessageEdit {
  /** The edit shown: its number (1 for the first; the highest one wins) and when its author made it. */
  seq: number;
  at: number;
  /** Earlier versions, oldest first (the newest `EDIT_HISTORY_KEEP`): when each was written, and its text. */
  history: MessageVersion[];
  /** Mine: the contact has not confirmed this edit yet. It goes by itself once the chat is live and both sides offer edit/1. */
  pending?: true;
  /**
   * Mine: the engine's own edit that sends a question's buttons again, the text unchanged (WISP 406 · Message Buttons),
   * never one a person or a bot made. The bot's event stream reports none for it; a later edit makes a new one without it.
   */
  restore?: true;
}

export interface MessageVersion { at: number; text: string }

/**
 * The message a reply answers, as kept with the reply (WISP 400 § Replies). What the replier's app saw of it goes
 * with the reply; the receiver keeps its own view of the original when it has it (`messageId`), and the line and the
 * author then come from there, not from the wire.
 */
/** A button press on this side's message (WISP 406 · Message Buttons). */
export interface MessagePress {
  /** The message with the buttons, its id here. */
  messageId: string;
  button: string;
  label: string;
  /** Named by its label or id in the text, not by the reply (the DHT floor, or an app without buttons). */
  inferred?: true;
}

export interface MessageReply {
  /** The original's id in this chat as both sides know it: a paired chat's wire, file or payment id; a group message id. */
  id: string;
  /** A line of the original, plain and short (`replySnippet`); empty when only its id came (over the DHT). */
  snippet: string;
  /** Who wrote the original; absent when nothing says (only its id came, and it is not here). */
  from?: "me" | "peer";
  /** A group's original: its author's member key. */
  member?: string;
  /** A button press (WISP 406 · Message Buttons): the original's button this reply presses, its text the label. */
  button?: string;
  /**
   * The original here, when it was found in this chat as the reply was kept (always, for a reply sent here). Without
   * it the line is only what the replier's app said: shown, but marked as not checked.
   */
  messageId?: string;
}

/**
 * The way a message went, as the engine saw it at that moment: a live transport, the DHT floor (a paired chat's
 * `dht-text/1` envelope), the sender's storage (`hold/1`), or a chat from before pairing (`legacy-*`).
 */
export type MessagePath = PairedTransport | "dht" | "hold" | "legacy-datalink" | "legacy-dht";

/** One send of a message: when, over what, and how it ended. */
export interface MessageSend {
  at: number;
  path: MessagePath;
  /** The live session crossed a relay (WISP 100, "Relayed"); the relays' hosts. */
  relayed?: boolean;
  relays?: string[];
  /** The round trip measured on the session at the time. */
  rttMs?: number;
  /** Absent while the send is under way. */
  result?: "sent" | "failed";
  error?: string;
}

/**
 * What the engine remembers about one message's travels, for its details view (WISP 400 § Message details): facts
 * as they were when the message went or came, that nothing else keeps. Kept on the message row, bounded by
 * `MESSAGE_DETAILS_MAX_BYTES`. Never a key, a seed or anything else that opens the chat.
 */
export interface MessageDetails {
  /** Sends of this message, oldest first: the first and the last ones (`MESSAGE_DETAILS_MAX_SENDS`). */
  sends?: MessageSend[];
  /** Sends there were in all, when more than `sends` keeps. */
  attempts?: number;
  /** A received message: when it came and over what. */
  received?: Omit<MessageSend, "result" | "error">;
  /** The last successful send was handed to the transport. */
  sentAt?: number;
  /** The contact's receipt came (the message is `delivered`). */
  receiptAt?: number;
  /** Stored for an away contact, sealed for them. */
  heldAt?: number;
  /** A file: its last byte arrived here, or the contact confirmed it. */
  completedAt?: number;
  /** The frame the message travelled in. `wireBytes`: as sent on the channel (a JSON frame, a sealed record, a bundle). */
  wire?: { frame: string; protocol: string; plaintextBytes?: number; wireBytes?: number; chunks?: number; chunkBytes?: number };
  /** The DHT floor: the envelope's sequence and times, the sealed packet's size and nonce, the record read. */
  dht?: { seq?: number; issued?: number; expires?: number; packetBytes?: number; nonce?: string; recordKey?: string; records?: string[] };
  /** Store-and-forward: the item's sequence in the mailbox, its sealed size and expiry. */
  hold?: { seq?: number; bytes?: number; expires?: number; mailbox?: string };
}

/** A details record larger than this (as JSON) is trimmed: its oldest sends go first. */
export const MESSAGE_DETAILS_MAX_BYTES = 2048;
/** Sends kept on a record: the first, and the last ones. */
export const MESSAGE_DETAILS_MAX_SENDS = 6;

/** What the details view is made of: the row, its record, and what the engine knows around it right now. */
export interface MessageDetailsView {
  message: Pick<StoredMessage, "id" | "wireId" | "linkId" | "sender" | "timestamp" | "sentAt" | "via" | "delivery" | "deliveryError" | "resendUntil" | "member" | "nick"> & {
    kind: "text" | "file" | "voice" | "payment" | "event" | "note";
    /** UTF-8 bytes of the text. */
    textBytes: number;
  };
  details?: MessageDetails;
  /** The chat the message is in. Keys are the public participation keys (z-base-32), never a seed. */
  link?: {
    id: string;
    profile?: "paired-chat/1";
    deliveryMode?: DeliveryMode;
    /** Our own participation key on this link. */
    myKey: string;
    /** The contact's, as pinned; absent before the first contact. */
    peerKey?: string;
    /** The pinned key was compared by the two people (WISP 401 § verification). */
    verified: boolean;
    /** The session carrying the chat right now, if any. */
    transportNow?: PairedTransport;
    relayedNow?: boolean;
    rttNowMs?: number;
  };
  /** The file the message carries (files/2, files/3 or a held item), as stored. */
  file?: {
    id: string; name: string; size: number; mime: string;
    /** SHA-256 of the bytes, hex, once known (the sender's own, or checked on arrival). */
    digest?: string;
    protocol?: "files/2" | "files/3" | "hold/1";
    state?: string;
    stage?: string;
    transferred?: number;
    /** Why a transfer that ended without the file did. */
    error?: string;
    /** files/3: bytes confirmed durably, where a restart resumes. */
    confirmed?: number;
    /** files/3: when the offer was made. */
    since?: number;
    consented?: boolean;
    /** Where the bytes are kept on this device. */
    storage?: string;
    voice?: { duration: number; peaks: number };
  };
  /** The payment or request the message stands for: everything but the money itself. */
  payment?: {
    id: string; kind: "payment" | "request"; direction: "in" | "out"; amount: number; unit: string; state: PaymentState;
    method?: string; network?: string; provider?: string; asset?: string; mint?: string; txid?: string; ask?: string;
    createdAt: number; error?: string; memo?: string; group?: string;
    /** SHA-256 of the invoice, hex, when there is one (the invoice itself carries the amount and a payment hash). */
    invoiceDigest?: string;
    lightningPending?: boolean; paidHere?: boolean;
  };
  /** A group message: which group, and the member key of the sender when it is not this device. */
  group?: { id: string; member?: string; profile?: string };
}

/** The ways of paying a group note can name. */
export type GroupPayRail = "cashu" | "lightning" | "arkade" | "bark" | "bitcoin" | "spark" | "usdt" | "fedimint";

/**
 * A payment between two members as the whole group sees it (WISP 902 § Payments): who pays whom, how much, over
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

/** `group-pay` on an edge (WISP 902 § Payments). Old apps drop it. */
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
  /** The Pkarr relays. Browsers read and write through them; the Desktop writes to them (so browser contacts see its packets). */
  relays: string[];
  /**
   * Where the DHT is reached directly (the Desktop): whether reads may use the relays too, "Also use Pkarr relays"
   * in Settings, Network. Absent means no: reads go to the DHT alone.
   */
  readRelays?: boolean;
  /** Extra ICE servers (typically TURN) on top of the built-in STUN set. */
  iceServers: IceServerSetting[];
  /**
   * The Iroh relays a browser build homes on (WISP 102, relay only): a page cannot send UDP, so every Iroh
   * packet goes through one. Absent or empty means the defaults (n0's public relays, as the desktop app's).
   */
  irohRelays?: string[];
  /**
   * The HyperDHT relay (wss://) this browser reaches the HyperDHT through, so paired chats can use HyperDHT
   * (WISP 103) beside WebRTC. Empty: none. Absent means the default (shared/hyperdhtRelay.ts). The Desktop
   * runs HyperDHT itself and ignores it.
   */
  hyperdhtRelay?: string;
  /** Cashu mints this peer holds ecash at and accepts ecash from. The first is where invoices are created. */
  mints: string[];
  /** False until the default mints were put in place once; after that the list is the user's. */
  mintsInitialized: boolean;
  /** The Nostr social layer: relays, automatic profile loading, publication. Absent means the defaults, everything off. */
  nostr?: NostrSocialSettings;
  /**
   * Identity cards show the public profile (picture, name, bio, counts) of a verified identity, read from its
   * network's public host when the card is on screen (PUBLIC-PROFILES.md). Absent means on; off drops what was kept.
   */
  publicProfiles?: boolean;
  /**
   * Whether paired contacts are told when this profile is typing (WISP 401 § Typing). Absent means yes; off,
   * nothing is said, and a contact's typing is still shown.
   */
  sendTyping?: boolean;
  /**
   * Where items are held for away contacts (WISP 404): the profile's S3 storage and its random space
   * (WISP 1000/1002), as set up under Profile → Backups. Kept here for the peer, which may run outside the
   * page; never copied into a backup.
   */
  holdStorage?: { s3: S3Config; space: string } | null;
  /** The first-run wallet setup (see `WalletSetupRecord`). Only the engine writes it: a settings patch cannot. */
  walletSetup?: WalletSetupRecord;
  /**
   * This profile's push subscription (the installed web app, WISP 401 § Wake-up push): shared with each paired
   * contact whose app offers `wake/1`, so it can wake this app while it is closed. Absent: not woken.
   */
  wake?: WakeSubscription;
  /**
   * A contact who held `wake` can no longer be told to forget it (its chat was deleted, or muted: a contact may ignore
   * `w: null`). The app replaces the subscription (a new endpoint and VAPID key pair, new tokens for the others) and
   * `setWakeSubscription` clears this. Set by the engine only.
   */
  wakeRotate?: boolean;
  /**
   * Private groups muted here (WISP 902 · Group Mesh § Wake-up push): their members are told to forget this profile's
   * subscription, as a muted chat's contact is. Only through `setWakeMuted` with the group's `group:<id>`.
   */
  wakeMutedGroups?: string[];
  /**
   * Private groups → members that were given a token on an edge a group on hubs later dropped: they still hold the
   * subscription with no edge to close, so their leaving the group (or this profile leaving it, or muting it) replaces
   * it. Cleared with every new subscription. Set by the engine only.
   */
  wakeHeldBy?: Record<string, string[]>;
  /**
   * In a profile on several devices (WISP 06 § Push and the phone): devices asked for a new subscription over their
   * device link, by signing key, with the endpoint they are to replace. A device that shares another endpoint (or none)
   * has done it. Set by the engine only.
   */
  wakeRenew?: Record<string, string>;
  /**
   * A push relay (https) this app hands a finished wake-up to when it may not post to the contact's push service
   * itself (a browser page: the services answer without CORS). Empty or absent: none; nobody runs one by default.
   */
  pushRelay?: string;
  /** The backup reminder of each Mainnet wallet (see `shared/backupReminder`). Only the engine writes it: a settings patch cannot. */
  backupReminders?: BackupReminders;
}

/** A browser push subscription and the VAPID key pair it was made with. */
export interface WakeSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  vapid: VapidKeys;
  /**
   * In a profile on several devices (WISP 06 § Push and the phone): the signing key of the device whose subscription
   * this is. It moves with the profile, so a device with none of its own (a desktop) goes on giving contacts the
   * phone's. Set by the engine only; absent in a profile on one device, and for a subscription made before.
   */
  device?: string;
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
  /** The identity as a URI the profile's public DID can list (`alsoKnownAs`); absent when it has none. */
  publicUri?: string;
  /** What the provider checked (public: contacts receive it too). Removal uses it to take down a published proof. */
  evidence?: unknown;
  /** The identity's public profile on its network, once asked for (PUBLIC-PROFILES.md); absent while not asked or turned off. */
  publicProfile?: PublicProfileView;
}

/**
 * An identity's public profile, as its network publishes it (docs/wisps/PUBLIC-PROFILES.md): self-described by the
 * account, never part of the proof. Only for an identity with a current verified proof, with Settings → Load public
 * profiles on; kept on this device and asked again after a day.
 */
export interface PublicProfileView {
  /** False when the network has no profile for this identity (or none was read yet). */
  found: boolean;
  name?: string;
  /** How the network writes the account: "@alice.bsky.social", a Nostr `name`. */
  handle?: string;
  /** A short bio, plain text. */
  about?: string;
  /** The website the account names: an https address, shown as a plain link. */
  website?: string;
  /** A sanitized `data:image/jpeg;base64,…` URL, never a remote one. */
  avatar?: string;
  /** The profile names a picture that is not shown: which rule refused it, in words ("it is a GIF; …"). */
  avatarMiss?: string;
  followers?: number;
  following?: number;
  /** The hosts it was read from, which saw this device's IP address: "nexus.pubky.app". */
  hosts: string[];
  /** Seconds; 0 when it was never read. */
  fetchedAt: number;
  loading?: boolean;
  /** The last attempt failed (a copy read before, if any, is still shown). */
  error?: string;
}

/**
 * A verified identity's recent posts (docs/wisps/PUBLIC-PROFILES.md, "Posts and follows"): `loadPublicPosts`, asked
 * when its card is chosen in a contact's identities panel. Plain text, bounded, never markup.
 */
export interface PublicPostView {
  id: string;
  /** Seconds. */
  createdAt: number;
  text: string;
  /** Opens the post in its network's app or site. */
  url?: string;
  reply?: boolean;
  /** Its pictures, loaded only on a tap (`loadPublicPostImage` with the index here). `host`: who is asked. */
  images: { host?: string; alt?: string }[];
}

export interface PublicPostsView {
  posts: PublicPostView[];
  /** More can be asked for (`more: true`). */
  more: boolean;
  /** The hosts asked, which saw this device's IP address. */
  hosts: string[];
  /** Seconds. */
  fetchedAt: number;
  /** Notes the person's own Nostr mute list hides. */
  hidden?: number;
  /** The identity's profile in its network's app or site. */
  profileUrl?: string;
}

/**
 * Who a verified identity follows and who follows it, only as far as it touches people the reader knows: the reader's
 * own identities and the identities contacts shared. Computed on this device from lists read from the same hosts as
 * the profile; the lists themselves are never shown or stored.
 */
export interface PublicGraphView {
  /** False when there was nobody to compare with (no identity of the reader's, no contact, on this network): nothing was read. */
  compared: boolean;
  /** Its follow list names one of the reader's identities. */
  followsYou: boolean;
  /** One of the reader's identities follows it (their followers list, or the reader's own follow list). */
  youFollow: boolean;
  /** Contacts whose shared identity it follows (`follows`) or who follow it (`followedBy`). */
  contacts: { linkId: string; follows: boolean; followedBy: boolean }[];
  /** A list was longer than this app reads: someone may be missing, never added. */
  partial?: boolean;
  hosts: string[];
  /** Seconds; 0 when nothing was read. */
  fetchedAt: number;
}

/** A post's picture, on the reader's tap: a re-encoded `data:image/jpeg` URL, or why there is none. */
export interface PublicPostImageView { src?: string; miss?: string; hosts: string[]; width?: number; height?: number }

/** The profile's did:dht (WISP 310-did-dht): its own key, public to everyone, never tied to a chat. */
export interface ProfileDidView {
  /** `did:dht:…` */
  id: string;
  /** Identity proof ids the person listed as public, in order (some may not be publishable right now). */
  listed: string[];
  /** What the document says the subject is also known as: the listed identities that are verified and current. */
  alsoKnownAs: string[];
  /** The last packet put on Pkarr: when, and its version (the BEP44 sequence number). */
  published?: { at: number; versionId: string };
  /** The document out there is the current one. */
  upToDate: boolean;
  /** Why the last publish failed. */
  error?: string;
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
  /** Its public profile, while the proof is verified and current (PUBLIC-PROFILES.md). */
  publicProfile?: PublicProfileView;
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
  /**
   * `methods`: ways of paying both sides allow in this chat right now. `calls` / `services`: both sides offer
   * `calls/1` / `services/1` on the open session (paired chats only; they need a live connection).
   */
  capabilities?: {
    files: boolean; payments: boolean; methods?: Record<PaymentMethodName, boolean>; calls?: boolean; services?: boolean; largeFiles?: boolean;
    /**
     * The networks the contact has a wallet on, per way of paying, as it said on the open session. Absent: it said
     * none (an older app): any network may meet. A way of paying it has no wallet of is not in the map (one it has
     * but turned off here lists no network). A card is offered only where its network is in its list.
     */
    networks?: Partial<Record<PaymentMethodName, readonly WalletNetwork[]>>;
  };
  /** files/3 live in this chat: bytes the contact's device said it can still take for files, when it said. */
  peerFileRoom?: number | null;
  /** Ways of paying this device allows in this chat. */
  paymentMethods?: Record<PaymentMethodName, boolean>;
  /** For each way of paying, the networks this chat accepts it on. */
  paymentNetworks?: Partial<Record<PaymentMethodName, readonly WalletNetwork[]>>;
  /** Both sides announced private groups on the open session: this contact can be invited. */
  groups?: boolean;
  /** Paired chats: what each side offers after the handshake (`paired-capabilities`); `peer` is null until it says. */
  sessionOffers?: { mine: string[]; peer: string[] | null };
  /** Paired chats: why a call cannot be placed right now, or null when it can. */
  callsUnavailable?: string | null;
  /** Paired 1:1 chats: the contact is typing now (`typing/1` on the live session). Absent otherwise. Never stored. */
  peerTyping?: boolean;
  /** Paired 1:1 chats: this side's wake-up token for this chat (the push worker's table), when it shared its subscription. */
  wakeToken?: string;
  /** Paired 1:1 chats: the contact was told not to wake this side while the chat is muted (`setWakeMuted`). */
  wakeMuted?: boolean;
  /** Paired 1:1 chats: the contact shared how to wake its closed app, so a message sent while it is away wakes it. */
  peerWakes?: boolean;
  /** While `peerTyping`: what the contact is doing when it is not plain typing (recording a voice note, thinking). */
  peerTypingKind?: Exclude<TypingKind, "typing">;
  /** While `peerTyping`: the contact's (a bot's) status line, sanitized: one line, at most 40 characters, no links. */
  peerTypingStatus?: string;
  availableTransports?: PairedTransport[];
  /**
   * Every transport this app runs for the chat, started or not: DHT only releases the native ones, and an app with no
   * WebRTC (the Linux Desktop) then has none started, yet can still leave DHT only for any of these.
   */
  runnableTransports?: PairedTransport[];
  /** Transports a session with this contact would cross a relay on (a browser's HyperDHT or Iroh): a fallback, and shown as relayed. */
  relayedTransports?: PairedTransport[];
  deliveryMode?: DeliveryMode;
  dhtDelivery?: DhtDeliveryView;
  canSendText?: boolean;
  /** `hold`: the contact is away and what is sent now waits in this device's storage for it. */
  textDelivery?: "stream" | "dht" | "hold" | "unavailable";
  hold?: LinkHoldView;
  transportErrors?: Partial<Record<PairedTransport, string>>;
  preferredTransport?: PairedTransport;
  transportFallback?: boolean;
  /** No transport chosen for this chat: the app's rule applies. */
  transportAutomatic?: boolean;
  /** What the contact's app can use on this link, as it last said (a session, or its capability record); unknown before either. */
  peerTransports?: PairedTransport[];
  /**
   * The transport this chat is set to reach and is not on yet, and why (WISP 100, "A chosen transport not reached
   * yet"): waited for, never a failure. Absent when the chat is on it, or nothing limits where it goes.
   */
  transportWait?: TransportWait;
  /**
   * The last attempt to go live that did not, as this side saw it (WISP 100, "Why a chat is not live"): what it tried
   * and why each did not connect, whether this side dialled or answered, and when it dials again. Absent while live.
   */
  liveAttempt?: LiveAttempt;
  /** Which side dials this chat to go live (the other answers): paired chats. */
  liveDialer?: "you" | "contact";
  /** Round trip on the live session, once measured. */
  transportRttMs?: number;
  /**
   * The live session goes through relays, never directly (WISP 100, "Relayed"): a browser's Iroh. The relays'
   * hosts, this app's first. They see who talks to whom and when, not what is said.
   */
  transportRelayed?: { relays: string[] };
  /** While live: since when the current transport carries the chat, and why it was chosen (see engine/transportLog.ts). */
  transportLive?: { since: number; cause?: TransportCause };
  /** The chat's connection story, newest last; only for the chat on screen (`setActiveLink`). */
  transportLog?: TransportEntry[];
  /** Every connection event of the chat on screen, for its connection panel, newest last. */
  transportHistory?: TransportEvent[];
  /** Identities shared in this chat, both ways, as its timeline shows them, newest last; only for the chat on screen. Local only. */
  identityTimeline?: IdentityTimelineEntry[];
  /** When the contact last shared an identity here (milliseconds): the chat list's preview and order. Paired chats. */
  identitySharedAt?: number;
  /** The latest reaction in this chat, for the chat list; paired chats. */
  lastReaction?: ReactionNote;
  /** The chat's pin (WISP 400 § Pinned message): `id` "" once unpinned; absent when nothing was ever pinned. */
  pin?: PinView;
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
  /**
   * Limited mode (WISP 06 § When a device checks): the device could not read which device is active and was started
   * anyway. The profile is offline whatever `settings.online` says, and no wallet is open. Absent otherwise.
   */
  limited?: true;
  /**
   * Why limited mode is on, when it is a restored copy (WISP 06 § A backup restored where a device set exists): `checking`,
   * the turn is read every 30 seconds to learn whether another device runs the profile; `removed`, the read found the
   * device set moved after a removal, and only the person can start the copy as a profile of its own.
   */
  restoreCheck?: "checking" | "removed";
  /**
   * Whose push subscription `settings.wake` is, in a profile on several devices (WISP 06 § Push and the phone): `here`,
   * this device's own; `away`, another device's, given to contacts because this device has none of its own (the page
   * neither replaces nor turns off what is not its own). Absent in a profile on one device, or when nobody said.
   */
  wakeOwner?: "here" | "away";
  transport: {
    protocol: string; relays: string[];
    /** Present where Iroh runs in the browser (web app, extension): the relays it uses and the defaults. */
    iroh?: { relays: string[]; defaults: string[] };
    /** This client reaches the Mainline DHT itself (the Desktop): relays are for writes, and reads only when chosen. */
    direct?: boolean;
    /** How reads go and how each relay is doing, for the connection panel's Details. */
    discovery?: DiscoveryStatus;
    /** False where this client has no WebRTC (Ghostly Desktop on Linux: WebKitGTK has none). Absent where it has. */
    webrtc?: false;
    /**
     * This device's own WebRTC attempts say direct connections do not get through its network (a VPN, a firewall, a
     * carrier's NAT: `DirectPathWatch` in packages/core). Chats still go live through relays. Absent otherwise.
     */
    directBlocked?: true;
    /**
     * This device's clock seems to be off: this clock minus what the relays and several contacts say, in ms (positive
     * when it is ahead). From several sources agreeing, never one contact (`ClockWatch` in packages/core). Absent otherwise.
     */
    clockOffMs?: number;
    /**
     * False where a group's links have no transport at all here: no WebRTC and no native transport (WISP 902 §
     * Transports), so no member of a group can be reached from it. Absent where they have one (the Linux Desktop runs
     * Iroh and HyperDHT).
     */
    groupLinks?: false;
  };
  links: LinkView[];
  services: ServiceView[];
  /** Transfers since the peer started, by file id. */
  transfers: Record<string, FileTransferView>;
  /**
   * The kept transfers are back in `transfers`. False for the first moments after a start: a file with no transfer
   * yet may still be moving, not finished.
   */
  transfersRestored?: boolean;
  wallet: WalletView;
  payments: Record<string, PaymentView>;
  /** This profile's identity proofs. */
  identityProofs: IdentityProofView[];
  /** This profile's public DID. Absent until the engine has loaded it. */
  did?: ProfileDidView;
  /** The Nostr social layer: the person's own keys' data and the effective settings. */
  nostr: NostrSocialState;
  /** Private groups and pending invitations (WISP 900). */
  groups: GroupView[];
  /** The links of groups' edges: not chats, but payments with a member travel on them. */
  edges?: LinkView[];
}
