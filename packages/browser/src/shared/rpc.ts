import type { UsdtCreate } from "../engine/paymentAdapters/usdtWallet";
import type { PaymentReview, PaymentTarget } from "@ghostly/core";
import type { ArkConfig } from "../engine/paymentAdapters/arkade";
import type { ArkCreate } from "../engine/paymentAdapters/arkWallet";
import type { ProfileChoice } from '../profiles/public';
import type { ProofChallenge, ProofEvidence, ProofAdapter } from "@ghostly/core";
import type { LinkParams, PairedTransport, DeliveryMode } from "@ghostly/core";
import type { CashuInspection, EngineState, MessageFile, Settings, StoredMessage } from "./types";

/** UI → engine calls. The extension carries them over a runtime port, the web app calls the peer in the same page. */
export interface EngineApi {
  usdtCreate(params:UsdtCreate):void;
  usdtUnlock(params:{password:string}):void;
  usdtReveal(params:{password?:string}):string;
  usdtLock():void;
  usdtRefresh():void;
  /** Sepolia only: test USDT from a public faucet; returns the transaction hash. */
  usdtGetTestTokens():string;
  usdtExportBackup(params:{password:string}):string;
  usdtRestoreBackup(params:{text:string;password:string}):void;
  arkCreate(params: ArkCreate): void;
  arkUnlock(params: {password:string}): void;
  arkLock(): void;
  arkBackup(params: {password?:string}): {mnemonic:string;config:ArkConfig};
  arkExportBackup(params:{password:string}):string;
  arkRestoreBackup(params:{text:string;password:string}):void;
  arkRefresh(): void;
  /** Expired Ark outputs back into the balance; returns the settlement txid. */
  arkRecover(): string;
  preparePayment(params: {target:PaymentTarget;amount:number;feeCap:number;payee:string;linkId?:string;requestId?:string;memo?:string}): PaymentReview;
  approvePayment(params: {id:string}): PaymentReview;
  reconcilePayment(params: {id:string}): PaymentReview;
  cancelPayment(params: {id:string}): PaymentReview;

