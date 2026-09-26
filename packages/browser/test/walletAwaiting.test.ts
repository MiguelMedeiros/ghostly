import { describe, expect, it } from "vitest";
import { ONCHAIN_PROVIDER, type PaymentTarget } from "@ghostly/core";
import { walletAwaiting, type AwaitingSources } from "../src/engine/walletAwaiting";
import type { LightningOp } from "../src/engine/paymentAdapters/providers/lightningService";
import type { StoredPayment, StoredQuote } from "../src/shared/types";
import { removalRisksFunds, walletRemoval } from "../src/shared/walletRemoval";
// covers: wallet.instances.remove

// What a wallet still waits for, read before it is removed: money paid to any of it afterwards would be lost.
const NOW = 1_800_000_000_000;
const REAL = "https://mint.real.example", OTHER = "https://mint.other.example";
const quote = (extra: Partial<StoredQuote> & { quote: string }): StoredQuote => ({ mint: REAL, amount: 50_000, invoice: `lnbc-${extra.quote}`, createdAt: NOW - 1_000, expiresAt: NOW + 3_600_000, ...extra });
const request = (extra: Partial<StoredPayment> & { id: string }): StoredPayment => ({ linkId: "chat", kind: "request", direction: "out", amount: 50_000, unit: "sat", state: "pending", createdAt: NOW - 1_000, network: "mainnet", ...extra });
const op = (extra: Partial<LightningOp> & { paymentHash: string }): LightningOp => ({ direction: "in", providerId: "lnd", mode: "mainnet", invoice: `lnbc-${extra.paymentHash}`, amount: 2_000, expiresAt: NOW + 3_600_000, createdAt: NOW - 1_000, state: "open", ...extra });
const ark = (): PaymentTarget => ({ method: "arkade", network: "bitcoin", provider: "https://arkade.computer", asset: "BTC", unit: "sat", address: "ark1me", expiresAt: NOW + 900_000 });
const btc = (): PaymentTarget => ({ method: "bitcoin", network: "bitcoin", provider: ONCHAIN_PROVIDER, asset: "BTC", unit: "sat", address: "bc1qme", expiresAt: NOW + 900_000 });

const read = (extra: Partial<AwaitingSources>) => walletAwaiting({ network: "mainnet", mints: [REAL], quotes: [], lightningOps: [], lightningSource: "cashu-mint", payments: [], now: NOW, ...extra });

