import type { WireEndpoint } from "./frames";

/**
 * Payments between two linked peers. Ghostly does not move money itself: it
 * carries payment requests, in-band payments such as ecash tokens, and
 * receipts over the data link, and a platform wallet executes them.
 *
 * Vocabulary and identifiers follow Pubky's Paykit so that publishing the same
 * endpoints through Paykit later is a change of transport, not of model:
 * an endpoint is an identifier plus a payload, an amount is decimal text plus
 * an asset.
 */
export const ENDPOINT = {
  /** Payload: a BOLT11 invoice. */
  bolt11: "btc-lightning-bolt11",
  /**
   * Payload in a request: JSON `{ "mints": ["https://…"] }`, the mints the
   * payee accepts ecash from. Payload in a payment: a `cashuB…` token.
   */
  cashu: "cashu",
  arkade: "btc-arkade/1",
  /** Second's Ark (Bark). Payload in a request: a payment target; in a payment: a receipt hint. */
  bark: "btc-bark/1",
  usdt: "usdt-erc20/1",
  /** On-chain Bitcoin. Payload in a request: a payment target (a fresh address); in a payment: a receipt hint `{ txid }`. */
  bitcoin: "btc-onchain/1",
  /**
   * Fedimint ecash. Payload in a request: JSON `{ "federations": ["<federation id>", …] }`, the federations the
   * payee has joined and takes ecash from. Payload in a payment: the notes themselves (out-of-band notes, a
   * bearer string only the federation that issued them redeems).
   */
  fedimint: "fedimint-ecash/1",
  /**
   * Spark, wallet to wallet. Payload in a request: a payment target whose address is a Spark invoice made for
   * that request; in a payment: a receipt hint `{ id }` (the payer's transfer id).
   */
  spark: "btc-spark/1",
} as const;

export interface PaymentAmount {
  /** Decimal text; whole numbers for `sat`. */
  value: string;
  asset: string;
}

export interface PaymentRequest {
  id: string;
  timestamp: number;
  amount: PaymentAmount;
  memo?: string;
  endpoints: WireEndpoint[];
  /** The ask this request answers, when the contact asked to pay (see {@link PaymentAsk}). */
  ask?: string;
  /** Real money or test coins: only a wallet of this network pays it. Absent from older apps. */
  network?: "mainnet" | "testnet";
}

/**
 * "I want to pay you this much this way": sent by a payer who has no address to pay to (Ark, USDT).
 * The payee's app answers with an ordinary payment request carrying `ask`, which the payer
 * then reviews and approves like any other.
 */
export interface PaymentAsk {
  id: string;
  timestamp: number;
  amount: PaymentAmount;
  method: "arkade" | "usdt" | "bark" | "bitcoin" | "fedimint" | "spark";
  memo?: string;
  /** The network the payer pays from. Absent from older apps. */
  network?: "mainnet" | "testnet";
}

export interface Payment {
  id: string;
  timestamp: number;
  requestId?: string;
  amount: PaymentAmount;
  memo?: string;
  endpoint: WireEndpoint;
}

export interface PaymentResult {
  /** Id of the payment or request this is about. */
  id: string;
  ok: boolean;
  /** Amount credited when it differs from the amount sent. */
  credited?: string;
  error?: string;
  /**
   * On a request (`ok` false): its payee closed it for good, and a payment made to it now is lost. Only the payee of a
   * request says it; the payer stops offering to pay it.
   */
  closed?: boolean;
}

export function cashuRequestPayload(mints: string[]): string {
  return JSON.stringify({ mints });
}

/** Mints named by a `cashu` endpoint of a request. Anything malformed yields none. */
export function parseCashuRequestPayload(payload: string): string[] {
  try {
    const { mints } = JSON.parse(payload) as { mints?: unknown };
    if (!Array.isArray(mints)) return [];
    return mints.filter((m): m is string => typeof m === "string" && /^https?:\/\//.test(m)).slice(0, 8);
  } catch {
    return [];
  }
}

/** A Fedimint federation id: 32 bytes, lowercase hex. */
export const isFederationId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

export function fedimintRequestPayload(federations: string[]): string {
  return JSON.stringify({ federations });
}

/** Federations named by a `fedimint-ecash/1` endpoint of a request. Anything malformed yields none. */
export function parseFedimintRequestPayload(payload: string): string[] {
  try {
    const { federations } = JSON.parse(payload) as { federations?: unknown };
    if (!Array.isArray(federations)) return [];
    return [...new Set(federations.filter(isFederationId))].slice(0, 8);
  } catch {
    return [];
  }
}

export function findEndpoint(endpoints: WireEndpoint[], identifier: string): string | undefined {
  return endpoints.find(([id]) => id === identifier)?.[1];
}
