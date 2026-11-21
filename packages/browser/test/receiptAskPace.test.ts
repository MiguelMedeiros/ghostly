import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINT, type GhostLink, type PaymentTarget } from "@ghostly/core";
import { PaymentDesk } from "../src/engine/payments";
import type { CashuWallet } from "../src/engine/wallet";
import type { ArkWallet } from "../src/engine/paymentAdapters/arkWallet";
import type { UsdtWallet } from "../src/engine/paymentAdapters/usdtWallet";
import type { StoredMessage, StoredPayment } from "../src/shared/types";
import { resetDb, rows, seed } from "./fakes";
// covers: payments.arkade.request, payments.usdt.send

vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);

/**
 * An open Ark request and a contact's pending Ark or USDT receipt are asked about at each wallet refresh (every 10 s,
 * every 8 s) only when their turn came: at the wallet's pace while new, then less and less, never more than every
 * 30 minutes. A refresh that read new money (or a receipt, a check, a removal) asks about every one at once.
 */

const ARK = "https://mutinynet.arkade.sh";
const START = Date.UTC(2026, 10, 9, 12);
const tx = (c: string) => c.repeat(64);
const ark = (address: string, expiresAt = START + 15 * 60_000): PaymentTarget => ({ method: "arkade", network: "mutinynet", provider: ARK, asset: "BTC", unit: "sat", address, expiresAt });
const usdt = (): PaymentTarget => ({ method: "usdt", network: "evm-local", chainId: 31337, asset: "TEST-USDT", unit: "token-base", decimals: 6, token: "0x" + "1".repeat(40), address: "0x" + "2".repeat(40), provider: "http://127.0.0.1:43210", issuedAt: START, expiresAt: START + 3_600_000 });
const request = (id: string, extra: Partial<StoredPayment> = {}): StoredPayment => ({ id, linkId: "l", kind: "request", direction: "out", amount: 100, unit: "sat", state: "pending", createdAt: START, target: ark(`tark1${id}`), ...extra });

