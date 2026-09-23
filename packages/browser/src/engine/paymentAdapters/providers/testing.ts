import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";
import { decodeBolt11 } from "@ghostly/core";
import type { InvoiceStatus, LightningInvoice, LightningPayResult, LightningPaymentRef, LightningPaymentStatus, LightningProvider, LightningProviderDescriptor } from "./lightning";
import type { OnchainBalance, OnchainPrepared, OnchainProvider, OnchainProviderDescriptor, OnchainSendRequest, OnchainTx, OnchainTxStatus } from "./onchain";
import { NothingSpentError, type ProviderField, type ProviderSettings } from "./types";

/**
 * Fake providers, for unit tests and e2e: they hold regtest "sats" in memory, so they only ever show up in
 * the Testnet mode, and only when `localStorage["ghostly-test-providers"] === "1"` (or a test passes them
 * to the registry itself). No network, no money.
 *
 * `behaviour` drives the outcome of a spend:
 *  - settle: invoices are paid by themselves after `settleMs`; payments and broadcasts succeed.
 *  - refuse: a spend fails, provably before anything left (`NothingSpentError`).
 *  - hang:   a spend throws an unknown error, and the lookup later says it went through (a lost answer).
 */
export type FakeBehaviour = "settle" | "refuse" | "hang";
export const TEST_PROVIDERS_FLAG = "ghostly-test-providers";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const uint = (value: number, length = 1) => {
  const out: number[] = [];
  for (let v = value; v > 0; v = Math.floor(v / 32)) out.unshift(v % 32);
  while (out.length < length) out.unshift(0);
  return out;
};

/** A BOLT 11 invoice on regtest with a real checksum and a blank signature: it decodes, nobody can pay it. */
export function fakeInvoice(amount: number, paymentHash: Uint8Array, memo = "", expirySeconds = 3600): string {
  const words = uint(Math.floor(Date.now() / 1000), 7);
  const field = (tag: number, data: number[]) => words.push(tag, data.length >> 5, data.length & 31, ...data);
  field(1, bech32.toWords(paymentHash));
  if (memo) field(13, bech32.toWords(new TextEncoder().encode(memo.slice(0, 100))));
  field(6, uint(expirySeconds));
  return bech32.encode(`lnbcrt${amount * 10}n`, [...words, ...new Array<number>(104).fill(0)], false);
}

/** A valid regtest P2WPKH address of nobody's. */
export const fakeAddress = () => bech32.encode("bcrt", [0, ...bech32.toWords(random(20))]);

const FIELDS: ProviderField[] = [
  { name: "alias", label: "Name", kind: "text", optional: true, placeholder: "Fake node" },
  { name: "token", label: "Access token", kind: "secret", placeholder: "anything", help: "Sealed like a real provider's secret; the fake only checks it is there." },
  { name: "behaviour", label: "Spends", kind: "select", optional: true, options: [{ value: "settle", label: "Go through" }, { value: "refuse", label: "Are refused" }, { value: "hang", label: "Lose their answer" }], defaults: { testnet: "settle" } },
];
const validate = ({ secrets, config }: ProviderSettings) => {
  if (!secrets.token?.trim()) throw new Error("Enter an access token");
  if (config.behaviour && !["settle", "refuse", "hang"].includes(config.behaviour)) throw new Error("Unknown behaviour");
};

interface FakeOptions { alias?: string; behaviour?: FakeBehaviour; balance?: number; settleMs?: number; token?: string }

export class FakeLightningProvider implements LightningProvider {
  readonly capabilities = { receive: true, send: true, balance: true, lookup: true };
  readonly invoices = new Map<string, { invoice: LightningInvoice; paid: boolean }>();
  readonly payments = new Map<string, LightningPaymentStatus>();
  readonly paid: string[] = [];
  balance: number;
  behaviour: FakeBehaviour;
  closed = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  constructor(readonly options: FakeOptions = {}) { this.balance = options.balance ?? 100_000; this.behaviour = options.behaviour ?? "settle"; }
  async info() { return { network: "regtest" as const, alias: this.options.alias || "Fake Lightning", balance: this.balance }; }
  async createInvoice(amount: number, memo?: string): Promise<LightningInvoice> {
    const preimage = random(32), hash = sha256(preimage);
    const invoice: LightningInvoice = { invoice: fakeInvoice(amount, hash, memo), paymentHash: hex(hash), amount, expiresAt: Date.now() + 3600_000, ref: hex(preimage) };
    this.invoices.set(invoice.paymentHash, { invoice, paid: false });
    if (this.behaviour === "settle") this.timers.push(setTimeout(() => this.markPaid(invoice.paymentHash), this.options.settleMs ?? 1500));
    return invoice;
  }
  /** Someone paid this invoice. */
  markPaid(paymentHash: string) {
    const entry = this.invoices.get(paymentHash);
    if (!entry || entry.paid || this.closed) return;
    entry.paid = true; this.balance += entry.invoice.amount;
  }
  async invoiceStatus(invoice: LightningInvoice): Promise<InvoiceStatus> {
    const entry = this.invoices.get(invoice.paymentHash);
    if (entry?.paid) return { state: "paid", amount: entry.invoice.amount };
    return { state: invoice.expiresAt < Date.now() ? "expired" : "open" };
  }
  async estimateFee(_invoice: string, amount: number) { return Math.max(1, Math.ceil(amount / 100)); }
  async payInvoice(invoice: string, maxFee: number): Promise<LightningPayResult> {
    const decoded = decodeBolt11(invoice);
    if (!decoded?.paymentHash || decoded.amountSat === null) throw new NothingSpentError("Not an invoice this fake can pay");
    const fee = Math.min(maxFee, Math.max(1, Math.ceil(decoded.amountSat / 100)));
    if (this.behaviour === "refuse") throw new NothingSpentError("No route (fake)");
    if (this.balance < decoded.amountSat + fee) throw new NothingSpentError("Not enough sats in the fake wallet");
    this.balance -= decoded.amountSat + fee;
    this.paid.push(decoded.paymentHash);
    this.payments.set(decoded.paymentHash, { state: "paid", fee, preimage: hex(random(32)) });
    if (this.behaviour === "hang") throw new Error("Connection lost (fake)");
    return { state: "paid", fee, preimage: this.payments.get(decoded.paymentHash)!.preimage };
  }
  async paymentStatus(payment: LightningPaymentRef): Promise<LightningPaymentStatus> {
    return this.payments.get(payment.paymentHash) ?? { state: "failed" };
  }
  async close() { this.closed = true; for (const t of this.timers) clearTimeout(t); }
}

