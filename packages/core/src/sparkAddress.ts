import { bech32m } from "@scure/base";

/**
 * Spark (https://spark.money): a Bitcoin layer 2 where a transfer between two Spark wallets is instant and
 * off-chain. Ghostly's Spark wallets run on Bitcoin (real sats, Breez API key) or on regtest (Breez and
 * Lightspark's hosted test network, worthless sats). Spark's own testnet and signet are not offered by the
 * Breez SDK, so they are not payment networks here.
 */
export type SparkNetwork = "bitcoin" | "regtest";
export const SPARK_NETWORKS: readonly SparkNetwork[] = ["bitcoin", "regtest"];
/**
 * The `provider` of a Spark target. Spark is one network per chain (its operators are the same for every
 * wallet), so any Spark wallet on the same network pays any Spark address: the payee names no service.
 */
export const SPARK_PROVIDER = "spark";

const HRP: Record<SparkNetwork, string> = { bitcoin: "spark", regtest: "sparkrt" };
/** Long enough for an invoice with a 140-character memo and its signature. */
const MAX_LENGTH = 1024;

/**
 * What a Spark string is on `network`: a wallet's `address` (its identity key, the same every time) or an
 * `invoice` (an address plus an amount, an expiry, a memo and a unique id, signed by the payee). Undefined
 * when it is neither, or belongs to another network. Structure only: the wallet's SDK checks the rest.
 */
export function sparkAddressKind(address: unknown, network: SparkNetwork): "address" | "invoice" | undefined {
  if (typeof address !== "string" || !SPARK_NETWORKS.includes(network) || address.length > MAX_LENGTH) return undefined;
  // One case only, and Spark writes lower case.
  if (address !== address.toLowerCase() || !address.startsWith(`${HRP[network]}1`)) return undefined;
  let payload: Uint8Array;
  try {
    const decoded = bech32m.decode(address as `${string}1${string}`, MAX_LENGTH);
    if (decoded.prefix !== HRP[network]) return undefined;
    payload = bech32m.fromWords(decoded.words);
  } catch { return undefined; }
  // Protobuf: field 1, 33 bytes, a compressed public key (the wallet's identity).
  if (payload.length < 35 || payload[0] !== 0x0a || payload[1] !== 0x21 || (payload[2] !== 0x02 && payload[2] !== 0x03)) return undefined;
  if (payload.length === 35) return "address";
  // Field 2: the invoice's fields. Anything else after the key is not a Spark string Ghostly knows.
  return payload[35] === 0x12 ? "invoice" : undefined;
}

export const isSparkAddress = (address: unknown, network: SparkNetwork): boolean => sparkAddressKind(address, network) !== undefined;

/** The Spark network a string belongs to, from its prefix alone (`spark1…` Bitcoin, `sparkrt1…` regtest). */
export function sparkNetworkOf(address: string): SparkNetwork | undefined {
  return SPARK_NETWORKS.find((network) => sparkAddressKind(address, network) !== undefined);
}

/** What a Spark invoice asks for, read from the invoice itself (the payer's wallet checks it again). */
export interface SparkInvoiceDetails {
  /** Sats asked; absent when the payer chooses. */
  amount?: number;
  memo?: string;
  /** Milliseconds. */
  expiresAt?: number;
  /** An invoice for a token (not sats): Ghostly does not pay those. */
  token: boolean;
}

/** Protobuf, just enough of it: `[field, wire type, value]` of each field of a message, or undefined when malformed. */
function fields(bytes: Uint8Array): [number, number, Uint8Array | bigint][] | undefined {
  const out: [number, number, Uint8Array | bigint][] = [];
  let at = 0;
  const varint = (): bigint | undefined => {
    let value = 0n, shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (at >= bytes.length) return undefined;
      const b = bytes[at++];
      value |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return value;
      shift += 7n;
    }
    return undefined;
  };
  while (at < bytes.length) {
    const key = varint();
    if (key === undefined) return undefined;
    const field = Number(key >> 3n), wire = Number(key & 7n);
    if (wire === 0) { const v = varint(); if (v === undefined) return undefined; out.push([field, wire, v]); }
    else if (wire === 2) {
      const length = varint();
      if (length === undefined || at + Number(length) > bytes.length) return undefined;
      out.push([field, wire, bytes.slice(at, at + Number(length))]); at += Number(length);
    } else return undefined;
  }
  return out;
}

/**
 * The amount, memo and expiry a Spark invoice carries (SparkInvoiceFields: 4 sats payment, 3 tokens payment, 5 memo,
 * 7 expiry time), or undefined when `invoice` is not an invoice of `network`.
 */
export function sparkInvoiceDetails(invoice: string, network: SparkNetwork): SparkInvoiceDetails | undefined {
  if (sparkAddressKind(invoice, network) !== "invoice") return undefined;
  const top = fields(bech32m.fromWords(bech32m.decode(invoice as `${string}1${string}`, MAX_LENGTH).words));
  const body = top?.find(([field, wire]) => field === 2 && wire === 2)?.[2];
  const inner = body instanceof Uint8Array ? fields(body) : undefined;
  if (!inner) return undefined;
  const details: SparkInvoiceDetails = { token: false };
  for (const [field, wire, value] of inner) {
    if (wire !== 2 || !(value instanceof Uint8Array)) continue;
    if (field === 3) details.token = true;
    else if (field === 4) {
      const amount = fields(value)?.find(([f, w]) => f === 1 && w === 0)?.[2];
      if (typeof amount === "bigint") { if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return undefined; details.amount = Number(amount); }
    } else if (field === 5) details.memo = new TextDecoder().decode(value).slice(0, 140);
    else if (field === 7) {
      const seconds = fields(value)?.find(([f, w]) => f === 1 && w === 0)?.[2];
      if (typeof seconds === "bigint" && seconds < 1n << 40n) details.expiresAt = Number(seconds) * 1000;
    }
  }
  return details;
}
