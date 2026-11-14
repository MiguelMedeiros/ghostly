import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPARK_PROVIDER, type GhostLink, type PaymentTarget } from "@ghostly/core";
import { PaymentDesk, type DeskSpark } from "../src/engine/payments";
import type { CashuWallet } from "../src/engine/wallet";
import type { BarkWallet } from "../src/engine/paymentAdapters/barkWallet";
import type { StoredMessage, StoredPayment } from "../src/shared/types";
import { resetDb, rows, seed } from "./fakes";
// covers: payments.bark.offer, payments.spark.offer

vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);

/**
 * An open Bark or Spark request is asked about at each wallet refresh (every 10 s) only when its turn came, as an Ark
 * one: at the wallet's pace while new, then less and less, never more than every 30 minutes. A pass with no request
 * due asks the server nothing (no sync). A refresh that read new money (or a receipt, a check, a removal) asks about
 * every one at once.
 */

const BARK = "https://ark.signet.2nd.dev";
const START = Date.UTC(2026, 10, 13, 12);
const tx = (c: string) => c.repeat(64);
const HOUR = 3_600_000;

beforeEach(() => { resetDb(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(START); });
afterEach(() => vi.useRealTimers());

/** The wallet's refresh every 10 s for `forMs`, each tick a paced pass (a read with nothing new). */
async function ticks(pass: () => Promise<void>, forMs: number, stop?: () => boolean) {
  for (let t = 0; t < forMs; t += 10_000) {
    await pass();
    if (stop?.()) return;
    vi.setSystemTime(Date.now() + 10_000);
  }
}

const host = () => {
  const link = { supportsBarkPayments: true, supportsSparkPayments: true, sendPaymentResult: vi.fn() };
  return { getLink: vi.fn(() => link as unknown as GhostLink), storeMessage: vi.fn(async (_m: StoredMessage) => {}), onChange: vi.fn() };
};
const state = (id: string) => rows<StoredPayment>("payments").find((p) => p.id === id)?.state;

function barkSetup(stored: StoredPayment[]) {
  seed("payments", stored as unknown as Record<string, unknown>[]);
  const received = vi.fn((_address: string, _amount: number, _since: number, _claimed?: ReadonlySet<string>): string | undefined => undefined);
  const adapter = { config: { provider: BARK, network: "signet" }, receipts: vi.fn(async () => received), sync: vi.fn(async () => {}) };
  const testnet = { network: "testnet", configured: true, adapter };
  const mainnet = { network: "mainnet", configured: false, adapter: undefined };
  const desk = new PaymentDesk({} as CashuWallet, host(), undefined, undefined, { mainnet: mainnet as unknown as BarkWallet, testnet: testnet as unknown as BarkWallet });
  return { desk, received, adapter };
}
const bark = (address: string, expiresAt = START + 15 * 60_000): PaymentTarget => ({ method: "bark", network: "signet", provider: BARK, asset: "BTC", unit: "sat", address, expiresAt });
const barkRequest = (id: string, extra: Partial<StoredPayment> = {}): StoredPayment => ({ id, linkId: "l", kind: "request", direction: "out", amount: 100, unit: "sat", state: "pending", createdAt: START, target: bark(`tark1${id}`), ...extra });

function sparkSetup(stored: StoredPayment[]) {
  seed("payments", stored as unknown as Record<string, unknown>[]);
  const received = vi.fn(async (_target: PaymentTarget, _amount: number, _since: number, _claimed: ReadonlySet<string>): Promise<string | undefined> => undefined);
  const spark: DeskSpark = { ready: () => true, requestTarget: vi.fn(), received, sync: vi.fn(async () => {}) };
  const desk = new PaymentDesk({} as CashuWallet, host(), undefined, undefined, undefined, undefined, undefined, undefined, spark);
  return { desk, received, spark };
}
const spark = (address: string, expiresAt = START + 15 * 60_000): PaymentTarget => ({ method: "spark", network: "regtest", provider: SPARK_PROVIDER, asset: "BTC", unit: "sat", address, expiresAt });
const sparkRequest = (id: string, extra: Partial<StoredPayment> = {}): StoredPayment => ({ id, linkId: "l", kind: "request", direction: "out", amount: 100, unit: "sat", state: "pending", createdAt: START, target: spark(`sparkrt1${id}`), ...extra });

describe("open Bark requests", () => {
  it("5 unpaid requests (one long expired) cost about 20 looks each and as few server syncs over an hour of refreshes, not 360", async () => {
    const open = [barkRequest("r1"), barkRequest("r2"), barkRequest("r3"), barkRequest("r4"), barkRequest("r0", { createdAt: START - 2 * HOUR, target: bark("tark1r0", START - HOUR) })];
    const { desk, received, adapter } = barkSetup(open);
    await desk.start();
    await ticks(() => desk.reconcileBarkReceipts(true), HOUR);
    const per = (id: string) => received.mock.calls.filter(([address]) => address === `tark1${id}`).length;
    // Fresh: every refresh for its first 2 minutes (13), then 20, 40, 80 ... s up to 30 min apart (7 more).
    expect(per("r1"), "a fresh request").toBe(20);
    expect(per("r0"), "an expired request").toBeLessThanOrEqual(10);
    // A pass syncs only when a request's turn came: the fresh ones' 20 and the expired one's few, not 360.
    expect(adapter.sync.mock.calls.length).toBeLessThanOrEqual(20 + per("r0"));
    expect(adapter.receipts).toHaveBeenCalledTimes(adapter.sync.mock.calls.length);
  });

  it("money on a fresh request's address is seen at the next refresh", async () => {
    const { desk, received } = barkSetup([barkRequest("r1")]);
    await desk.start();
    await ticks(() => desk.reconcileBarkReceipts(true), 60_000);
    received.mockReturnValue(tx("a"));
    await ticks(() => desk.reconcileBarkReceipts(true), 10_000);
    expect(state("r1")).toBe("settled");
  });

  it("money that lands late is still seen: at once on a pass with news, within 30 minutes without", async () => {
    const { desk, received } = barkSetup([barkRequest("r1"), barkRequest("r2")]);
    await desk.start();
    await ticks(() => desk.reconcileBarkReceipts(true), HOUR);
    received.mockImplementation((address) => address === "tark1r1" ? tx("a") : undefined);
    await desk.reconcileBarkReceipts();
    expect(state("r1")).toBe("settled");
    received.mockImplementation((address) => address === "tark1r2" ? tx("b") : undefined);
    const before = Date.now();
    await ticks(() => desk.reconcileBarkReceipts(true), HOUR, () => state("r2") === "settled");
    expect(state("r2")).toBe("settled");
    expect(Date.now() - before).toBeLessThanOrEqual(30 * 60_000);
  });

  it("the money of a paid request is claimed for the others, read once per pass", async () => {
    const { desk, received } = barkSetup([barkRequest("r1"), barkRequest("r2"), barkRequest("paid", { state: "settled", txid: tx("f") })]);
    await desk.start();
    const claimed: Record<string, string[]> = {};
    received.mockImplementation((address, _amount, _since, set) => { claimed[address] = [...set!].sort(); return address === "tark1r1" ? tx("a") : undefined; });
    await desk.reconcileBarkReceipts();
    expect(claimed).toEqual({ tark1r1: [tx("f")], tark1r2: [tx("a"), tx("f")] });
  });
});

describe("open Spark requests", () => {
  it("5 unpaid requests (one long expired) cost about 20 looks each and as few syncs over an hour of refreshes, not 360", async () => {
    const open = [sparkRequest("r1"), sparkRequest("r2"), sparkRequest("r3"), sparkRequest("r4"), sparkRequest("r0", { createdAt: START - 2 * HOUR, target: spark("sparkrt1r0", START - HOUR) })];
    const { desk, received, spark: wallet } = sparkSetup(open);
    await desk.start();
    await ticks(() => desk.reconcileSparkReceipts(true), HOUR);
    const per = (id: string) => received.mock.calls.filter(([target]) => target.address === `sparkrt1${id}`).length;
    expect(per("r1"), "a fresh request").toBe(20);
    expect(per("r0"), "an expired request").toBeLessThanOrEqual(10);
    expect((wallet.sync as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(20 + per("r0"));
  });

  it("money that lands late is still seen: at once on a pass with news, within 30 minutes without", async () => {
    const { desk, received } = sparkSetup([sparkRequest("r1"), sparkRequest("r2")]);
    await desk.start();
    await ticks(() => desk.reconcileSparkReceipts(true), HOUR);
    received.mockImplementation(async (target) => target.address === "sparkrt1r1" ? "t1" : undefined);
    await desk.reconcileSparkReceipts();
    expect(state("r1")).toBe("settled");
    received.mockImplementation(async (target) => target.address === "sparkrt1r2" ? "t2" : undefined);
    const before = Date.now();
    await ticks(() => desk.reconcileSparkReceipts(true), HOUR, () => state("r2") === "settled");
    expect(state("r2")).toBe("settled");
    expect(Date.now() - before).toBeLessThanOrEqual(30 * 60_000);
  });

  it("the transfer of a paid request is claimed for the others, read once per pass", async () => {
    const { desk, received } = sparkSetup([sparkRequest("r1"), sparkRequest("r2"), sparkRequest("paid", { state: "settled", txid: "tf" })]);
    await desk.start();
    const claimed: Record<string, string[]> = {};
    received.mockImplementation(async (target, _amount, _since, set) => { claimed[target.address] = [...set].sort(); return target.address === "sparkrt1r1" ? "ta" : undefined; });
    await desk.reconcileSparkReceipts();
    expect(claimed).toEqual({ sparkrt1r1: ["tf"], sparkrt1r2: ["ta", "tf"] });
  });
});