  refreshPublicProfiles(params: { linkId: string; force?: boolean }): void;
  choosePublicProfile(params: { linkId: string; choice: ProfileChoice }): void;
  preparePeerProof(params: { linkId: string; externalKey: string; adapter?: ProofAdapter }): ProofChallenge;
  submitPeerProof(params: { linkId: string; challenge: ProofChallenge; event: ProofEvidence }): void;
  withdrawPeerProof(params: { linkId: string; adapter?: ProofAdapter }): void;
  createLink(): { linkId: string; inviteCode: string };
  joinLink(params: { inviteCode: string }): { linkId: string };
  /** Makes sure a link with these parameters runs; used by UIs that keep their own session list. */
  ensureLink(params: LinkParams): { linkId: string };
  confirmPair(params: { linkId: string; code: string }): void;
  pollNow(params: { linkId: string }): void;
  removeLink(params: { linkId: string }): void;
  renameLink(params: { linkId: string; label: string }): void;
  setActiveLink(params: { linkId: string | null }): void;
  /** `refused`: the text was not kept (it cannot be sent this way); any other error leaves it to be sent later. */
  sendMessage(params: { linkId: string; text: string; timestamp?: number }): { error: string | null; refused?: boolean };
  retryMessage(params: { linkId: string; messageId: string }): void;
  /** Forgets one message and the bytes of the file it carried. Nothing is sent: the peer keeps its copy. */
  deleteMessage(params: { linkId: string; messageId: string }): void;
  /** Link secrets, for a UI that keeps its own session list in the same profile. */
  exportLinks(): { deliveryMode?: DeliveryMode; profile?: "paired-chat/1"; seedB64: string; peerPubKeyZ32: string; encKeyB64: string; createdAt: number; inviteCode?: string; label?: string }[];
  /** Sends a file whose bytes the caller already put in the `files` store. Progress shows up in `transfers`. */
  sendFile(params: { linkId: string; file: MessageFile; timestamp: number }): void;
  setDeliveryMode(params: { linkId: string; mode: DeliveryMode }): void;
  setTransportPreference(params: { linkId: string; preferred: PairedTransport; fallback: boolean }): void;
  setChatPaymentMethods(params: { linkId: string; methods: Partial<Record<import("@ghostly/core").PaymentMethodName, boolean>> }): void;
  connect(params: { linkId: string }): void;
  walletAddMint(params: { url: string; primary?: boolean }): { url: string; name: string };
  /** Real money or test networks, for every wallet at once. */
  walletSetMode(params: { mode: "mainnet" | "testnet" }): void;
  /** The app is in front again: chats look now, and dropped ones reconnect at once. */
  wake(): void;
  /** The primary mint is where Lightning invoices are created. */
  walletSetPrimaryMint(params: { url: string }): void;
  walletRemoveMint(params: { url: string }): void;
  /** A Lightning invoice that, once paid by anyone, lands in the wallet as ecash. */
  walletReceiveLightning(params: { amount: number }): { quote: string; invoice: string; expiresAt: number | null };
  walletQuoteInvoice(params: { invoice: string }): { quote: string; mint: string; amount: number; feeReserve: number };
  walletPayQuote(params: { quote: string; mint: string }): { paid: boolean };
  /** Redeems a token pasted by the user. Only mints the user added are accepted. */
  walletReceiveToken(params: { token: string }): { amount: number };
  walletInspectCashu(params: { text: string }): { inspection: CashuInspection | null };
  /** Everything held, as tokens: the only backup there is for now. */
  walletExport(): { mint: string; token: string; amount: number }[];
  sendPayment(params: { linkId: string; amount: number; memo?: string; timestamp: number }): { paymentId: string };
  requestPayment(params: { linkId: string; amount: number; memo?: string; timestamp: number; method?: "cashu" | "arkade" | "usdt" }): { paymentId: string };
  /** Asks the contact for a way to pay it (Ark, USDT); its answer is a request carrying `askId`. */
  askToPay(params: { linkId: string; amount: number; method: "arkade" | "usdt"; memo?: string; timestamp: number }): { askId: string };
  payRequest(params: { linkId: string; paymentId: string }): void;
  reclaimPayment(params: { paymentId: string }): void;
  disconnect(params: { linkId: string }): void;
  addService(params: { name: string; target: string }): { serviceId: string };
  removeService(params: { serviceId: string }): void;
  setServiceEnabled(params: { serviceId: string; enabled: boolean }): void;
  setServiceShared(params: { serviceId: string; peerPubKeyZ32: string; shared: boolean }): void;
  updateSettings(params: { settings: Partial<Settings> }): void;
  setCallSignal(params: { linkId: string; signal: string | null }): void;
  setFastPoll(params: { linkId: string; fast: boolean }): void;
}

/** What the engine implements: any call may be answered asynchronously. */
export type EngineImplementation = {
  [M in keyof EngineApi]: EngineApi[M] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<R> : never;
};

export type EngineMethod = keyof EngineApi;
type Params<M extends EngineMethod> = Parameters<EngineApi[M]> extends [infer P] ? P : undefined;

export interface RpcRequest<M extends EngineMethod = EngineMethod> {
  kind: "request";
  id: number;
  method: M;
  params: Params<M>;
}

export interface RpcResponse {
  kind: "response";
  id: number;
  result?: unknown;
  error?: string;
}

/** Ephemeral UI feedback, never part of history or the initial snapshot. No private content. */
export interface AttentionEvent {
  id: string;
  type: "message" | "sent" | "coin" | "confirmed";
  at: number;
}
export type EngineEvent =
  | { kind: "attention"; event: AttentionEvent }
  | { kind: "state"; state: EngineState }
  | { kind: "messages"; linkId: string; messages: StoredMessage[] }
  | { kind: "call-signal"; linkId: string; signal: string };
