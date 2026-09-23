import type { ProviderDescriptor, ProviderNetwork } from "./types";

/**
 * A source of on-chain Bitcoin: a wallet that can give an address, tell its balance and sign and
 * broadcast a transaction (BDK, a Bitcoin Core wallet, …). One is active per profile and per wallet mode;
 * the Bitcoin card and the "bitcoin" payment method go through it. See PROVIDERS.md.
 *
 * Amounts are whole sats; fee rates sat/vB.
 */

export interface OnchainInfo {
  network: ProviderNetwork;
  /** A name for the wallet or node, when it has one. */
  alias?: string;
}

export interface OnchainBalance {
  confirmed: number;
  /** In the mempool, in or out: not spendable yet. */
  unconfirmed: number;
}

export interface OnchainSendRequest {
  address: string;
  amount: number;
  /** The most the person accepted to pay in fees, in sats. A transaction that costs more is refused. */
  feeCap: number;
  /** Chosen by the person; absent, the provider estimates one. */
  feeRate?: number;
}

/**
 * A transaction built, checked and SIGNED for exactly one reviewed payment. It is saved with the review
 * before it is broadcast, so a lost answer is reconciled by asking about (or re-broadcasting) this very
 * transaction, never by building another: the same inputs cannot be spent twice.
 */
export interface OnchainPrepared {
  txid: string;
  address: string;
  amount: number;
  fee: number;
  feeRate: number;
  /** The signed transaction as hex, or what the provider needs to broadcast it again. JSON only. */
  signed: string;
}

export interface OnchainTxStatus {
  /**
   * `missing`: no node or indexer knows it (dropped, or never arrived); re-broadcasting it is safe.
   * `conflicted`: another transaction spent its inputs. It can never confirm.
   */
  state: "confirmed" | "mempool" | "missing" | "conflicted";
  confirmations: number;
}

export interface OnchainTx {
  txid: string;
  /** Positive when received, negative when sent (without the fee). */
  amount: number;
  fee?: number;
  confirmations: number;
  timestamp?: number;
}

export interface OnchainProvider {
  info(): Promise<OnchainInfo>;
  /** A fresh address of this wallet to be paid on. */
  receiveAddress(): Promise<string>;
  balance(): Promise<OnchainBalance>;
  /**
   * Builds and signs the transaction for a review, without broadcasting it. Throws when it cannot (not
   * enough funds, a fee above `feeCap`): nothing is spent by preparing.
   */
  prepareSend(request: OnchainSendRequest): Promise<OnchainPrepared>;
  /**
   * Broadcasts the prepared transaction and returns its txid. Throws `NothingSpentError` only when the
   * transaction is known not to have reached anyone; any other throw is an unknown outcome.
   */
  broadcast(prepared: OnchainPrepared): Promise<string>;
  /** Where this transaction stands. Asked after an unknown outcome and until it confirms. */
  status(prepared: OnchainPrepared): Promise<OnchainTxStatus>;
  /** A review cancelled before approval: unlock the coins `prepareSend` reserved. */
  release?(prepared: OnchainPrepared): Promise<void>;
  /** Newest first. */
  history(limit: number): Promise<OnchainTx[]>;
  /**
   * Optional: the transactions paying this address of the wallet, newest first, `amount` being what each
   * paid to it. How the payee of a chat request knows it was paid; without it, the payer's txid receipt is
   * checked against `history`.
   */
  received?(address: string): Promise<OnchainTx[]>;
  close(): Promise<void>;
}

export type OnchainProviderDescriptor = ProviderDescriptor<OnchainProvider> & { kind: "onchain" };
