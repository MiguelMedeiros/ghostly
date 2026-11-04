import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ENDPOINT, ONCHAIN_PROVIDER, type GhostLink, type PaymentReview, type PaymentTarget } from "@ghostly/core";
import { PaymentDesk, RECEIPT_FRESH_MS } from "../src/engine/payments";
import type { CashuWallet } from "../src/engine/wallet";
import type { StoredPayment } from "../src/shared/types";
import { fakeAddress } from "../src/engine/paymentAdapters/providers/testing";
import { resetDb, seed } from "./fakes";
// covers: payments.bitcoin.send, payments.arkade.request, payments.bark.send, payments.usdt.send
vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);
beforeEach(() => resetDb());

/**
 * A chat's reconnect says our receipts again (on-chain, Ark, Bark, Spark, USDT: payments of ours already made) only
 * while the payee has not said the request they answer is paid. The payer and the payee are each a real PaymentDesk,
 * wired to each other through fake links; no wallet, mint or chain is reached.
 */

const DAY = 86_400_000;
const tx = (c: string) => c.repeat(64);
const RAILS = ["bitcoin", "arkade", "bark", "spark", "usdt"] as const;
type Rail = (typeof RAILS)[number];
const target = (method: Rail): PaymentTarget => method === "usdt"
  ? { method, network: "evm-local", chainId: 31337, asset: "TEST-USDT", unit: "token-base", decimals: 6, token: "0x" + "1".repeat(40), address: "0x" + "2".repeat(40), provider: "http://127.0.0.1:43210", issuedAt: 1, expiresAt: Date.now() + DAY }
  : { method, network: method === "bitcoin" ? "regtest" : method === "bark" ? "signet" : method === "spark" ? "regtest" : "mutinynet", provider: method === "bitcoin" ? ONCHAIN_PROVIDER : `https://${method}.example`, asset: "BTC", unit: "sat", address: method === "bitcoin" ? fakeAddress() : `t${method}1addr`, expiresAt: Date.now() + DAY };
const txidOf = (rail: Rail, n: number) => rail === "usdt" ? "0x" + tx(String(n % 10)) : rail === "spark" ? `spark-${n}` : tx(String(n % 10));
const unitOf = (rail: Rail) => rail === "usdt" ? "testusdt" : "sat";

/** One payment of ours to request `r-<rail>-<n>`, already made (settled), and our copy of that request, paid. */
function paid(rail: Rail, n: number, createdAt: number, extra: Partial<StoredPayment> = {}): StoredPayment[] {
  const requestId = `r-${rail}-${n}`;
  return [
    { id: requestId, linkId: "l", kind: "request", direction: "in", amount: 100, unit: unitOf(rail), state: "settled", createdAt: createdAt - 1, target: target(rail), ...extra },
    { id: `p-${rail}-${n}`, linkId: "l", kind: "payment", direction: "out", amount: 100, unit: unitOf(rail), state: "settled", createdAt, requestId, target: target(rail), txid: txidOf(rail, n) },
  ];
}
/** The payee's side of the same: its request, paid by its own wallet, and, when it heard it, our receipt. */
function owed(rail: Rail, n: number, createdAt: number, opts: { requestState?: "pending" | "settled"; heard?: boolean } = {}): StoredPayment[] {
  const requestId = `r-${rail}-${n}`;
  return [
    { id: requestId, linkId: "l", kind: "request", direction: "out", amount: 100, unit: unitOf(rail), state: opts.requestState ?? "settled", createdAt: createdAt - 1, target: target(rail) },
    ...(opts.heard === false ? [] : [{ id: `p-${rail}-${n}`, linkId: "l", kind: "payment" as const, direction: "in" as const, amount: 100, unit: unitOf(rail), state: opts.requestState ?? "settled", createdAt, requestId, target: target(rail), txid: txidOf(rail, n) }]),
  ];
}

