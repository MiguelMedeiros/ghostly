import type { DataLinkState, ServiceAd } from "@ghostly/core";
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
}

export interface PeerLinkState {
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
  mints: { url: string; name: string; balance: number; info: MintInfo | null }[];
  balance: number;
  /** Newest first. */
  history: WalletTransaction[];
  feesPaid: number;
}

export interface ChatPayment {
  id: string;
  kind: "payment" | "request";
  direction: "in" | "out";
  amount: number;
  unit: string;
  memo?: string;
  state: "pending" | "settled" | "failed" | "reclaimed";
  error?: string;
  /** Requests: a Lightning invoice anyone can pay. */
  invoice?: string;
}

/** An ecash (Cashu) wallet with Lightning in and out through the user's mints. */
export interface WalletPlatform {
  /** A public mint with worthless test sats, for trying things out. */
  testMintUrl: string;
  getState(): WalletState | null;
  addMint(url: string): Promise<void>;
  removeMint(url: string): Promise<void>;
  /** The primary mint (first in the list) is where Lightning invoices are created. */
  setPrimaryMint(url: string): Promise<void>;
  receiveLightning(amount: number): Promise<{ invoice: string; expiresAt: number | null }>;
  quoteInvoice(invoice: string): Promise<{ quote: string; mint: string; amount: number; feeReserve: number }>;
  payQuote(quote: string, mint: string): Promise<boolean>;
  receiveToken(token: string): Promise<number>;
  exportTokens(): Promise<{ mint: string; token: string; amount: number }[]>;
  send(peerPubKeyZ32: string, amount: number, memo?: string): Promise<{ timestamp: number; paymentId: string }>;
  request(peerPubKeyZ32: string, amount: number, memo?: string): Promise<{ timestamp: number; paymentId: string }>;
  payRequest(peerPubKeyZ32: string, paymentId: string): Promise<void>;
  reclaim(paymentId: string): Promise<void>;
  getPayment(paymentId: string): ChatPayment | null;
}

export interface ServicesPlatform {
  subscribe(listener: () => void): () => void;
  /** Whether this peer is reachable at all right now. */
  isOnline(): boolean;
  setOnline(online: boolean): Promise<void>;
  getSharedServices(): SharedService[];
  /** Throws with a readable message when the target is not acceptable or access was denied. */
  shareService(name: string, target: string): Promise<void>;
  removeService(id: string): Promise<void>;
  setServiceEnabled(id: string, enabled: boolean): Promise<void>;
  getPeer(peerPubKeyZ32: string): PeerLinkState | null;
  connect(peerPubKeyZ32: string): void;
  openService(peerPubKeyZ32: string, serviceId: string): Promise<void>;
  /** Largest file that can be sent, in bytes. */
  maxFileBytes: number;
  /** Starts sending and returns what to show in the chat. Progress comes through `getTransfer`. */
  sendFile(peerPubKeyZ32: string, file: File): Promise<{ timestamp: number; file: ChatFile }>;
  /** Null when nothing is known about the transfer, e.g. after a restart. */
  getTransfer(fileId: string): FileTransferState | null;
  getFile(fileId: string): Promise<Blob | null>;
  wallet: WalletPlatform;
  getNetwork(): NetworkSettings | null;
  setNetwork(settings: Pick<NetworkSettings, "relays" | "turn">): Promise<void>;
}

export const servicesPlatform: ServicesPlatform | null = null;
