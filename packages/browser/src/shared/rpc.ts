import type { CashuInspection, EngineState, MessageFile, Settings, StoredMessage } from "./types";

/** UI → engine calls. The extension carries them over a runtime port, the web app calls the peer in the same page. */
export interface EngineApi {
  createLink(): { linkId: string; inviteCode: string };
  joinLink(params: { inviteCode: string }): { linkId: string };
  /** Makes sure a link with these parameters runs; used by UIs that keep their own session list. */
  ensureLink(params: { seedB64: string; peerPubKeyZ32: string; encKeyB64: string }): { linkId: string };
  pollNow(params: { linkId: string }): void;
  removeLink(params: { linkId: string }): void;
  renameLink(params: { linkId: string; label: string }): void;
  setActiveLink(params: { linkId: string | null }): void;
  sendMessage(params: { linkId: string; text: string; timestamp?: number }): { error: string | null };
  /** Link secrets, for a UI that keeps its own session list in the same profile. */
  exportLinks(): { seedB64: string; peerPubKeyZ32: string; encKeyB64: string; createdAt: number; inviteCode?: string; label?: string }[];
  /** Sends a file whose bytes the caller already put in the `files` store. Progress shows up in `transfers`. */
  sendFile(params: { linkId: string; file: MessageFile; timestamp: number }): void;
  connect(params: { linkId: string }): void;
  walletAddMint(params: { url: string; primary?: boolean }): { url: string; name: string };
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
  requestPayment(params: { linkId: string; amount: number; memo?: string; timestamp: number }): { paymentId: string };
  payRequest(params: { linkId: string; paymentId: string }): void;
  reclaimPayment(params: { paymentId: string }): void;
  disconnect(params: { linkId: string }): void;
  addService(params: { name: string; target: string }): { serviceId: string };
  removeService(params: { serviceId: string }): void;
  setServiceEnabled(params: { serviceId: string; enabled: boolean }): void;
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

export type EngineEvent =
  | { kind: "state"; state: EngineState }
  | { kind: "messages"; linkId: string; messages: StoredMessage[] }
  | { kind: "call-signal"; linkId: string; signal: string };