export class FakeOnchainProvider implements OnchainProvider {
  readonly addresses: string[] = [];
  readonly broadcasts: string[] = [];
  readonly released: string[] = [];
  readonly txs = new Map<string, { prepared: OnchainPrepared; confirmations: number }>();
  confirmed: number;
  behaviour: FakeBehaviour;
  closed = false;
  constructor(readonly options: FakeOptions = {}) { this.confirmed = options.balance ?? 100_000; this.behaviour = options.behaviour ?? "settle"; }
  async info() { return { network: "regtest" as const, alias: this.options.alias || "Fake Bitcoin wallet" }; }
  async receiveAddress() { const address = fakeAddress(); this.addresses.push(address); return address; }
  async balance(): Promise<OnchainBalance> { return { confirmed: this.confirmed, unconfirmed: 0 }; }
  async prepareSend(request: OnchainSendRequest): Promise<OnchainPrepared> {
    const feeRate = request.feeRate ?? 2, fee = feeRate * 141;
    if (fee > request.feeCap) throw new Error(`The fee (${fee} sats) is above your limit`);
    if (this.confirmed < request.amount + fee) throw new Error("Not enough confirmed sats");
    return { txid: hex(random(32)), address: request.address, amount: request.amount, fee, feeRate, signed: hex(random(64)) };
  }
  async broadcast(prepared: OnchainPrepared) {
    if (this.behaviour === "refuse") throw new NothingSpentError("Rejected by the node (fake)");
    if (!this.txs.has(prepared.txid)) { this.confirmed -= prepared.amount + prepared.fee; this.txs.set(prepared.txid, { prepared, confirmations: 1 }); }
    this.broadcasts.push(prepared.txid);
    if (this.behaviour === "hang") throw new Error("Connection lost (fake)");
    return prepared.txid;
  }
  async status(prepared: OnchainPrepared): Promise<OnchainTxStatus> {
    const tx = this.txs.get(prepared.txid);
    return tx ? { state: "confirmed", confirmations: tx.confirmations } : { state: "missing", confirmations: 0 };
  }
  async release(prepared: OnchainPrepared) { this.released.push(prepared.txid); }
  async history(limit: number): Promise<OnchainTx[]> {
    return [...this.txs.values()].reverse().slice(0, limit).map(({ prepared, confirmations }) => ({ txid: prepared.txid, amount: -prepared.amount, fee: prepared.fee, confirmations }));
  }
  async close() { this.closed = true; }
}

const options = ({ config, secrets }: ProviderSettings): FakeOptions => ({ alias: config.alias, behaviour: (config.behaviour as FakeBehaviour) || "settle", token: secrets.token });

export const fakeLightning: LightningProviderDescriptor = {
  id: "fake-lightning",
  label: "Fake Lightning (test)",
  kind: "lightning",
  description: "In-memory regtest node for tests. Holds nothing.",
  networks: ["regtest"],
  platforms: ["web", "extension", "desktop"],
  fields: FIELDS,
  experimental: true,
  validate,
  async create(settings) { return new FakeLightningProvider(options(settings)); },
};

export const fakeOnchain: OnchainProviderDescriptor = {
  id: "fake-onchain",
  label: "Fake Bitcoin wallet (test)",
  kind: "onchain",
  description: "In-memory regtest wallet for tests. Holds nothing.",
  networks: ["regtest"],
  platforms: ["web", "extension", "desktop"],
  fields: FIELDS,
  experimental: true,
  validate,
  async create(settings) { return new FakeOnchainProvider(options(settings)); },
};

/** Whether this browser asked for the fake providers (an e2e run sets it before the app starts). */
export function testProvidersEnabled(): boolean {
  try { return globalThis.localStorage?.getItem(TEST_PROVIDERS_FLAG) === "1"; } catch { return false; }
}