describe("what a wallet still waits for", () => {
  it("Cashu: an open invoice, a paid one not claimed yet, and one the mint issued but never reached this wallet; not expired, test-coin or other mints' quotes", () => {
    const awaiting = read({ quotes: [
      quote({ quote: "open" }),
      quote({ quote: "paid", paid: true, amount: 700 }),
      quote({ quote: "issued", issuedUnclaimed: true, amount: 300, expiresAt: NOW - 3_600_000 }),
      quote({ quote: "expired", expiresAt: NOW - 120_000 }),
      quote({ quote: "coins", testCoins: true }),
      quote({ quote: "elsewhere", mint: OTHER }),
    ] });
    expect(awaiting).toEqual([
      { type: "cashu", kind: "paid", amount: 700 },
      { type: "cashu", kind: "unclaimed", amount: 300 },
      { type: "cashu", kind: "invoice", amount: 50_000 },
    ]);
  });

  it("a chat request whose invoice is a Cashu quote is one request, not a request and an invoice; once paid it is the paid quote", () => {
    const quotes = [quote({ quote: "q1", paymentId: "r1" })];
    expect(read({ quotes, payments: [request({ id: "r1", invoice: "LNBC-Q1", mints: [REAL] })] })).toEqual([{ type: "cashu", kind: "request", amount: 50_000, paymentId: "r1" }]);
    expect(read({ quotes: [{ ...quotes[0], paid: true }], payments: [request({ id: "r1", invoice: "lnbc-q1" })] })).toEqual([{ type: "cashu", kind: "paid", amount: 50_000, paymentId: "r1" }]);
  });

  it("a request counts for the one wallet it can be paid through: an invoice of another Lightning source with Cashu mints is lost with neither", () => {
    const lightningOps = [op({ paymentHash: "h1", paymentId: "r1", amount: 50_000 })];
    expect(read({ lightningOps, lightningSource: "lnd", payments: [request({ id: "r1", invoice: "lnbc-h1", mints: [REAL] })] })).toEqual([]);
    expect(read({ lightningOps, lightningSource: "lnd", payments: [request({ id: "r1", invoice: "lnbc-h1" })] })).toEqual([{ type: "lightning", kind: "request", amount: 50_000, paymentId: "r1" }]);
    // Once the Cashu wallet is gone its mints are not the network's: only the Lightning source is left.
    expect(read({ mints: [], lightningOps, lightningSource: "lnd", payments: [request({ id: "r1", invoice: "lnbc-h1", mints: [REAL] })] })).toEqual([{ type: "lightning", kind: "request", amount: 50_000, paymentId: "r1" }]);
  });

  it("requests on the other rails go with their wallet; only open requests of ours on this network count", () => {
    const awaiting = read({ payments: [
      request({ id: "ark", target: ark() }),
      request({ id: "chain", target: btc() }),
      request({ id: "fed", federations: ["f1"] }),
      request({ id: "paid", target: ark(), state: "settled" }),
      request({ id: "closed", target: ark(), state: "failed", closed: true }),
      request({ id: "theirs", target: ark(), direction: "in" }),
      request({ id: "test", target: { ...ark(), network: "mutinynet" }, network: "testnet" }),
    ] });
    expect(awaiting.map((a) => [a.type, a.paymentId])).toEqual([["arkade", "ark"], ["bitcoin", "chain"], ["fedimint", "fed"]]);
  });

  it("invoices of another Lightning source; its own journal decides, the Cashu mints' invoices are the Cashu wallet's", () => {
    const awaiting = read({ lightningSource: "lnd", lightningOps: [
      op({ paymentHash: "open" }),
      op({ paymentHash: "paid", state: "paid" }),
      op({ paymentHash: "old", expiresAt: NOW - 120_000 }),
      op({ paymentHash: "mints", providerId: "cashu-mint", selfSettled: true }),
      op({ paymentHash: "test", mode: "testnet" }),
    ] });
    expect(awaiting).toEqual([{ type: "lightning", kind: "invoice", amount: 2_000 }]);
  });

  it("ecash sent and not taken yet: Cashu at this network's mints, Fedimint notes", () => {
    const awaiting = read({ payments: [
      request({ id: "cashu", kind: "payment", mint: REAL, token: "cashuB..." }),
      request({ id: "other-mint", kind: "payment", mint: OTHER, token: "cashuB..." }),
      request({ id: "taken", kind: "payment", mint: REAL, state: "settled" }),
      request({ id: "notes", kind: "payment", federation: "f1", token: "notes", target: { ...ark(), method: "fedimint", network: "bitcoin" } }),
    ] });
    expect(awaiting.map((a) => [a.type, a.kind, a.paymentId])).toEqual([["cashu", "sent", "cashu"], ["fedimint", "sent", "notes"]]);
  });
});

describe("removing a wallet that still waits for money", () => {
  it("needs the person's confirmation even when it holds nothing, and lists what it waits for in words", () => {
    const awaiting = read({ quotes: [quote({ quote: "q1", paymentId: "r1" }), quote({ quote: "paid", paid: true, amount: 700 })], payments: [request({ id: "r1", invoice: "lnbc-q1" })] });
    const removal = walletRemoval("cashu", "mainnet", { balance: 0, awaiting });
    expect(removal.held).toEqual({ empty: true, text: "0 sats" });
    expect(removal.awaiting.map((i) => i.text)).toEqual(["700 sats paid to an invoice, not claimed from the mint yet", "A request for 50,000 sats in a chat, still open"]);
    expect(removalRisksFunds(removal)).toBe(true);
    expect(removalRisksFunds(walletRemoval("cashu", "mainnet", { balance: 0, awaiting: [] }))).toBe(false);
  });

  it("Cashu sent and not taken is not lost: it is listed apart and needs no confirmation", () => {
    const removal = walletRemoval("cashu", "testnet", { balance: 0, awaiting: [{ type: "cashu", kind: "sent", amount: 21, paymentId: "p1" }] });
    expect(removal.awaiting).toEqual([]);
    expect(removal.returnable).toEqual([{ kind: "sent", text: "21 test sats in ecash you sent, not taken yet", amount: "21 test sats", paymentId: "p1" }]);
    expect(removalRisksFunds(removal)).toBe(false);
  });

  it("only its own: another wallet's requests are not listed; a source whose money is elsewhere lists them but asks nothing", () => {
    const awaiting = [{ type: "arkade" as const, kind: "request" as const, amount: 5, paymentId: "a" }, { type: "lightning" as const, kind: "request" as const, amount: 9, paymentId: "l" }];
    expect(walletRemoval("bark", "mainnet", { awaiting, bark: { configured: true, locked: false, balance: 0 } as never }).awaiting).toEqual([]);
    const lnd = walletRemoval("lightning", "mainnet", { awaiting, lightning: { providerId: "lnd", status: "ready", balance: 0 } as never });
    expect(lnd.awaiting.map((i) => i.paymentId)).toEqual(["l"]);
    expect(removalRisksFunds(lnd)).toBe(false);
  });
});
