import { beforeEach, expect, it, vi } from "vitest";
import { ENDPOINT, ONCHAIN_PROVIDER, type GhostLink, type PaymentReview, type PaymentTarget } from "@ghostly/core";
import { PaymentDesk, type DeskBitcoin } from "../src/engine/payments";
import type { CashuWallet } from "../src/engine/wallet";
import type { StoredPayment } from "../src/shared/types";
import { fakeAddress } from "../src/engine/paymentAdapters/providers/testing";
import { resetDb, rows, seed } from "./fakes";
vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);
beforeEach(() => resetDb());

/** On-chain Bitcoin in a chat: requests carry a fresh address of the payee's source; its own wallet is the proof. */
const target = (address = fakeAddress()): PaymentTarget => ({ method: "bitcoin", network: "regtest", provider: ONCHAIN_PROVIDER, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 60_000 });
type Received = DeskBitcoin["received"];
function setup(opts: { bitcoin?: boolean; received?: Received } = {}) {
  const sent: { kind: string; frame: Record<string, unknown> }[] = [];
  const link = {
    requirePaymentSupport: vi.fn(async () => {}), supportsBitcoinPayments: opts.bitcoin ?? true, supportsBarkPayments: true, supportsArkPayments: true, supportsUsdtPayments: true, allowsPayment: () => true, supportsPayments: true,
    sendPaymentRequest: vi.fn(async (frame: Record<string, unknown>) => { sent.push({ kind: "req", frame }); }),
    sendPaymentAsk: vi.fn(async (frame: Record<string, unknown>) => { sent.push({ kind: "ask", frame }); }),
    sendPayment: vi.fn(async (frame: Record<string, unknown>) => { sent.push({ kind: "pay", frame }); }),
    sendPaymentResult: vi.fn((frame: Record<string, unknown>) => { sent.push({ kind: "res", frame }); }),
  };
  const received = vi.fn<Received>(opts.received ?? (async () => undefined));
  const bitcoin = { requestTarget: vi.fn(async () => target()), received };
  const host = { getLink: () => link as unknown as GhostLink, storeMessage: vi.fn(), onChange: vi.fn() };
  return { desk: new PaymentDesk({} as CashuWallet, host, undefined, undefined, undefined, undefined, bitcoin), sent, link, bitcoin, received, host };
}
const review = (extra: Partial<PaymentReview>): PaymentReview => ({ ...target(), id: "i1", linkId: "l", payee: "bob", amount: 300, fee: 141, feeCap: 2_000, createdAt: 2, state: "submitted", txid: "d".repeat(64), ...extra });

it("an on-chain request carries a fresh address under its own endpoint, and needs on-chain on both sides", async () => {
  const { desk, sent } = setup();
  await desk.start();
  await desk.request({ linkId: "l", amount: 1_500, timestamp: 1, method: "bitcoin", memo: "rent" });
  await desk.request({ linkId: "l", amount: 700, timestamp: 2, method: "bitcoin" });
  const endpoints = sent.map((s) => s.frame.endpoints as [string, string][]);
  expect(endpoints.map((e) => e[0][0])).toEqual([ENDPOINT.bitcoin, ENDPOINT.bitcoin]);
  expect(endpoints.every((e) => e.length === 1), "no invoice or mint beside it").toBe(true);
  expect(new Set(endpoints.map((e) => JSON.parse(e[0][1]).address)).size, "one address per request").toBe(2);
  expect(rows<StoredPayment>("payments").map((p) => p.target?.method)).toEqual(["bitcoin", "bitcoin"]);
  const off = setup({ bitcoin: false });
  await expect(off.desk.request({ linkId: "l", amount: 1, timestamp: 3, method: "bitcoin" })).rejects.toThrow("Both peers need on-chain Bitcoin");
  await expect(off.desk.ask({ linkId: "l", amount: 1, timestamp: 3, method: "bitcoin" })).rejects.toThrow("does not accept on-chain Bitcoin");
});

