import { beforeEach, expect, it, vi } from "vitest";
import { ENDPOINT, SPARK_PROVIDER, type GhostLink, type PaymentTarget } from "@ghostly/core";
import { bech32m } from "@scure/base";
import { PaymentDesk, type DeskSpark } from "../src/engine/payments";
import type { CashuWallet } from "../src/engine/wallet";
import type { StoredPayment } from "../src/shared/types";
import { resetDb, rows, seed } from "./fakes";
// covers: payments.spark.offer, payments.spark.send
vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);
beforeEach(() => resetDb());

const key = () => Uint8Array.from([0x03, ...crypto.getRandomValues(new Uint8Array(32))]);
const PAYEE = key();
/** A Spark address (the wallet's identity) and invoices (that identity plus an id), in their real format. */
const address = (k = PAYEE) => bech32m.encode("sparkrt", bech32m.toWords(Uint8Array.from([0x0a, 0x21, ...k])), 1024);
const varint = (n: number) => { const out: number[] = []; do { out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); n = Math.floor(n / 128); } while (n); return out; };
/** An invoice for `amount` sats (SparkInvoiceFields: 2 id, 4 sats payment). */
const invoice = (amount = 500, k = PAYEE) => {
  const sats = [0x08, ...varint(amount)];
  const fields = [0x12, 0x10, ...crypto.getRandomValues(new Uint8Array(16)), 0x22, sats.length, ...sats];
  return bech32m.encode("sparkrt", bech32m.toWords(Uint8Array.from([0x0a, 0x21, ...k, 0x12, fields.length, ...fields])), 1024);
};
const target = (to = invoice()): PaymentTarget => ({ method: "spark", network: "regtest", provider: SPARK_PROVIDER, asset: "BTC", unit: "sat", address: to, expiresAt: Date.now() + 60_000 });

function setup(opts: { spark?: boolean; ready?: boolean; received?: DeskSpark["received"] } = {}) {
  const sent: { kind: string; frame: Record<string, unknown> }[] = [];
  const link = {
    requirePaymentSupport: vi.fn(async () => {}), supportsSparkPayments: opts.spark ?? true, supportsBarkPayments: true, supportsArkPayments: true, supportsUsdtPayments: true, supportsBitcoinPayments: true,
    allowsPayment: () => true, supportsPayments: true, isDataLinkOpen: true,
    sendPaymentRequest: vi.fn(async (frame: Record<string, unknown>) => { sent.push({ kind: "req", frame }); }),
    sendPaymentAsk: vi.fn(async (frame: Record<string, unknown>) => { sent.push({ kind: "ask", frame }); }),
    sendPayment: vi.fn(async (frame: Record<string, unknown>) => { sent.push({ kind: "pay", frame }); }),
    sendPaymentResult: vi.fn((frame: Record<string, unknown>) => { sent.push({ kind: "res", frame }); }),
  };
  const received = vi.fn(opts.received ?? (async () => undefined));
  const spark: DeskSpark = {
    ready: () => opts.ready ?? true,
    requestTarget: vi.fn(async (amount: number) => target(invoice(amount))),
    received, sync: vi.fn(async () => {}),
  };
  const host = { getLink: () => link as unknown as GhostLink, storeMessage: vi.fn(), onChange: vi.fn() };
  return { desk: new PaymentDesk({} as CashuWallet, host, undefined, undefined, undefined, undefined, undefined, undefined, spark), sent, link, spark, received, host };
}

it("a Spark request carries an invoice made for it, under the Spark endpoint, and needs Spark on both sides", async () => {
  const { desk, sent, spark, host } = setup();
  await desk.start();
  await desk.request({ linkId: "l", amount: 1_500, timestamp: 1, method: "spark", memo: "lunch" });
  await desk.request({ linkId: "l", amount: 700, timestamp: 2, method: "spark" });
  expect(spark.requestTarget).toHaveBeenNthCalledWith(1, 1_500, "lunch");
  const endpoints = sent.map((s) => s.frame.endpoints as [string, string][]);
  expect(endpoints.map((e) => e[0][0])).toEqual([ENDPOINT.spark, ENDPOINT.spark]);
  expect(new Set(endpoints.map((e) => JSON.parse(e[0][1]).address)).size, "one invoice per request").toBe(2);
  expect(rows<StoredPayment>("payments").map((p) => p.target?.method)).toEqual(["spark", "spark"]);
  expect(host.storeMessage.mock.calls[0][0].text).toBe("Requested 1500 test sats on Spark");
  const off = setup({ spark: false });
  await expect(off.desk.request({ linkId: "l", amount: 1, timestamp: 3, method: "spark" })).rejects.toThrow("Both peers need Spark");
  await expect(off.desk.ask({ linkId: "l", amount: 1, timestamp: 3, method: "spark" })).rejects.toThrow("does not accept Spark");
});

