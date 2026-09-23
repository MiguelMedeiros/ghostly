import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { decodeBolt11 } from "@ghostly/core";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import type { CashuWallet } from "../src/engine/wallet";
import { BREEZ_SOURCE, BreezLightning, breez, breezDescriptor, breezStorage, idempotencyKey } from "../src/engine/paymentAdapters/providers/breez";
import { cashuMint, CASHU_MINT_SOURCE } from "../src/engine/paymentAdapters/providers/cashuMint";
import { LightningService, type LightningEvents } from "../src/engine/paymentAdapters/providers/lightningService";
import { LIGHTNING_PROVIDERS, offeredIn } from "../src/engine/paymentAdapters/providers/registry";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { NothingSpentError } from "../src/engine/paymentAdapters/providers/types";
import { describeLightningProvider } from "./helpers/providerContract";
import { FakeBreezNetwork } from "./helpers/fakeBreez";

const phrase = () => generateMnemonic(wordlist);
let net: FakeBreezNetwork;
beforeEach(() => { net = new FakeBreezNetwork(); });
afterEach(() => { vi.restoreAllMocks(); });

/** A Breez source on the fake network, and the fake wallet behind it. */
async function connect(mnemonic = phrase(), balance = 0) {
  const provider = await BreezLightning.connect({ network: "regtest", mnemonic }, async () => net.sdk);
  const wallet = net.wallets.get(breezStorage("regtest", mnemonic))!;
  wallet.balance = balance;
  return { provider, wallet, mnemonic };
}
/** An invoice of another wallet on the same network. */
async function invoiceOf(amount: number) {
  const { provider } = await connect();
  const invoice = await provider.createInvoice(amount);
  await provider.close();
  return invoice.invoice;
}

describeLightningProvider("Breez (fake SDK)", async () => {
  const { provider } = await connect(phrase(), 50_000);
  return {
    provider, network: "regtest",
    payIncoming: async (invoice) => net.payFromOutside(invoice.invoice),
    payable: invoiceOf,
    refused: () => invoiceOf(10_000_000),
  };
});

describe("the Breez descriptor", () => {
  it("is registered, offered in Testnet on every platform, and not in Mainnet yet", () => {
    expect(LIGHTNING_PROVIDERS.map((d) => d.id)).toContain(BREEZ_SOURCE);
    for (const platform of ["web", "extension", "desktop"] as const) {
      expect(offeredIn(breez, platform, "testnet")).toBe(true);
      expect(offeredIn(breez, platform, "mainnet")).toBe(false);
    }
  });

  it("keeps the recovery phrase and the API key as secrets", () => {
    expect(breez.fields.map((f) => [f.name, f.kind])).toEqual([["mnemonic", "secret"], ["apiKey", "secret"]]);
  });

  it("refuses a phrase that is not BIP 39, and Mainnet without an API key", () => {
    expect(() => breez.validate!({ config: {}, secrets: { mnemonic: "not a phrase" } }, "testnet")).toThrow("not a valid recovery phrase");
    const mnemonic = phrase();
    expect(() => breez.validate!({ config: {}, secrets: { mnemonic: `  ${mnemonic.toUpperCase().replace(/ /g, "\n ")} ` } }, "testnet")).not.toThrow();
    expect(() => breez.validate!({ config: {}, secrets: { mnemonic } }, "mainnet")).toThrow("API key");
    expect(() => breez.validate!({ config: {}, secrets: { mnemonic, apiKey: "key" } }, "mainnet")).not.toThrow();
  });

  it("connects on regtest in Testnet, on Mainnet in Mainnet, with a storage that says nothing about the seed", async () => {
    const mnemonic = phrase();
    const descriptor = breezDescriptor(async () => net.sdk);
    const host = { platform: "web" as const, cashu: {} as CashuWallet, signal: new AbortController().signal };
    const testnet = await descriptor.create({ config: {}, secrets: { mnemonic: mnemonic.toUpperCase() } }, { ...host, mode: "testnet" });
    expect(await testnet.info()).toMatchObject({ network: "regtest", balance: 0 });
    const mainnet = await descriptor.create({ config: {}, secrets: { mnemonic, apiKey: "the-api-key" } }, { ...host, mode: "mainnet" });
    expect((await mainnet.info()).network).toBe("bitcoin");
    expect(net.connects.map(({ network, apiKey, mnemonic: m }) => ({ network, apiKey, same: m === mnemonic }))).toEqual([
      { network: "regtest", apiKey: undefined, same: true },
      { network: "mainnet", apiKey: "the-api-key", same: true },
    ]);
    const [a, b] = net.connects.map((c) => c.storage);
    expect(a).toMatch(/^ghostly-breez-regtest-[0-9a-f]{16}$/);
    expect(b).toMatch(/^ghostly-breez-mainnet-[0-9a-f]{16}$/);
    for (const word of mnemonic.split(" ")) expect(a).not.toContain(word);
    await testnet.close(); await mainnet.close();
  });

  it("runs one SDK instance per wallet, and disconnects it when the last user closes", async () => {
    const mnemonic = phrase();
    const [first, second] = await Promise.all([connect(mnemonic), connect(mnemonic)]);
    expect(net.connects).toHaveLength(1);
    await first.provider.close();
    expect(first.wallet.disconnected).toBe(false);
    await second.provider.close();
    await second.provider.close();
    expect(first.wallet.calls.filter((c) => c === "disconnect")).toHaveLength(1);
    await connect(mnemonic);
    expect(net.connects).toHaveLength(2);
  });
});

