import { BITCOIN_NETWORKS, isBitcoinAddress, type BitcoinNetwork } from "./bitcoinAddress";
import { isFederationId } from "./payments";
import { SPARK_NETWORKS, SPARK_PROVIDER, isSparkAddress, type SparkNetwork } from "./sparkAddress";

/** Local wallet contract. Capability support is never authorization to spend. */
export type PaymentMethod = "cashu" | "arkade" | "usdt" | "bark" | "bitcoin" | "fedimint" | "spark";
export type PaymentNetwork = "bitcoin" | "signet" | "testnet" | "mutinynet" | "regtest" | "cashu-test" | "ethereum" | "sepolia" | "evm-local";
/**
 * The `provider` of an on-chain target. Anyone can pay a Bitcoin address from any wallet, so the payee
 * names no service; which wallet pays is the payer's own choice (its active on-chain source).
 */
export const ONCHAIN_PROVIDER = "onchain";
export type IntentState = "pending" | "submitted" | "settled" | "failed" | "unknown" | "cancelled";
export interface PaymentTarget {
  method: PaymentMethod;
  network: PaymentNetwork;
  provider: string;
  asset: "BTC" | "USDT" | "TEST-USDT";
  unit: "sat" | "token-base";
  chainId?: number;
  token?: string;
  decimals?: number;
  issuedAt?: number;
  address: string;
  expiresAt: number;
}
export interface PaymentReview extends PaymentTarget {
  id: string;
  requestId?: string;
  linkId?: string;
  payee: string;
  /** What the payment is for, as the payer wrote it (at most 140 characters). */
  memo?: string;
  amount: number;
  fee: number;
  feeCap: number;
  createdAt: number;
  state: IntentState;
  txid?: string;
  error?: string;
  evm?: { from: string; nonce: number; gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string; confirmations: number };
}
export interface PaymentAdapter<Prepared = unknown> {
  method: PaymentMethod;
  prepare(target: PaymentTarget, amount: number, feeCap: number): Promise<{ fee: number; prepared: Prepared; evm?: PaymentReview["evm"] }>;
  execute(review: PaymentReview, prepared: Prepared, persist?: () => Promise<void>): Promise<PaymentExecution>;
  reconcile(review: PaymentReview, prepared: Prepared, persist?:()=>Promise<void>): Promise<PaymentExecution>;
  /** A review cancelled before approval: give back what `prepare` reserved (locked coins). Nothing was spent. */
  release?(review: PaymentReview, prepared: Prepared): Promise<void>;
}
export interface PaymentExecution { txid?: string; settled: boolean; pending?: boolean; failed?: boolean; error?: string }
/** Only use before signing/broadcasting, when no spend could have happened. */
export class PaymentPreflightError extends Error {}
export const ETHEREUM_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
/** Test networks for the token wallet and their chain IDs. Their tokens are worthless and not issued by Tether. */
export const EVM_TEST_CHAINS = { sepolia: 11155111, "evm-local": 31337 } as const;
/** Aave's Sepolia test USDT (6 decimals): anyone can mint it from Aave's faucet, so a test needs only Sepolia ETH. */
export const SEPOLIA_TEST_USDT = "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0";
/** Aave's public test-token faucet on Sepolia: `mint(token, to, amount)`, open to anyone who pays the gas. */
export const SEPOLIA_TEST_USDT_FAUCET = "0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D";
/** What one "Get test USDT" asks for: 1,000 TEST-USDT (6 decimals). */
export const TEST_USDT_FAUCET_AMOUNT = 1_000_000_000;
export function parsePaymentAmount(value: string, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error("Enter a valid amount");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places`);
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Amount exceeds the wallet limit");
  return Number(units);
}
export function formatPaymentAmount(value: number | string, decimals = 0): string {
  const digits = BigInt(value).toString().padStart(decimals + 1, "0");
  if (!decimals) return digits;
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return digits.slice(0, -decimals) + (fraction ? `.${fraction}` : "");
}
export function assertTokenUnits(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Enter a positive amount within the token precision and wallet limit");
}
export function assertWholeSats(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 2_100_000_000_000_000) throw new Error("Enter a positive whole amount in sats");
}
export function validatePaymentTarget(value: unknown, now = Date.now()): PaymentTarget {
  if (!value || typeof value !== "object") throw new Error("Invalid payment target");
  const t = value as PaymentTarget;
  const evm = t.method === "usdt";
  if (t.method === "bitcoin") {
    if (!BITCOIN_NETWORKS.includes(t.network as BitcoinNetwork) || t.asset !== "BTC" || t.unit !== "sat" || t.provider !== ONCHAIN_PROVIDER) throw new Error("Unsupported payment method, asset or network");
    if (!isBitcoinAddress(t.address, t.network as BitcoinNetwork)) throw new Error(`That is not a ${t.network === "bitcoin" ? "Bitcoin" : t.network} address`);
  } else if (t.method === "fedimint") {
    // The provider is the federation (its id); the address is what the payment answers: the request, or the contact.
    if (!BITCOIN_NETWORKS.includes(t.network as BitcoinNetwork) || t.asset !== "BTC" || t.unit !== "sat") throw new Error("Unsupported payment method, asset or network");
    if (!isFederationId(t.provider)) throw new Error("That is not a Fedimint federation id");
  } else if (t.method === "spark") {
    // Any Spark wallet of the network pays any Spark address or invoice of it: no provider to name.
    if (!SPARK_NETWORKS.includes(t.network as SparkNetwork) || t.asset !== "BTC" || t.unit !== "sat" || t.provider !== SPARK_PROVIDER) throw new Error("Unsupported payment method, asset or network");
    if (!isSparkAddress(t.address, t.network as SparkNetwork)) throw new Error(`That is not a Spark address on ${t.network === "bitcoin" ? "Bitcoin" : t.network}`);
  } else if (evm) {
    if (!["ethereum", "sepolia", "evm-local"].includes(t.network) || t.unit !== "token-base" || !/^0x[0-9a-fA-F]{40}$/.test(t.token ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(t.address) || /^0x0{40}$/i.test(t.address)) throw new Error("Invalid token, recipient or EVM network");
    // Only Ethereum carries real USDT; Sepolia and a local chain carry worthless test tokens.
    if (t.network === "ethereum" ? t.chainId !== 1 || t.asset !== "USDT" || t.token!.toLowerCase() !== ETHEREUM_USDT.toLowerCase() || t.decimals !== 6 : t.chainId !== EVM_TEST_CHAINS[t.network as "sepolia" | "evm-local"] || t.asset !== "TEST-USDT" || !Number.isInteger(t.decimals) || t.decimals! < 0 || t.decimals! > 18) throw new Error("Token metadata does not match the network");
    if (!Number.isSafeInteger(t.issuedAt) || t.issuedAt! < 0 || t.issuedAt! > now + 30000 || t.issuedAt! >= t.expiresAt) throw new Error("Invalid token request time");
  } else if (!["arkade", "cashu", "bark"].includes(t.method) || !["bitcoin", "signet", "mutinynet", "regtest", "cashu-test"].includes(t.network) || t.asset !== "BTC" || t.unit !== "sat") throw new Error("Unsupported payment method, asset or network");
  // Second's Ark servers run on Bitcoin, signet and regtest only.
  if (t.method === "bark" && !["bitcoin", "signet", "regtest"].includes(t.network)) throw new Error("Unsupported Bark network");
  if (typeof t.address !== "string" || !t.address || t.address.length > 4096 || typeof t.provider !== "string" || t.provider.length > 512) throw new Error("Invalid payment destination");
  if (t.method !== "bitcoin" && t.method !== "fedimint" && t.method !== "spark") {
    const url = new URL(t.provider);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Use HTTPS or a local test provider");
  }
  if (!Number.isSafeInteger(t.expiresAt) || t.expiresAt <= now || t.expiresAt > now + 24 * 60 * 60 * 1000) throw new Error("Payment request expired or has an invalid expiry");
  return { method:t.method,network:t.network,provider:t.provider,asset:t.asset,unit:t.unit,address:t.address,expiresAt:t.expiresAt, ...(evm ? {chainId:t.chainId,token:t.token,decimals:t.decimals,issuedAt:t.issuedAt} : {}) };
}