it("the payer keeps a Spark request only when the chat allows Spark and the target is a Spark invoice", async () => {
  const request = (id: string, t: unknown) => ({ id, timestamp: Date.now(), amount: { value: "500", asset: "sat" }, endpoints: [[ENDPOINT.spark, JSON.stringify(t)]] as [string, string][] });
  const off = setup({ spark: false });
  await off.desk.onPaymentRequest("l", request("r0", target()));
  expect(off.desk.payment("r0")).toBeUndefined();
  const { desk } = setup();
  await desk.onPaymentRequest("l", request("r1", { ...target(), method: "bark" }));
  await desk.onPaymentRequest("l", request("r2", { ...target(), network: "signet" }));
  await desk.onPaymentRequest("l", request("r3", target(address())));
  await desk.onPaymentRequest("l", request("r6", target(invoice(501))));
  expect(desk.payment("r6"), "an invoice for another amount than the request's").toBeUndefined();
  expect(desk.payment("r1"), "a Bark target under the Spark endpoint").toBeUndefined();
  expect(desk.payment("r2"), "Spark has no signet here").toBeUndefined();
  expect(desk.payment("r3"), "a bare address cannot tell this request's payment from any other").toBeUndefined();
  await desk.onPaymentRequest("l", request("r4", target()));
  expect(desk.payment("r4")).toMatchObject({ kind: "request", direction: "in", amount: 500, target: { method: "spark" } });
  await desk.onPaymentRequest("l", request("r5", target()), true);
  expect(desk.payment("r5"), "a Spark request is never picked up from held storage").toBeUndefined();
});

it("the payee's app answers a Spark ask with a Spark request, and the payer ties it to its ask", async () => {
  const payee = setup();
  await payee.desk.start();
  await payee.desk.onPaymentAsk("l", { id: "ask_000001", timestamp: 1, amount: { value: "900", asset: "sat" }, method: "spark", memo: "tea" });
  expect(payee.sent).toHaveLength(1);
  expect(payee.sent[0].frame).toMatchObject({ ask: "ask_000001", amount: { value: "900", asset: "sat" }, memo: "tea" });
  expect((payee.sent[0].frame.endpoints as [string, string][])[0][0]).toBe(ENDPOINT.spark);

  const payer = setup();
  const { askId } = await payer.desk.ask({ linkId: "l", amount: 900, timestamp: 1, method: "spark" });
  expect(payer.sent[0]).toMatchObject({ kind: "ask", frame: { method: "spark", amount: { value: "900", asset: "sat" } } });
  await payer.desk.onPaymentRequest("l", { id: "answer", timestamp: Date.now(), amount: { value: "900", asset: "sat" }, endpoints: [[ENDPOINT.spark, JSON.stringify(target(invoice(900)))]], ask: askId });
  expect(payer.desk.payment("answer")?.ask).toBe(askId);
});

it("a receipt alone settles nothing: the request is paid when this wallet shows a receive on its invoice", async () => {
  const createdAt = Date.now(), a = invoice(), b = invoice();
  seed("payments", [
    { id: "r1", linkId: "l", kind: "request", direction: "out", amount: 1_000, unit: "sat", state: "pending", createdAt, target: target(a) },
    { id: "r2", linkId: "l", kind: "request", direction: "out", amount: 1_000, unit: "sat", state: "pending", createdAt, target: target(b) },
  ]);
  const payee = { arrived: undefined as string | undefined };
  const { desk, received, sent, spark } = setup({ received: async (t, _amount, _since, claimed) => t.address === a && payee.arrived && !claimed.has(payee.arrived) ? payee.arrived : undefined });
  await desk.start();
  const payment = { id: "p1", requestId: "r1", timestamp: createdAt, amount: { value: "1000", asset: "sat" }, endpoint: [ENDPOINT.spark, JSON.stringify({ id: crypto.randomUUID() })] as [string, string] };
  await desk.onPayment("l", payment);
  expect(desk.payment("p1")?.state).toBe("pending");
  expect(desk.payment("r1")?.state).toBe("pending");
  await desk.onPayment("l", { ...payment, id: "p2", amount: { value: "999", asset: "sat" } });
  expect(desk.payment("p2"), "a receipt for another amount").toBeUndefined();

  payee.arrived = crypto.randomUUID();
  await desk.reconcileSparkReceipts();
  expect(spark.sync).toHaveBeenCalled();
  expect(desk.payment("r1")).toMatchObject({ state: "settled", txid: payee.arrived });
  expect(desk.payment("p1")?.state).toBe("settled");
  expect(desk.payment("r2")?.state, "the other request is not paid by the same transfer").toBe("pending");
  expect(received).toHaveBeenCalledWith(expect.objectContaining({ address: a }), 1_000, createdAt, expect.any(Set));
  expect(sent.filter((s) => s.kind === "res").map((s) => s.frame), "the payer is told it is paid").toEqual([{ id: "r1", ok: true }]);
});

