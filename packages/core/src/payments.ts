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

export function findEndpoint(endpoints: WireEndpoint[], identifier: string): string | undefined {
  return endpoints.find(([id]) => id === identifier)?.[1];
}