beforeEach(() => { resetDb(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(START); });
afterEach(() => vi.useRealTimers());

function setup(stored: StoredPayment[]) {
  seed("payments", stored as unknown as Record<string, unknown>[]);
  const link = { supportsArkPayments: true, supportsUsdtPayments: true, sendPaymentResult: vi.fn() };
  const host = { getLink: vi.fn(() => link as unknown as GhostLink), storeMessage: vi.fn(async (_m: StoredMessage) => {}), onChange: vi.fn() };
  const received = vi.fn(async (_address: string, _amount: number, _since: number, _claimed: ReadonlySet<string>): Promise<string | undefined> => undefined);
  const verifyReceipt = vi.fn(async (_txid: string, _address: string, _amount: number) => false);
  const arkWallet = { adapter: { config: { provider: ARK, network: "mutinynet" }, received, verifyReceipt } };
  const receipt = vi.fn(async (): Promise<{ settled?: boolean; failed?: boolean; pending?: boolean }> => ({ settled: false }));
  const usdtWallet = { adapter: { receipt } };
  const desk = new PaymentDesk({} as CashuWallet, host, arkWallet as unknown as ArkWallet, usdtWallet as unknown as UsdtWallet);
  const state = (id: string) => rows<StoredPayment>("payments").find((p) => p.id === id)?.state;
  return { desk, received, verifyReceipt, receipt, state };
}

/** The wallet's refresh every `every` ms for `forMs`, each tick a paced pass (a read with nothing new). */
async function ticks(pass: () => Promise<void>, every: number, forMs: number, stop?: () => boolean) {
  for (let t = 0; t < forMs; t += every) {
    await pass();
    if (stop?.()) return;
    vi.setSystemTime(Date.now() + every);
  }
}

describe("open Ark requests", () => {
  it("5 unpaid requests (one long expired) cost about 20 indexer reads each over an hour of refreshes, not 360", async () => {
    const open = [request("r1"), request("r2"), request("r3"), request("r4"), request("r0", { createdAt: START - 2 * 3_600_000, target: ark("tark1r0", START - 3_600_000) })];
    const { desk, received } = setup(open);
    await desk.start();
    await ticks(() => desk.reconcileArkReceipts(true), 10_000, 3_600_000);
    const per = (id: string) => received.mock.calls.filter(([address]) => address === `tark1${id}`).length;
    // Fresh: every refresh for its first 2 minutes (13), then 20, 40, 80 ... s up to 30 min apart (7 more).
    expect(per("r1"), "a fresh request").toBe(20);
    // Expired at the start: asked at once, then 10, 20, 40 ... s apart.
    expect(per("r0"), "an expired request").toBeLessThanOrEqual(10);
    expect(received).toHaveBeenCalledTimes(4 * 20 + per("r0"));
  });

  it("money on a fresh request's address is seen at the next refresh", async () => {
    const { desk, received, state } = setup([request("r1")]);
    await desk.start();
    await ticks(() => desk.reconcileArkReceipts(true), 10_000, 60_000);
    received.mockResolvedValue(tx("a"));
    await ticks(() => desk.reconcileArkReceipts(true), 10_000, 10_000);
    expect(state("r1")).toBe("settled");
  });

  it("money that lands late on an expired request is still seen: at once on a read with news, within 30 minutes without", async () => {
    const { desk, received, state } = setup([request("r1"), request("r2")]);
    await desk.start();
    await ticks(() => desk.reconcileArkReceipts(true), 10_000, 3_600_000);
    received.mockClear();
    received.mockImplementation(async (address) => address === "tark1r1" ? tx("a") : address === "tark1r2" ? tx("b") : undefined);
    // A refresh that read new money (the balance moved) asks about every open request at once, whatever their pace.
    await desk.reconcileArkReceipts();
    expect([state("r1"), state("r2")]).toEqual(["settled", "settled"]);
    expect(received).toHaveBeenCalledTimes(2);
  });

  it("a late payment seen by the paced refreshes alone, within the 30-minute cap", async () => {
    const { desk, received, state } = setup([request("r1")]);
    await desk.start();
    await ticks(() => desk.reconcileArkReceipts(true), 10_000, 3_600_000);
    received.mockResolvedValue(tx("a"));
    const before = Date.now();
    await ticks(() => desk.reconcileArkReceipts(true), 10_000, 3_600_000, () => state("r1") === "settled");
    expect(state("r1")).toBe("settled");
    expect(Date.now() - before).toBeLessThanOrEqual(30 * 60_000);
  });

  it("the money of a paid request is claimed for the others, read once per pass", async () => {
    const { desk, received } = setup([request("r1"), request("r2"), request("paid", { state: "settled", txid: tx("f") })]);
    await desk.start();
    received.mockImplementation(async (address) => address === "tark1r1" ? tx("a") : undefined);
    await desk.reconcileArkReceipts();
    const claimed = Object.fromEntries(received.mock.calls.map(([address, , , set]) => [address, [...set].sort()]));
    expect(claimed).toEqual({ tark1r1: [tx("f")], tark1r2: [tx("a"), tx("f")] });
  });

  it("a contact's receipt the server does not show is asked less and less, and settles once it does", async () => {
    const payment: StoredPayment = { id: "p", linkId: "l", kind: "payment", direction: "in", amount: 100, unit: "sat", state: "pending", createdAt: START, target: ark("tark1r1"), requestId: "r1", txid: tx("a") };
    const { desk, verifyReceipt, received, state } = setup([request("r1"), payment]);
    await desk.start();
    await ticks(() => desk.reconcileArkReceipts(true), 10_000, 3_600_000);
    expect(verifyReceipt.mock.calls.length, "about 10, not 360").toBeLessThanOrEqual(10);
    verifyReceipt.mockResolvedValue(true);
    await desk.reconcileArkReceipts();
    expect([state("p"), state("r1")]).toEqual(["settled", "settled"]);
    expect(received).toHaveBeenCalled();
  });
});

describe("pending USDT receipts", () => {
  const usdtRequest = (): StoredPayment => ({ id: "r", linkId: "l", kind: "request", direction: "out", amount: 2_000_000, unit: "testusdt", state: "pending", createdAt: START, target: usdt() });
  const pay = (desk: PaymentDesk) => desk.onPayment("l", { id: "p", requestId: "r", timestamp: START, amount: { value: "2000000", asset: "testusdt" }, endpoint: [ENDPOINT.usdt, JSON.stringify({ txid: "0x" + "a".repeat(64) })] });

  it("a transaction that never lands is read about 7 times in 10 minutes of 8 s refreshes, not 75", async () => {
    const { desk, receipt, state } = setup([usdtRequest()]);
    await desk.start();
    await pay(desk);
    receipt.mockClear();
    await ticks(() => desk.reconcileUsdtReceipts(true), 8_000, 10 * 60_000);
    expect(receipt.mock.calls.length).toBeLessThanOrEqual(7);
    expect(state("p")).toBe("pending");
    // A read with news (the balance moved) asks at once, and the receipt that landed settles.
    receipt.mockResolvedValue({ settled: true });
    await desk.reconcileUsdtReceipts();
    expect([state("p"), state("r")]).toEqual(["settled", "settled"]);
  });

  it("a transaction seen confirming is read at every refresh until it settles", async () => {
    const { desk, receipt, state } = setup([usdtRequest()]);
    receipt.mockResolvedValue({ settled: false, pending: true });
    await desk.start();
    await pay(desk);
    receipt.mockClear();
    let left = 5;
    receipt.mockImplementation(async () => (left-- > 0 ? { settled: false, pending: true } : { settled: true }));
    await ticks(() => desk.reconcileUsdtReceipts(true), 8_000, 60_000, () => state("p") === "settled");
    expect(receipt).toHaveBeenCalledTimes(6);
    expect([state("p"), state("r")]).toEqual(["settled", "settled"]);
  });
});
