import type { PaymentMethodName } from "@ghostly/core";
import type { UsdtWalletView, UsdtCreate } from "@ghostly/browser/engine/paymentAdapters/usdtWallet";
import type { PaymentReview, PaymentTarget } from "@ghostly/core";
import type { ArkCreate, ArkWalletView } from "@ghostly/browser/engine/paymentAdapters/arkWallet";
import type { ArkConfig } from "@ghostly/browser/engine/paymentAdapters/arkade";
import type { BarkCreate, BarkWalletView } from "@ghostly/browser/engine/paymentAdapters/barkWallet";
import type { BarkConfig } from "@ghostly/browser/engine/paymentAdapters/bark";
import type { FedimintFederationView, FedimintWalletView } from "@ghostly/browser/engine/paymentAdapters/fedimintWallet";
import type { FederationInfo } from "@ghostly/browser/engine/paymentAdapters/fedimintSdk";
import type { SparkCreate, SparkWalletView } from "@ghostly/browser/engine/paymentAdapters/sparkWallet";
import type { SparkNetwork } from "@ghostly/core";
import type { LightningView } from "@ghostly/browser/engine/paymentAdapters/providers/lightningService";
import type { BitcoinView } from "@ghostly/browser/engine/paymentAdapters/providers/bitcoinService";
import type { DataLinkState, ServiceAd, PairingState } from "@ghostly/core";
import type { ChatFile } from "./types";

/**
 * What a platform has to provide for ephemeral services. Ghostly Browser
 * swaps this module for one backed by its peer; on Desktop it is not
 * implemented yet, and the UI that depends on it stays hidden.
 */
export interface SharedService {
  id: string;
  name: string;
  /** Loopback address, e.g. `http://localhost:3400` */
  target: string;
  enabled: boolean;
  requests: number;
  /** Contacts granted access, by participation key. Absent or empty means nobody. */
  sharedWith?: string[];
}

export interface PeerLinkState {
  id?: string;
  deliveryMode?: "stream" | "dht";
  /** `hold`: the contact is away and what is sent now waits in this device's storage for it (WISP 4xx). */
  textDelivery?: "stream" | "dht" | "hold" | "unavailable";
  canSendText?: boolean;
  /** Store-and-forward in this chat: the switch, what the contact said, storage and what is waiting. */
  hold?: PeerHoldState;
  dhtDelivery?: { mode: "stream" | "dht"; peerMode?: "stream" | "dht"; authenticated: boolean; error?: string; pendingUntil?: number; maxTextBytes: number };
  pairing?: PairingState;
  /**
   * `methods`: ways of paying both sides allow in this chat right now. `calls` / `services`: both sides offer
   * `calls/1` / `services/1` on the open session (paired chats; they need a live connection).
   */
  capabilities?: { files: boolean; payments: boolean; methods?: Record<PaymentMethodName, boolean>; calls?: boolean; services?: boolean };
  /** Paired chats: what each side offers after the handshake; `peer` is null until it says. */
  sessionOffers?: { mine: string[]; peer: string[] | null };
  /** Paired chats: why a call cannot be placed right now, or null when it can. */
  callsUnavailable?: string | null;
  /** Ways of paying this device allows in this chat. */
  paymentMethods?: Record<PaymentMethodName, boolean>;
  dataLink: DataLinkState;
  online: boolean;
  /** `null` while the peer advertises nothing (offline, or an older client). */
  services: ServiceAd[] | null;
}

/** What a chat shows of store-and-forward (WISP 4xx). */
export interface PeerHoldState {
  enabled: boolean;
  peerAllows?: boolean;
  storage: boolean;
  canHold: boolean;
  outstanding: number;
  bytes: number;
  maxBytes: number;
  maxItems: number;
  ttlMs: number;
  refused: number;
  error?: string;
}

export interface NetworkSettings {
  /** How this client reaches Pkarr, for display. */
  protocol: string;
  relays: string[];
  defaultRelays: string[];
  /** Optional TURN server, used only when no direct path exists. */
  turn: { urls: string; username?: string; credential?: string } | null;
  /** Where Iroh runs in the page (web app, extension): its relays (empty: the defaults) and the defaults. */
  iroh?: { relays: string[]; defaultRelays: string[] };
}