type Frame = Record<string, unknown>;
function side() {
  const sent: { kind: "req" | "pay" | "res" | "ask"; frame: Frame }[] = [];
  const peer: { desk?: PaymentDesk } = {};
  const inFlight: Promise<unknown>[] = [];
  const link = {
    isDataLinkOpen: true, supportsPayments: true, supportsArkPayments: true, supportsBarkPayments: true, supportsBitcoinPayments: true, supportsSparkPayments: true, supportsUsdtPayments: true,
    requirePaymentSupport: vi.fn(async () => {}), allowsPayment: () => true, paymentEnabled: () => true,
    sendPaymentRequest: vi.fn(async (frame: Frame) => { sent.push({ kind: "req", frame }); }),
    sendPaymentAsk: vi.fn(async (frame: Frame) => { sent.push({ kind: "ask", frame }); }),
    // The other side's app, when there is one, takes the frame as its link would hand it over.
    sendPayment: vi.fn(async (frame: Frame) => { sent.push({ kind: "pay", frame }); if (peer.desk) inFlight.push(peer.desk.onPayment("l", frame as never)); }),
    sendPaymentResult: vi.fn((frame: Frame) => { sent.push({ kind: "res", frame }); if (peer.desk) inFlight.push(peer.desk.onPaymentResult("l", frame as never)); }),
  };
  const net = { online: true };
  const host = { getLink: () => (net.online ? link as unknown as GhostLink : null), storeMessage: vi.fn(async () => {}), onChange: vi.fn() };
  // The on-chain source: what it saw paid on an address (nothing until a test says).
  const chain: { seen?: { txid: string; confirmations: number } } = {};
  const bitcoin = { requestTarget: vi.fn(async () => target("bitcoin")), received: vi.fn(async () => chain.seen) };
  const desk = new PaymentDesk({} as CashuWallet, host, undefined, undefined, undefined, undefined, bitcoin);
  /** Until every frame either side sent was taken, answers included. */
  const settle = async () => { while (inFlight.length) await inFlight.shift(); };
  return { desk, sent, link, net, peer, settle, inFlight, chain };
}
/** A payer and a payee, each started from its own stored records, each the other's peer. */
async function pair(payerRows: StoredPayment[], payeeRows: StoredPayment[] | null) {
  seed("payments", payerRows as never);
  const payer = side();
  await payer.desk.start();
  resetDb();
  const payee = side();
  if (payeeRows) {
    seed("payments", payeeRows as never);
    await payee.desk.start();
    payer.peer.desk = payee.desk;
    payee.peer.desk = payer.desk;
  }
  const settle = async () => { while (payer.inFlight.length || payee.inFlight.length) { await payer.settle(); await payee.settle(); } };
  const reconnect = async () => { await payer.desk.replay("l"); await settle(); };
  const receipts = () => payer.sent.filter((s) => s.kind === "pay").length;
  return { payer, payee, reconnect, receipts, settle };
}