describe("paying with Breez: nothing spent vs unknown", () => {
  it("gives each attempt a stable UUID idempotency key", () => {
    const key = idempotencyKey("ab".repeat(32), 0);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(idempotencyKey("ab".repeat(32), 0)).toBe(key);
    expect(idempotencyKey("ab".repeat(32), 1)).not.toBe(key);
  });

  it("pays the payment whose fee was shown, and refuses one above the limit before sending", async () => {
    const { provider, wallet } = await connect(phrase(), 1_000);
    const invoice = await invoiceOf(100);
    wallet.fee = 5;
    expect(await provider.estimateFee(invoice, 100)).toBe(5);
    await expect(provider.payInvoice(invoice, 4)).rejects.toBeInstanceOf(NothingSpentError);
    expect(wallet.calls).not.toContain("sendPayment");
    expect(await provider.estimateFee(invoice, 100)).toBe(5);
    const prepares = wallet.calls.filter((c) => c === "prepareSendPayment").length;
    expect(await provider.payInvoice(invoice, 5)).toMatchObject({ state: "paid", fee: 5 });
    expect(wallet.calls.filter((c) => c === "prepareSendPayment")).toHaveLength(prepares);
    expect(wallet.balance).toBe(895);
  });

  it("refuses before sending when the wallet cannot cover amount and fee, or Breez cannot prepare", async () => {
    const { provider, wallet } = await connect(phrase(), 101);
    await expect(provider.payInvoice(await invoiceOf(100), 10)).rejects.toThrow(/Not enough sats/);
    await expect(provider.payInvoice(await invoiceOf(100), 10)).rejects.toBeInstanceOf(NothingSpentError);
    // An invoice nobody on this network issued: the fake prepares it, but a broken prepare is caught too.
    vi.spyOn(wallet, "prepareSendPayment").mockRejectedValueOnce(new Error("no route"));
    await expect(provider.payInvoice(fakeInvoice(1, crypto.getRandomValues(new Uint8Array(32))), 10)).rejects.toBeInstanceOf(NothingSpentError);
    expect(wallet.calls).not.toContain("sendPayment");
    expect(wallet.balance).toBe(101);
  });

  it("refuses a prepared payment that is not this invoice", async () => {
    const { provider, wallet } = await connect(phrase(), 1_000);
    const invoice = await invoiceOf(100), other = await invoiceOf(100);
    const prepared = await wallet.prepareSendPayment({ paymentRequest: { type: "input", input: other } });
    vi.spyOn(wallet, "prepareSendPayment").mockResolvedValueOnce(prepared);
    await expect(provider.payInvoice(invoice, 10)).rejects.toThrow(/does not match/);
    expect(wallet.calls).not.toContain("sendPayment");
  });

  it("a lost answer is an unknown outcome, reconciled by the payment hash", async () => {
    const { provider, wallet } = await connect(phrase(), 1_000);
    const invoice = await invoiceOf(100), hash = decodeBolt11(invoice)!.paymentHash!;
    wallet.send = "throw";
    const error = await provider.payInvoice(invoice, 10).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NothingSpentError);
    expect(await provider.paymentStatus({ invoice, paymentHash: hash })).toMatchObject({ state: "paid", fee: 2 });
    // Asked to pay it again (a second device, a retry), it answers what happened and pays nothing more.
    wallet.send = "complete";
    expect(await provider.payInvoice(invoice, 10)).toMatchObject({ state: "paid" });
    expect(wallet.sent).toHaveLength(1);
    expect(wallet.balance).toBe(898);
  });

  it("in flight is pending, never failed; a failure is only said by the lookup, and then it can be paid again", async () => {
    const { provider, wallet } = await connect(phrase(), 1_000);
    const invoice = await invoiceOf(100), hash = decodeBolt11(invoice)!.paymentHash!;
    wallet.send = "pending";
    const pending = await provider.payInvoice(invoice, 10);
    expect(pending.state).toBe("pending");
    expect((await provider.paymentStatus({ invoice, paymentHash: hash, ref: pending.ref })).state).toBe("pending");
    wallet.fail(hash);
    expect((await provider.paymentStatus({ invoice, paymentHash: hash, ref: pending.ref })).state).toBe("failed");

    wallet.send = "fail";
    const failed = await provider.payInvoice(invoice, 10);
    expect(failed.state).toBe("pending");
    expect((await provider.paymentStatus({ invoice, paymentHash: hash, ref: failed.ref })).state).toBe("failed");

    wallet.send = "complete";
    expect((await provider.payInvoice(invoice, 10)).state).toBe("paid");
    // Asked with the ref of an attempt that failed, it answers for the invoice: paid by the last one.
    expect((await provider.paymentStatus({ invoice, paymentHash: hash, ref: failed.ref })).state).toBe("paid");
    expect(new Set(wallet.sent.map((s) => s.idempotencyKey)).size).toBe(3);
    expect(wallet.balance).toBe(898);
  });

  it("two payments of one invoice at once pay it once", async () => {
    const { provider, wallet } = await connect(phrase(), 1_000);
    const invoice = await invoiceOf(100);
    const results = await Promise.all([provider.payInvoice(invoice, 10), provider.payInvoice(invoice, 10)]);
    expect(results.map((r) => r.state)).toEqual(["paid", "paid"]);
    expect(wallet.balance).toBe(898);
  });

  it("with no record of a payment, it is pending until long after its invoice expired, then failed", async () => {
    const { provider, wallet } = await connect(phrase(), 1_000);
    const invoice = fakeInvoice(100, crypto.getRandomValues(new Uint8Array(32)), "", 60), hash = decodeBolt11(invoice)!.paymentHash!;
    expect((await provider.paymentStatus({ invoice, paymentHash: hash })).state).toBe("pending");
    expect(wallet.calls).toContain("syncWallet");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000 + 3600_000 + 1_000);
    expect((await provider.paymentStatus({ invoice, paymentHash: hash })).state).toBe("failed");
  });

  it("an invoice is open, then paid for the sats received, and expires unpaid", async () => {
    const { provider } = await connect();
    const invoice = await provider.createInvoice(21, "memo");
    expect(decodeBolt11(invoice.invoice)).toMatchObject({ network: "regtest", amountSat: 21, description: "memo" });
    expect(await provider.invoiceStatus(invoice)).toEqual({ state: "open" });
    net.payFromOutside(invoice.invoice);
    expect(await provider.invoiceStatus(invoice)).toEqual({ state: "paid", amount: 21 });
    expect((await provider.info()).balance).toBe(21);
    const unpaid = await provider.createInvoice(5);
    expect(await provider.invoiceStatus({ ...unpaid, expiresAt: Date.now() - 1 })).toEqual({ state: "expired" });
  });

  it("refuses to pay once closed, and says so as nothing spent", async () => {
    const { provider } = await connect(phrase(), 1_000);
    await provider.close();
    await expect(provider.payInvoice(await invoiceOf(10), 10)).rejects.toBeInstanceOf(NothingSpentError);
  });
});