it("a request paid while the receipt was lost still settles, from the wallet alone; not while the wallet is closed", async () => {
  seed("payments", [{ id: "r1", linkId: "l", kind: "request", direction: "out", amount: 50, unit: "sat", state: "pending", createdAt: Date.now(), target: target() }]);
  const closed = setup({ ready: false, received: async () => "id-1" });
  await closed.desk.start();
  await closed.desk.reconcileSparkReceipts();
  expect(closed.desk.payment("r1")?.state).toBe("pending");
  const { desk } = setup({ received: async () => "id-1" });
  await desk.start();
  await desk.reconcileSparkReceipts();
  expect(desk.payment("r1")?.state).toBe("settled");
});

it("a settled Spark send is recorded once, settles the request, and tells the contact", async () => {
  const t = target();
  seed("payments", [{ id: "r1", linkId: "l", kind: "request", direction: "in", amount: 300, unit: "sat", state: "pending", createdAt: 1, target: t }]);
  const { desk, sent, host } = setup();
  await desk.start();
  const id = crypto.randomUUID();
  const reviewed = { ...t, id: "i1", requestId: "r1", linkId: "l", payee: "bob", amount: 300, fee: 0, feeCap: 100, createdAt: 2, state: "settled" as const, txid: id };
  await desk.recordSpark(reviewed);
  await desk.recordSpark(reviewed);
  expect(desk.payment("r1")?.state).toBe("settled");
  expect(desk.payment("i1")).toMatchObject({ kind: "payment", direction: "out", state: "settled", txid: id });
  expect(sent.map((s) => s.kind), "said once").toEqual(["pay"]);
  expect(sent[0].frame.endpoint).toEqual([ENDPOINT.spark, JSON.stringify({ id })]);
  expect(host.storeMessage).toHaveBeenCalledOnce();
  await desk.recordSpark({ ...reviewed, id: "i2", requestId: undefined, state: "unknown" });
  expect(desk.payment("i2"), "nothing is said about a payment whose outcome is unknown").toBeUndefined();
});

it("an open Spark request and a settled payment are offered again when the chat reconnects", async () => {
  seed("payments", [
    { id: "r1", linkId: "l", kind: "request", direction: "out", amount: 10, unit: "sat", state: "pending", createdAt: 1, target: target() },
    { id: "r2", linkId: "l", kind: "request", direction: "out", amount: 10, unit: "sat", state: "pending", createdAt: 1, target: { ...target(), expiresAt: Date.now() - 1 } },
    { id: "i1", linkId: "l", kind: "payment", direction: "out", amount: 10, unit: "sat", state: "settled", createdAt: 1, target: target(), txid: "t-1" },
  ]);
  const { desk, sent } = setup();
  await desk.start();
  await desk.replay("l");
  expect(sent.map((s) => `${s.kind}:${s.frame.id}`)).toEqual(["req:r1", "pay:i1"]);
});

it("'I paid from another wallet' only makes the payee look at its own wallet", async () => {
  seed("payments", [{ id: "r1", linkId: "l", kind: "request", direction: "in", amount: 10, unit: "sat", state: "pending", createdAt: 1, target: target() }]);
  const payer = setup();
  await payer.desk.start();
  await payer.desk.checkPayment({ linkId: "l", paymentId: "r1" });
  expect(payer.sent[0].frame.endpoint).toEqual([ENDPOINT.spark, JSON.stringify({ check: true })]);

  resetDb();
  seed("payments", [{ id: "r1", linkId: "l", kind: "request", direction: "out", amount: 10, unit: "sat", state: "pending", createdAt: Date.now(), target: target() }]);
  const payee = setup({ received: async () => undefined });
  await payee.desk.start();
  await payee.desk.onPayment("l", { id: "c1", requestId: "r1", timestamp: Date.now(), amount: { value: "10", asset: "sat" }, endpoint: [ENDPOINT.spark, JSON.stringify({ check: true })] });
  expect(payee.received).toHaveBeenCalled();
  expect(payee.desk.payment("r1")?.state, "its word settles nothing").toBe("pending");
});