export interface FileTransferState {
  state: "transferring" | "done" | "failed";
  transferred: number;
  size: number;
  error?: string;
  /**
   * While `transferring`, where it stands when it is not moving: `preparing` (a large file being copied
   * before it is offered), `waiting` (no live connection; it goes on by itself), `asking` (the receiver's
   * person has not decided; when receiving, this person), `queued`, `paused`, `verifying` (checking the digest).
   */
  stage?: "preparing" | "waiting" | "asking" | "queued" | "paused" | "verifying";
  /** Present for files that can be paused, resumed and cancelled (files/3). */
  direction?: "in" | "out";
  pausedBy?: "me" | "peer";
  /** Bytes per second lately. */
  rate?: number;
  /** Receiving, `asking`: bytes this device can still take for files, when it says. */
  room?: number | null;
  /** Failed, and it can be sent again. */
  retry?: boolean;
}

export interface MintInfo {
  version?: string;
  motd?: string;
  /** Fee for spending ecash, in sats per thousand proofs; 0 means free. */
  inputFeePpk: number;
  /** Lightning in / out: allowed amounts in sats. */
  receive: { min: number | null; max: number | null } | null;
  send: { min: number | null; max: number | null } | null;
}

export interface WalletTransaction {
  id: string;
  timestamp: number;
  mint: string;
  kind: "lightning-in" | "lightning-out" | "ecash-in" | "ecash-out" | "reclaimed";
  /** Always positive; the kind gives the direction. */
  amount: number;
  /** What this movement cost, exactly. */
  fee: number;
  note?: string;
}

export interface WalletState {
  /** Which wallets are in use: real money, or test networks. Absent means mainnet. */
  mode?: "mainnet" | "testnet";
  /** On Mainnet: test sats held at test mints (a contact may have sent some), shown once in Testnet. */
  waitingTestSats?: number;
  ark?: ArkWalletView;
  bark?: BarkWalletView;
  fedimint?: FedimintWalletView;
  spark?: SparkWalletView;
  usdt?: UsdtWalletView;
  /** The Lightning source of this mode (the Cashu mints by default) and its latest operations. */
  lightning?: LightningView;
  /** The on-chain Bitcoin source of this mode, if one is set up. */
  bitcoin?: BitcoinView;
  intents?: PaymentReview[];
  mints: { url: string; name: string; balance: number; info: MintInfo | null }[];
  balance: number;
  /** Newest first. */
  history: WalletTransaction[];
  feesPaid: number;
}

export interface ChatPayment {
  mints?: string[];
  /** Cashu: the mint the ecash came from, or went out on. */
  mint?: string;
  linkId?: string;
  target?: PaymentTarget;
  txid?: string;
  id: string;
  kind: "payment" | "request";
  direction: "in" | "out";
  amount: number;
  unit: string;
  memo?: string;
  state: "pending" | "settled" | "failed" | "reclaimed";
  createdAt: number;
  error?: string;
  /** Requests: a Lightning invoice anyone can pay. */
  invoice?: string;
  /** Requests we pay: our Lightning payment is still pending at the mint. */
  lightningPending?: boolean;
  /** Fedimint requests: the federations the payee takes ecash of. */
  federations?: string[];
  /** Fedimint payments: the federation of the notes. */
  federation?: string;
}

/** A Lightning address or LNURL, resolved: what the person sees before choosing an amount (whole sats). */
export interface LightningAddressInfo {
  id: string;
  kind: "address" | "lnurl";
  text: string;
  /** The host that learned of the request. */
  domain: string;
  /** The host the invoice comes from, when it is another. */
  callbackDomain: string;
  minSat: number;
  maxSat: number;
  description: string;
  /** How long a comment may be; 0 when none is taken. */
  commentAllowed: number;
}

/** What a pasted piece of ecash says about itself, read without contacting any mint. */
export type CashuInspection =
  | { kind: "token"; amount: number; unit: string; mint: string; memo?: string; accepted: boolean }
  | { kind: "request"; amount: number | null; unit: string; mints: string[]; description?: string };