describe("Breez as the engine's Lightning source", () => {
  beforeEach(async () => { await transact([STORES.settings], (s) => { s[STORES.settings].clear(); }); });

  it("seals the recovery phrase, and pays a contact's invoice through the journal", async () => {
    const events = { changed: vi.fn(), received: vi.fn(), resolved: vi.fn() } satisfies LightningEvents;
    const cashu = { view: async () => ({ balance: 0, mints: [], history: [], feesPaid: 0 }) } as unknown as CashuWallet;
    const descriptor = breezDescriptor(async () => net.sdk);
    const lightning = new LightningService(() => [cashuMint, descriptor], () => ({ platform: "extension", cashu }), events, CASHU_MINT_SOURCE);
    await lightning.start("testnet");
    const mnemonic = phrase();
    await lightning.sources.set(BREEZ_SOURCE, { mnemonic, apiKey: "" });
    expect(lightning.view).toMatchObject({ providerId: BREEZ_SOURCE, status: "ready", network: "regtest", secrets: ["mnemonic", "apiKey"] });
    const stored = JSON.stringify(await wrap((await store(STORES.settings, "readonly")).getAll()));
    for (const word of mnemonic.split(" ")) expect(stored).not.toMatch(new RegExp(`\\b${word}\\b`));
    net.wallets.get(breezStorage("regtest", mnemonic))!.balance = 500;

    const quote = await lightning.quote(await invoiceOf(50));
    expect(quote).toMatchObject({ amount: 50, feeReserve: 2, source: BREEZ_SOURCE });
    expect(await lightning.pay(quote.quote, { paymentId: "req-1" })).toBe(true);
    expect((await lightning.list()).find((op) => op.direction === "out")).toMatchObject({ state: "paid", fee: 2, providerId: BREEZ_SOURCE, mode: "testnet" });

    // Receiving: the invoice a chat request carries is seen paid by polling the source.
    const created = await lightning.createInvoice(30, { paymentId: "req-2" });
    net.payFromOutside(created.invoice);
    await lightning.reconcile();
    expect(events.received).toHaveBeenCalledWith(expect.objectContaining({ paymentId: "req-2", providerId: BREEZ_SOURCE }));
    await lightning.stop();
  });
});