it("the payer keeps an on-chain request only when the chat allows it and the target is a valid address", async () => {
  const request = (id: string, t: unknown) => ({ id, timestamp: Date.now(), amount: { value: "500", asset: "sat" }, endpoints: [[ENDPOINT.bitcoin, JSON.stringify(t)]] as [string, string][] });
  const off = setup({ bitcoin: false });
  await off.desk.onPaymentRequest("l", request("r0", target()));
  expect(off.desk.payment("r0")).toBeUndefined();
  const { desk } = setup();
  await desk.onPaymentRequest("l", request("r1", { ...target(), method: "bark" }));
  await desk.onPaymentRequest("l", request("r2", { ...target(), network: "signet" }));
  await desk.onPaymentRequest("l", request("r3", { ...target(), provider: "https://mempool.space" }));
  expect([desk.payment("r1"), desk.payment("r2"), desk.payment("r3")]).toEqual([undefined, undefined, undefined]);
  await desk.onPaymentRequest("l", request("r4", target()));
  expect(desk.payment("r4")).toMatchObject({ kind: "request", direction: "in", amount: 500, target: { method: "bitcoin", network: "regtest" } });
});

it("the payee's app answers an on-chain ask with an on-chain request, and the payer ties it back", async () => {
  const payee = setup();
  await payee.desk.start();
  await payee.desk.onPaymentAsk("l", { id: "ask_000001", timestamp: 1, amount: { value: "900", asset: "sat" }, method: "bitcoin" });
  expect(payee.sent).toHaveLength(1);
  expect(payee.sent[0].frame).toMatchObject({ ask: "ask_000001", amount: { value: "900", asset: "sat" } });
  expect((payee.sent[0].frame.endpoints as [string, string][])[0][0]).toBe(ENDPOINT.bitcoin);

  const payer = setup();
  await payer.desk.start();
  const { askId } = await payer.desk.ask({ linkId: "l", amount: 900, timestamp: 1, method: "bitcoin" });
  await payer.desk.onPaymentRequest("l", { ...(payee.sent[0].frame as never), id: "r9", ask: askId });
  expect(payer.desk.payment("r9")?.ask).toBe(askId);
});

it("the payer records a broadcast as pending, tells the contact the txid, and settles the request only once it confirms", async () => {
  seed("payments", [{ id: "r1", linkId: "l", kind: "request", direction: "in", amount: 300, unit: "sat", state: "pending", createdAt: 1, target: target() }]);
  const { desk, sent, host } = setup();
  await desk.start();
  await desk.recordBitcoin(review({ requestId: "r1" }));
  expect(desk.payment("i1")).toMatchObject({ kind: "payment", direction: "out", state: "pending", txid: "d".repeat(64) });
  expect(desk.payment("r1")?.state).toBe("pending");
  expect(sent.map((s) => [s.kind, (s.frame.endpoint as [string, string])[0], JSON.parse((s.frame.endpoint as [string, string])[1]).txid])).toEqual([["pay", ENDPOINT.bitcoin, "d".repeat(64)]]);
  // The poll asks again while it waits: nothing new to say.
  await desk.recordBitcoin(review({ requestId: "r1" }));
  expect(sent).toHaveLength(1);
  await desk.recordBitcoin(review({ requestId: "r1", state: "settled" }));
  expect(desk.payment("i1")?.state).toBe("settled");
  expect(desk.payment("r1")).toMatchObject({ state: "settled", txid: "d".repeat(64) });
  expect(host.storeMessage).toHaveBeenCalledTimes(1);
  await desk.recordBitcoin(review({ id: "i2", state: "unknown", txid: undefined }));
  await desk.recordBitcoin(review({ id: "i3", state: "failed" }));
  expect([desk.payment("i2"), desk.payment("i3")], "nothing is said about an unknown or failed payment").toEqual([undefined, undefined]);
  // One that went out and then could never confirm (its coins spent elsewhere) says so.
  await desk.recordBitcoin(review({ id: "i4" }));
  await desk.recordBitcoin(review({ id: "i4", state: "failed", error: "Another transaction spent these coins" }));
  expect(desk.payment("i4")).toMatchObject({ state: "failed", error: "Another transaction spent these coins" });
});