describe("receipts said again when a chat reconnects", () => {
  it("stop once the payee said the request is paid, on every rail", async () => {
    const old = Date.now() - 30 * DAY;
    const { payer, payee, reconnect, receipts } = await pair(RAILS.flatMap((r) => paid(r, 1, old)), RAILS.flatMap((r) => owed(r, 1, old)));
    await reconnect();
    expect(receipts(), "the first reconnect says each once").toBe(RAILS.length);
    const answers = payee.sent.filter((s) => s.kind === "res").map((s) => s.frame);
    expect(answers.sort((a, b) => String(a.id).localeCompare(String(b.id))), "a paid one is answered on every rail").toEqual(RAILS.map((r) => ({ id: `r-${r}-1`, ok: true })).sort((a, b) => a.id.localeCompare(b.id)));
    await reconnect();
    await reconnect();
    expect(receipts(), "nothing more after the payee's answer").toBe(RAILS.length);
    for (const r of RAILS) expect(payer.desk.payment(`r-${r}-1`), r).toMatchObject({ state: "settled", payeeConfirmed: true });
    expect(payee.sent.filter((s) => s.kind === "res")).toHaveLength(RAILS.length);
    // The next run of the app (a desk started from what was kept) says none of them either.
    const kept = payer.desk.records();
    resetDb();
    const next = await pair(kept, null);
    for (let i = 0; i < 3; i++) await next.reconnect();
    expect(next.receipts()).toBe(0);
  });

  it("a first receipt for a request the payee's wallet already saw paid is answered at once, on every rail", async () => {
    const recent = Date.now() - DAY;
    const { payer, payee, reconnect, receipts } = await pair(RAILS.flatMap((r) => paid(r, 1, recent)), RAILS.flatMap((r) => owed(r, 1, recent, { heard: false })));
    await reconnect();
    for (const r of RAILS) expect(payee.desk.payment(`p-${r}-1`), `${r}: the payee has it`).toMatchObject({ direction: "in", requestId: `r-${r}-1` });
    expect(payee.sent.filter((s) => s.kind === "res").map((s) => s.frame.id).sort()).toEqual(RAILS.map((r) => `r-${r}-1`).sort());
    for (const r of RAILS) expect(payer.desk.payment(`r-${r}-1`)?.payeeConfirmed, r).toBe(true);
    await reconnect();
    expect(receipts()).toBe(RAILS.length);
  });

  it("an Ark pay-res ok marks the request heard, and only on its own chat", async () => {
    const now = Date.now();
    const { payer, receipts, reconnect } = await pair([...paid("arkade", 1, now, { state: "pending" }), ...paid("arkade", 2, now)], null);
    await payer.desk.onPaymentResult("other", { id: "r-arkade-2", ok: true });
    expect(payer.desk.payment("r-arkade-2")?.payeeConfirmed, "another chat's answer").toBeUndefined();
    await payer.desk.onPaymentResult("l", { id: "r-arkade-2", ok: false, error: "no" });
    expect(payer.desk.payment("r-arkade-2")?.payeeConfirmed, "a refusal").toBeUndefined();
    await payer.desk.onPaymentResult("l", { id: "r-arkade-1", ok: true });
    await payer.desk.onPaymentResult("l", { id: "r-arkade-2", ok: true });
    expect(payer.desk.payment("r-arkade-1"), "a pending request is paid by it, as before").toMatchObject({ state: "settled", payeeConfirmed: true });
    expect(payer.desk.payment("r-arkade-2")).toMatchObject({ state: "settled", payeeConfirmed: true });
    await reconnect();
    expect(receipts()).toBe(0);
  });

  it("one the payee has not confirmed goes again: every reconnect for a week, then once per run of the app", async () => {
    const now = Date.now();
    const rows = RAILS.flatMap((r) => [...paid(r, 1, now - DAY), ...paid(r, 2, now - RECEIPT_FRESH_MS - DAY)]);
    // An app from before this change: it takes the receipts and says nothing back.
    const { payer, reconnect } = await pair(rows, null);
    for (let i = 0; i < 3; i++) await reconnect();
    const count = (sent: typeof payer.sent, n: number) => sent.filter((s) => s.kind === "pay" && String(s.frame.id).endsWith(`-${n}`)).length;
    expect(count(payer.sent, 1), "this week's: at every reconnect").toBe(3 * RAILS.length);
    expect(count(payer.sent, 2), "older ones: once in this run").toBe(RAILS.length);
    // The app starts again (the same records, a new desk): an older unconfirmed receipt goes once more.
    resetDb();
    const next = await pair(rows, null);
    for (let i = 0; i < 3; i++) await next.reconnect();
    expect(count(next.payer.sent, 2)).toBe(RAILS.length);
  });

  it("a payee whose request still waits for the money gets it again, and stops once its wallet saw it", async () => {
    const recent = Date.now() - DAY;
    const { payer, payee, reconnect, receipts, settle } = await pair(paid("bitcoin", 1, recent, { state: "pending" }), owed("bitcoin", 1, recent, { requestState: "pending" }));
    await reconnect();
    await reconnect();
    expect(receipts(), "this week's: at every reconnect while unconfirmed").toBe(2);
    expect(payee.sent.filter((s) => s.kind === "res"), "not paid yet: no answer").toEqual([]);
    expect(payer.desk.payment("r-bitcoin-1")?.payeeConfirmed).toBeUndefined();
    // The payee's wallet sees the transaction confirmed: its request settles and it says so.
    payee.chain.seen = { txid: txidOf("bitcoin", 1), confirmations: 1 };
    await payee.desk.reconcileBitcoinReceipts();
    await settle();
    expect(payee.desk.payment("r-bitcoin-1")?.state).toBe("settled");
    expect(payer.desk.payment("r-bitcoin-1")).toMatchObject({ state: "settled", payeeConfirmed: true });
    await reconnect();
    await reconnect();
    expect(receipts()).toBe(2);
  });

  it("a payee that was offline when we paid gets the receipt on its first reconnect, however long it was away", async () => {
    const rows: StoredPayment[] = [{ id: "r-bitcoin-1", linkId: "l", kind: "request", direction: "in", amount: 100, unit: "sat", state: "pending", createdAt: Date.now() - 1, target: target("bitcoin") }];
    const { payer, payee, reconnect, receipts } = await pair(rows, owed("bitcoin", 1, Date.now(), { requestState: "pending", heard: false }));
    payer.net.online = false;
    const review: PaymentReview = { ...target("bitcoin"), id: "p-bitcoin-1", linkId: "l", requestId: "r-bitcoin-1", payee: "bob", amount: 100, fee: 1, feeCap: 10, createdAt: Date.now(), state: "settled", txid: txidOf("bitcoin", 1) };
    await payer.desk.recordBitcoin(review);
    expect(receipts(), "nobody to tell").toBe(0);
    // Back 60 days later.
    const later = Date.now() + 60 * DAY;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => later);
    onTestFinished(() => { clock.mockRestore(); });
    payer.net.online = true;
    await reconnect();
    expect(receipts()).toBe(1);
    expect(payee.desk.payment("p-bitcoin-1"), "the payee has it").toMatchObject({ kind: "payment", direction: "in", requestId: "r-bitcoin-1", txid: txidOf("bitcoin", 1) });
    expect(payer.sent.find((s) => s.kind === "pay")?.frame.endpoint).toEqual([ENDPOINT.bitcoin, JSON.stringify({ txid: txidOf("bitcoin", 1) })]);
  });

  it.each([["older than a week", 30 * DAY, 1_000], ["of this week", DAY, 3_000]] as const)("a long history: 1,000 settled on-chain payments %s and 3 reconnects", async (_, age, silent) => {
    const at = Date.now() - age;
    const rows = Array.from({ length: 1_000 }, (_, n) => paid("bitcoin", n, at - n)).flat();
    const payees = Array.from({ length: 1_000 }, (_, n) => owed("bitcoin", n, at - n)).flat();
    const older = await pair(rows, null);
    for (let i = 0; i < 3; i++) await older.reconnect();
    expect(older.receipts(), "to an older payee app that never answers").toBe(silent);
    resetDb();
    const now = await pair(rows, payees);
    for (let i = 0; i < 3; i++) await now.reconnect();
    expect(now.receipts(), "to a payee that answers: once, then never").toBe(1_000);
    expect(now.payee.sent.filter((s) => s.kind === "res")).toHaveLength(1_000);
    const kept = now.payer.desk.records();
    resetDb();
    const next = await pair(kept, null);
    for (let i = 0; i < 3; i++) await next.reconnect();
    expect(next.receipts(), "nor in the next run").toBe(0);
  });
});