/** An ecash (Cashu) wallet with Lightning in and out through the user's mints. */
export interface WalletPlatform {
  usdtCreate(params:UsdtCreate):Promise<void>;
  usdtUnlock(password:string):Promise<void>;
  /** The recovery phrase; a wallet that opens by itself needs no password. */
  usdtReveal(password?:string):Promise<string>;
  usdtLock():Promise<void>;
  usdtRefresh():Promise<void>;
  /** Sepolia only: test USDT from a public faucet; returns the transaction hash. */
  usdtGetTestTokens():Promise<string>;
  usdtExportBackup(password:string):Promise<string>;
  usdtRestoreBackup(text:string,password:string):Promise<void>;
  arkCreate(params: ArkCreate):Promise<void>;
  arkUnlock(password:string):Promise<void>;
  arkLock():Promise<void>;
  arkBackup(password?:string):Promise<{mnemonic:string;config:ArkConfig}>;
  arkExportBackup(password:string):Promise<string>;
  arkRestoreBackup(text:string,password:string):Promise<void>;
  arkRefresh():Promise<void>;
  /** Expired Ark outputs back into the balance; returns the settlement txid. */
  arkRecover():Promise<string>;
  barkCreate(params: BarkCreate):Promise<void>;
  barkBackup():Promise<{mnemonic:string;config:BarkConfig}>;
  barkExportBackup(password:string):Promise<string>;
  barkRestoreBackup(text:string,password:string):Promise<void>;
  barkRefresh():Promise<void>;
  /** On-chain coins of the Bark wallet into Ark; returns the board txid. */
  barkBoard():Promise<string>;
  /** What an invite code leads to, before joining: the federation's name, guardians, version, network, modules. */
  fedimintPreview(invite: string): Promise<FederationInfo>;
  fedimintJoin(invite: string, recover?: boolean): Promise<FedimintFederationView>;
  fedimintLeave(federation: string): Promise<void>;
  fedimintRefresh(): Promise<void>;
  /** Out-of-band notes, to hand over; they come back by themselves if nobody redeems them in a week. */
  fedimintSpendNotes(federation: string, amount: number): Promise<{ notes: string; operation: string }>;
  fedimintReceiveNotes(notes: string): Promise<{ federation: string; amount: number }>;
  fedimintInvoice(federation: string, amount: number, memo?: string): Promise<{ invoice: string }>;
  fedimintTakeBack(federation: string, operation: string): Promise<"canceled" | "taken" | "pending">;
  fedimintBackup(): Promise<{ mnemonic: string; federations: { id: string; name?: string; invite: string }[] }>;
  fedimintExportBackup(password: string): Promise<string>;
  fedimintRestoreBackup(text: string, password: string): Promise<{ joined: number; failed: string[] }>;
  fedimintRestorePhrase(mnemonic: string, invites: string[]): Promise<{ joined: number; failed: string[] }>;
  sparkCreate(params: SparkCreate):Promise<void>;
  sparkBackup():Promise<{mnemonic:string;network:SparkNetwork}>;
  sparkExportBackup(password:string):Promise<string>;
  sparkRestoreBackup(text:string,password:string,apiKey?:string):Promise<void>;
  sparkRefresh():Promise<void>;
  /** The Spark wallet becomes the Breez Lightning source too (one seed). */
  sparkUseForLightning():Promise<void>;
  preparePayment(params:{target:PaymentTarget;amount:number;feeCap:number;payee:string;linkId?:string;requestId?:string;memo?:string}):Promise<PaymentReview>;
  approvePayment(id:string):Promise<PaymentReview>;
  reconcilePayment(id:string):Promise<PaymentReview>;
  cancelPayment(id:string):Promise<PaymentReview>;