it("the payee settles a request from its own wallet: a confirmed receive on the request's address, receipt or not", async () => {
  const createdAt = Date.now(), a = target(), b = target();
  seed("payments", [
    { id: "r1", linkId: "l", kind: "request", direction: "out", amount: 1_000, unit: "sat", state: "pending", createdAt, target: a },
    { id: "r2", linkId: "l", kind: "request", direction: "out", amount: 1_000, unit: "sat", state: "pending", createdAt, target: b },
  ]);
  const chain = { txid: "f".repeat(64), confirmations: 0 };
  const { desk, received } = setup({ received: async (t, _amount, claimed) => t.address === a.address && !claimed.has(chain.txid) ? { ...chain } : undefined });
  await desk.start();
  const payment = { id: "p1", requestId: "r1", timestamp: createdAt, amount: { value: "1000", asset: "sat" }, endpoint: [ENDPOINT.bitcoin, JSON.stringify({ txid: chain.txid })] as [string, string] };
  await desk.onPayment("l", payment);
  expect(desk.payment("p1")).toMatchObject({ state: "pending", txid: chain.txid });
  expect(desk.payment("r1")?.state, "in the mempool: not yet").toBe("pending");
  await desk.onPayment("l", { ...payment, id: "p2", amount: { value: "999", asset: "sat" } });
  await desk.onPayment("l", { ...payment, id: "p3", endpoint: [ENDPOINT.bitcoin, JSON.stringify({ txid: "nope" })] });
  expect([desk.payment("p2"), desk.payment("p3")], "a receipt for another amount, or without a txid").toEqual([undefined, undefined]);

  chain.confirmations = 1;
  await desk.reconcileBitcoinReceipts();
  expect(desk.payment("r1")).toMatchObject({ state: "settled", txid: chain.txid });
  expect(desk.payment("p1")?.state).toBe("settled");
  expect(desk.payment("r2")?.state, "the other request is not paid by the same money").toBe("pending");
  expect(received).toHaveBeenCalledWith(a, 1_000, expect.any(Set), chain.txid);
});

it("replays a pending on-chain request and a payment's receipt when the contact reconnects", async () => {
  seed("payments", [
    { id: "r1", linkId: "l", kind: "request", direction: "out", amount: 10, unit: "sat", state: "pending", createdAt: 1, target: target() },
    { id: "i1", linkId: "l", kind: "payment", direction: "out", amount: 20, unit: "sat", state: "pending", createdAt: 2, target: review({}), txid: "e".repeat(64) },
    { id: "r2", linkId: "l", kind: "request", direction: "out", amount: 30, unit: "sat", state: "pending", createdAt: 3, target: { ...target(), expiresAt: Date.now() - 1 } },
  ]);
  const { desk, sent } = setup();
  await desk.start();
  await desk.replay("l");
  expect(sent.map((s) => [s.kind, s.frame.id])).toEqual([["req", "r1"], ["pay", "i1"]]);
});

it("the engine's check asks the source what paid the address, or else checks the contact's txid in its history", async () => {
  const { BitcoinService } = await import("../src/engine/paymentAdapters/providers/bitcoinService");
  const { FakeOnchainProvider, fakeOnchain } = await import("../src/engine/paymentAdapters/providers/testing");
  const paid = { txid: "a".repeat(64), amount: 1_000, confirmations: 2 };
  const withReceived = Object.assign(new FakeOnchainProvider(), { received: vi.fn(async () => [{ ...paid, txid: "b".repeat(64), amount: 999 }, paid]) });
  const plain = Object.assign(new FakeOnchainProvider(), { history: vi.fn(async () => [paid]) });
  const service = async (provider: FakeOnchainProvider) => {
    const s = new BitcoinService(() => [{ ...fakeOnchain, create: async () => provider }], () => ({ platform: "web", cashu: {} as CashuWallet }), vi.fn());
    await s.start("testnet"); await s.sources.set("fake-onchain", { token: "t" });
    return s;
  };
  const a = await service(withReceived), t = target();
  expect(await a.received(t, 1_000, new Set())).toEqual({ txid: paid.txid, confirmations: 2 });
  expect(withReceived.received).toHaveBeenCalledWith(t.address);
  expect(await a.received(t, 1_000, new Set([paid.txid])), "already paid another request").toBeUndefined();
  expect(await a.received({ ...t, network: "signet" }, 1_000, new Set()), "another network").toBeUndefined();
  const b = await service(plain);
  expect(await b.received(t, 1_000, new Set()), "no receipt, nothing to check").toBeUndefined();
  expect(await b.received(t, 1_000, new Set(), paid.txid)).toEqual({ txid: paid.txid, confirmations: 2 });
  expect(await b.received(t, 1_001, new Set(), paid.txid), "less than asked").toBeUndefined();
});
