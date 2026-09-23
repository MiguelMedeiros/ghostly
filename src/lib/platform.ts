import type { PaymentMethodName } from "@ghostly/core";
import type { UsdtWalletView, UsdtCreate } from "@ghostly/browser/engine/paymentAdapters/usdtWallet";
import type { PaymentReview, PaymentTarget } from "@ghostly/core";
import type { ArkCreate, ArkWalletView } from "@ghostly/browser/engine/paymentAdapters/arkWallet";
import type { ArkConfig } from "@ghostly/browser/engine/paymentAdapters/arkade";
import type { BarkCreate, BarkWalletView } from "@ghostly/browser/engine/paymentAdapters/barkWallet";
import type { BarkConfig } from "@ghostly/browser/engine/paymentAdapters/bark";
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
  textDelivery?: "stream" | "dht" | "unavailable";
  canSendText?: boolean;
  dhtDelivery?: { mode: "stream" | "dht"; peerMode?: "stream" | "dht"; authenticated: boolean; error?: string; pendingUntil?: number; maxTextBytes: number };
  pairing?: PairingState;
  /** `methods`: ways of paying both sides allow in this chat right now. */
  capabilities?: { files: boolean; payments: boolean; methods?: Record<PaymentMethodName, boolean> };
  /** Ways of paying this device allows in this chat. */
  paymentMethods?: Record<PaymentMethodName, boolean>;
  dataLink: DataLinkState;
  online: boolean;
  /** `null` while the peer advertises nothing (offline, or an older client). */
  services: ServiceAd[] | null;
}

export interface NetworkSettings {
  /** How this client reaches Pkarr, for display. */
  protocol: string;
  relays: string[];
  defaultRelays: string[];
  /** Optional TURN server, used only when no direct path exists. */
  turn: { urls: string; username?: string; credential?: string } | null;
}

export interface FileTransferState {
  state: "transferring" | "done" | "failed";
  transferred: number;
  size: number;
  error?: string;
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
  /** True when paid, false while the payment is pending (or its answer lost). Throws when the sats did not leave. */
  payQuote(quote: string, mint: string): Promise<boolean>;
  /** Makes a provider this mode's Lightning source, with the values typed in its form. */
  lightningSetSource(providerId: string, values: Record<string, string>): Promise<void>;
  /** Back to the Cashu mints. */
  lightningClearSource(): Promise<void>;
  bitcoinSetSource(providerId: string, values: Record<string, string>): Promise<void>;
  bitcoinClearSource(): Promise<void>;
  /** A fresh address of the Bitcoin source to be paid on. */
  bitcoinReceiveAddress(): Promise<string>;
  bitcoinRefresh(): Promise<void>;
  receiveToken(token: string): Promise<number>;
  /** Null when the text is neither an ecash token nor a Cashu payment request. */
  inspectCashu(text: string): Promise<CashuInspection | null>;
  exportTokens(): Promise<{ mint: string; token: string; amount: number }[]>;
  send(peerPubKeyZ32: string, amount: number, memo?: string): Promise<{ timestamp: number; paymentId: string }>;
  request(peerPubKeyZ32: string, amount: number, memo?: string, method?: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin"): Promise<{ timestamp: number; paymentId: string }>;
  /** Paying on Ark, Bark or USDT without a request: asks the contact's app for one. */
  askToPay(peerPubKeyZ32: string, amount: number, method: "arkade" | "usdt" | "bark" | "bitcoin", memo?: string): Promise<{ askId: string }>;
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
  connect(peerPubKeyZ32: string): void;
  openService(peerPubKeyZ32: string, serviceId: string): Promise<void>;
  /** Largest file that can be sent, in bytes. */
  maxFileBytes: number;
  /** Starts sending and returns what to show in the chat. Progress comes through `getTransfer`. */
  sendFile(peerPubKeyZ32: string, file: File): Promise<{ timestamp: number; file: ChatFile }>;
  /** Null when nothing is known about the transfer, e.g. after a restart. */
  retryFile?(fileId: string): Promise<void>;
  getTransfer(fileId: string): FileTransferState | null;
  getFile(fileId: string): Promise<Blob | null>;
  /** Forgets a message this device deleted: the peer's copy of it and the bytes of any file it carried. */
  deleteMessage(peerPubKeyZ32: string, messageId: string): Promise<void>;
  wallet: WalletPlatform;
  getNetwork(): NetworkSettings | null;
  setNetwork(settings: Pick<NetworkSettings, "relays" | "turn">): Promise<void>;
}

export const servicesPlatform: ServicesPlatform | null = null;