  /** A public mint with worthless test sats, for trying things out. */
  testMintUrl: string;
  /** Every mint whose sats are worthless; their balance is never shown as money. */
  testMintUrls: readonly string[];
  getState(): WalletState | null;
  addMint(url: string): Promise<void>;
  removeMint(url: string): Promise<void>;
  /** The primary mint (first in the list) is where Lightning invoices are created. */
  setPrimaryMint(url: string): Promise<void>;
  /** Real money or test networks, for every wallet at once. */
  setMode(mode: "mainnet" | "testnet"): Promise<void>;
  /** An invoice from the active Lightning source; `via: "cashu"` asks the Cashu mints whatever the source. */
  receiveLightning(amount: number, via?: "cashu"): Promise<{ invoice: string; expiresAt: number | null; paymentHash?: string; source?: string }>;
  quoteInvoice(invoice: string, via?: "cashu"): Promise<{ quote: string; mint: string; amount: number; feeReserve: number; source?: string }>;
  /** True when paid, false while the payment is pending (or its answer lost). Throws when the sats did not leave. `note`: what it was for, kept with the wallet's record. */
  payQuote(quote: string, mint: string, note?: string): Promise<boolean>;
  /**
   * Reads a Lightning address (`name@domain`) or an LNURL and fetches what it asks for. The address's
   * domain learns of the request: say so before calling.
   */
  resolveLightningAddress(text: string): Promise<LightningAddressInfo>;
  /** The invoice for `amount` sats from a resolved address, checked (its amount, and that it commits to what was shown). */
  lightningAddressInvoice(id: string, amount: number, comment?: string): Promise<{ invoice: string; successAction?: { tag: "message" | "url"; message?: string; description?: string; url?: string }; note: string }>;
  /** "I paid it from another wallet": the contact's app looks at its wallet now. Only that wallet marks the request paid. */
  checkPayment(peerPubKeyZ32: string, paymentId: string): Promise<void>;
  /** Makes a provider this mode's Lightning source, with the values typed in its form. */
  lightningSetSource(providerId: string, values: Record<string, string>): Promise<void>;
  /** Back to the Cashu mints. */
  lightningClearSource(): Promise<void>;
  /** Tries the Lightning source again now. */
  lightningRetrySource(): Promise<void>;
  /** Changes the server of the saved Lightning source, keeping its secrets. */
  lightningReconfigureSource(values: Record<string, string>): Promise<void>;
  bitcoinSetSource(providerId: string, values: Record<string, string>): Promise<void>;
  bitcoinClearSource(): Promise<void>;
  /** Tries the Bitcoin source again now. */
  bitcoinRetrySource(): Promise<void>;
  /** Changes the server of the saved Bitcoin source (a BDK wallet's Esplora), keeping the wallet. */
  bitcoinReconfigureSource(values: Record<string, string>): Promise<void>;
  /** A fresh address of the Bitcoin source to be paid on. */
  bitcoinReceiveAddress(): Promise<string>;
  bitcoinRefresh(): Promise<void>;
  receiveToken(token: string): Promise<number>;
  /** Null when the text is neither an ecash token nor a Cashu payment request. */
  inspectCashu(text: string): Promise<CashuInspection | null>;
  exportTokens(): Promise<{ mint: string; token: string; amount: number }[]>;
  send(peerPubKeyZ32: string, amount: number, memo?: string): Promise<{ timestamp: number; paymentId: string }>;
  request(peerPubKeyZ32: string, amount: number, memo?: string, method?: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin" | "fedimint" | "spark"): Promise<{ timestamp: number; paymentId: string }>;
  /** Paying on Ark, Bark, Spark or USDT without a request: asks the contact's app for one. */
  askToPay(peerPubKeyZ32: string, amount: number, method: "arkade" | "usdt" | "bark" | "bitcoin" | "fedimint" | "spark", memo?: string): Promise<{ askId: string }>;
  /** The contact's request answering an ask, once it arrived. */
  answerTo(askId: string): ChatPayment | null;
  /** Pays a contact's request. `via: "lightning"`: its invoice through the Lightning source, as reviewed, within `maxFee`. */
  payRequest(peerPubKeyZ32: string, paymentId: string, options?: { via?: "lightning"; maxFee?: number }): Promise<void>;
  reclaim(paymentId: string): Promise<void>;
  getPayment(paymentId: string): ChatPayment | null;
}

export interface ServicesPlatform {
  /** Something the user should know about this client, shown in the sidebar. */
  notice?: string;
  features: {
    /** Whether this client can reach web apps on the user's machine to share them. */
    shareLocalServices: boolean;
    /** Whether this client can display a contact's web app. */
    openServices: boolean;
    /** Whether this client can switch between local profiles (WISP 04). */
    profiles?: boolean;
  };
  subscribe(listener: () => void): () => void;
  /** Whether this peer is reachable at all right now. */
  isOnline(): boolean;
  setOnline(online: boolean): Promise<void>;
  getSharedServices(): SharedService[];
  /** Throws with a readable message when the target is not acceptable or access was denied. */
  shareService(name: string, target: string): Promise<void>;
  removeService(id: string): Promise<void>;
  setServiceEnabled(id: string, enabled: boolean): Promise<void>;
  /** Grants or withdraws one contact's access to one service. Nobody is granted by default. */
  setServiceShared(id: string, peerPubKeyZ32: string, shared: boolean): Promise<void>;
  getPeer(peerPubKeyZ32: string): PeerLinkState | null;
  /** Which ways of paying the chat with this peer allows. */
  setChatPaymentMethods(peerPubKeyZ32: string, methods: Partial<Record<PaymentMethodName, boolean>>): Promise<void>;
  /** Store-and-forward in the chat with this peer: accept held items from them, and hold items for them while they are away. */
  setChatHold(peerPubKeyZ32: string, enabled: boolean): Promise<void>;
  /** Where held items live: this profile's S3 storage and space (Profile → Backups); null turns holding off. */
  setHoldStorage(storage: { s3: import("@ghostly/browser/backup/s3").S3Config; space: string } | null): Promise<void>;
  connect(peerPubKeyZ32: string): void;
  openService(peerPubKeyZ32: string, serviceId: string): Promise<void>;
  /**
   * Opens a `lightning:` or `bitcoin:` link in a wallet on this device, where the platform has to do it
   * itself (the desktop app, the extension). Null where a plain link does it: the caller leaves the link alone.
   */
  openPaymentLink(uri: string): Promise<void> | null;
  /**
   * The system's share sheet for a link, where the platform has to show it itself (the desktop app).
   * Null where it does not: the page uses the Web Share API, or copies. Resolves to false when no sheet was shown.
   */
  shareText(text: string, anchor?: { x: number; y: number; width: number; height: number }): Promise<boolean> | null;
  /**
   * The clipboard's text read by the platform itself (the desktop app), for a paste button the user
   * just clicked. Null where the page reads it with `navigator.clipboard` instead. Use
   * `readClipboardText` in `clipboard.ts`, which picks the way and checks the click.
   */
  readClipboardText(): Promise<string> | null;
  /** Largest file that can be sent, in bytes. */
  maxFileBytes: number;
  /**
   * Starts sending and returns what to show in the chat. Progress comes through `getTransfer`.
   * `voice` makes it a voice message: the file then plays in the chat instead of being saved.
   */
  sendFile(peerPubKeyZ32: string, file: File, options?: { voice?: ChatFile["voice"] }): Promise<{ timestamp: number; file: ChatFile }>;
  /** Null when nothing is known about the transfer, e.g. after a restart. */
  retryFile?(fileId: string): Promise<void>;
  getTransfer(fileId: string): FileTransferState | null;
  /** files/3: answers an offer, or pauses, resumes or cancels a transfer. */
  fileAction?(fileId: string, action: "accept" | "decline" | "pause" | "resume" | "cancel"): Promise<void>;
  /** Why a file of this size cannot go to this contact now, or null when it can (checked before sending). */
  fileTooLarge?(peerPubKeyZ32: string, size: number): string | null;
  /** The file to show or save, backed by storage. Null when it is gone, or too large to hand out here (see `saveFile`). */
  getFile(fileId: string): Promise<Blob | null>;
  /**
   * Saves a copy through the system's save dialog, where the platform keeps files as real files (the desktop
   * app): true when saved, false when the person cancelled, null where the platform has no such dialog.
   */
  saveFile?(fileId: string): Promise<boolean | null>;
  /** Forgets a message this device deleted: the peer's copy of it and the bytes of any file it carried. */
  deleteMessage(peerPubKeyZ32: string, messageId: string): Promise<void>;
  wallet: WalletPlatform;
  getNetwork(): NetworkSettings | null;
  setNetwork(settings: Pick<NetworkSettings, "relays" | "turn"> & { irohRelays?: string[] }): Promise<void>;
}

export const servicesPlatform: ServicesPlatform | null = null;
