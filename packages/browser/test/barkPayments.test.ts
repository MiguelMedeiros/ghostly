import { beforeEach, expect, it, vi } from "vitest";
import { ENDPOINT, type GhostLink, type PaymentTarget } from "@ghostly/core";
import { PaymentDesk } from "../src/engine/payments";
import type { CashuWallet } from "../src/engine/wallet";
import type { BarkWallet } from "../src/engine/paymentAdapters/barkWallet";
import type { StoredPayment } from "../src/shared/types";
import { resetDb, rows, seed } from "./fakes";
// covers: payments.bark.offer, payments.bark.send
vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);
beforeEach(() => resetDb());

const provider = "https://ark.signet.2nd.dev";
const target = (address = "tark1psrvfresh1"): PaymentTarget => ({ method: "bark", network: "signet", provider, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 60_000 });
function setup(opts: { bark?: boolean; received?: (address: string, amount: number, since: number, claimed: ReadonlySet<string>) => Promise<string | undefined> } = {}) {
  const sent: { kind: string; frame: Record<string, unknown> }[] = [];
  const link = {
    requirePaymentSupport: vi.fn(async () => {}), supportsBarkPayments: opts.bark ?? true, supportsArkPayments: true, supportsUsdtPayments: true, allowsPayment: () => true, supportsPayments: true,
    sendPaymentRequest: vi.fn(async (frame: Record<string, unknown>) => { sent.push({ kind: "req", frame }); }),
    sendPaymentAsk: vi.fn(async (frame: Record<string, unknown>) => { sent.push({ kind: "ask", frame }); }),
    sendPayment: vi.fn(async (frame: Record<string, unknown>) => { sent.push({ kind: "pay", frame }); }),
    sendPaymentResult: vi.fn((frame: Record<string, unknown>) => { sent.push({ kind: "res", frame }); }),
  };
  let n = 0;
  const received = vi.fn(opts.received ?? (async () => undefined));
  // The Testnet (signet) wallet holds the money; the Mainnet one, open beside it, has no wallet yet.
  const bark = { network: "testnet", configured: true, target: vi.fn(async () => target(`tark1psrvfresh${++n}`)), adapter: { config: { provider, network: "signet" }, received, sync: vi.fn(async () => {}) } };
  const mainnet = { network: "mainnet", configured: false, target: vi.fn(async () => { throw new Error("no Mainnet Bark wallet"); }), adapter: undefined };
  const host = { getLink: () => link as unknown as GhostLink, storeMessage: vi.fn(), onChange: vi.fn() };
  const wallets = { mainnet: mainnet as unknown as BarkWallet, testnet: bark as unknown as BarkWallet };
  return { desk: new PaymentDesk({} as CashuWallet, host, undefined, undefined, wallets), sent, link, bark, mainnet, received, host };
}

it("a Bark request carries its own fresh address of its network's wallet, under the Bark endpoint, and needs Bark on both sides", async () => {
  const { desk, sent, mainnet } = setup();
  await desk.start();
  await desk.request({ linkId: "l", amount: 1_500, timestamp: 1, method: "bark", memo: "lunch", network: "testnet" });
  await desk.request({ linkId: "l", amount: 700, timestamp: 2, method: "bark", network: "testnet" });
  const endpoints = sent.map((s) => s.frame.endpoints as [string, string][]);
  expect(endpoints.map((e) => e[0][0])).toEqual([ENDPOINT.bark, ENDPOINT.bark]);
  expect(sent.map((s) => s.frame.network), "the request says its network on the wire").toEqual(["testnet", "testnet"]);
  const addresses = endpoints.map((e) => JSON.parse(e[0][1]).address);
  expect(new Set(addresses).size, "one address per request").toBe(2);
  expect(rows<StoredPayment>("payments").map((p) => [p.target?.method, p.network])).toEqual([["bark", "testnet"], ["bark", "testnet"]]);
  await expect(desk.request({ linkId: "l", amount: 5, timestamp: 3, method: "bark", network: "mainnet" }), "a network without a Bark wallet").rejects.toThrow("You have no Mainnet Bark wallet");
  expect(mainnet.target).not.toHaveBeenCalled();
  expect(sent).toHaveLength(2);
  const off = setup({ bark: false });
  await expect(off.desk.request({ linkId: "l", amount: 1, timestamp: 3, method: "bark" })).rejects.toThrow("Both peers need Bark");
  await expect(off.desk.ask({ linkId: "l", amount: 1, timestamp: 3, method: "bark" })).rejects.toThrow("does not accept Bark");
});

it("the payer keeps a Bark request only when the chat allows Bark and the target really is Bark", async () => {
  const request = (id: string, t: unknown) => ({ id, timestamp: Date.now(), amount: { value: "500", asset: "sat" }, endpoints: [[ENDPOINT.bark, JSON.stringify(t)]] as [string, string][] });
  const off = setup({ bark: false });
  await off.desk.onPaymentRequest("l", request("r0", target()));
  expect(off.desk.payment("r0")).toBeUndefined();
  const { desk } = setup();
  await desk.onPaymentRequest("l", request("r1", { ...target(), method: "arkade" }));
  await desk.onPaymentRequest("l", request("r2", { ...target(), network: "mutinynet" }));
  expect(desk.payment("r1"), "an Arkade target under the Bark endpoint").toBeUndefined();
  expect(desk.payment("r2"), "Second runs no mutinynet server").toBeUndefined();
  await desk.onPaymentRequest("l", request("r3", target()));
  expect(desk.payment("r3")).toMatchObject({ kind: "request", direction: "in", amount: 500, target: { method: "bark" } });
});

it("the payee's app answers a Bark ask with a Bark request from the wallet of the ask's network", async () => {
  const { desk, sent, bark, mainnet } = setup();
  await desk.start();
  await desk.onPaymentAsk("l", { id: "ask_000001", timestamp: 1, amount: { value: "900", asset: "sat" }, method: "bark", network: "testnet" });
  expect(sent).toHaveLength(1);
  expect(sent[0].frame).toMatchObject({ ask: "ask_000001", amount: { value: "900", asset: "sat" }, network: "testnet" });
  expect(bark.target).toHaveBeenCalledOnce();
  expect(mainnet.target).not.toHaveBeenCalled();
  expect((sent[0].frame.endpoints as [string, string][])[0][0]).toBe(ENDPOINT.bark);
});

it("a receipt alone settles nothing: the request is paid when this wallet shows the money on its address", async () => {
  const createdAt = Date.now();
  seed("payments", [
    { id: "r1", linkId: "l", kind: "request", direction: "out", amount: 1_000, unit: "sat", state: "pending", createdAt, target: target("tark1psrvA") },
    { id: "r2", linkId: "l", kind: "request", direction: "out", amount: 1_000, unit: "sat", state: "pending", createdAt, target: target("tark1psrvB") },
  ]);
  const payee = { arrived: undefined as string | undefined };
  const { desk, received } = setup({ received: async (address, _amount, _since, claimed) => address === "tark1psrvA" && payee.arrived && !claimed.has(payee.arrived) ? payee.arrived : undefined });
  await desk.start();
  const payment = { id: "p1", requestId: "r1", timestamp: createdAt, amount: { value: "1000", asset: "sat" }, endpoint: [ENDPOINT.bark, JSON.stringify({ txid: "a".repeat(64) })] as [string, string] };
  await desk.onPayment("l", payment);
  expect(desk.payment("p1")?.state).toBe("pending");
  expect(desk.payment("r1")?.state).toBe("pending");
  await desk.onPayment("l", { ...payment, id: "p2", amount: { value: "999", asset: "sat" } });
  expect(desk.payment("p2"), "a receipt for another amount").toBeUndefined();

  payee.arrived = "f".repeat(64);
  await desk.reconcileBarkReceipts();
  expect(desk.payment("r1")).toMatchObject({ state: "settled", txid: payee.arrived });
  expect(desk.payment("p1")?.state).toBe("settled");
  expect(desk.payment("r2")?.state, "the other request is not paid by the same money").toBe("pending");
  expect(received).toHaveBeenCalledWith("tark1psrvA", 1_000, createdAt, expect.any(Set));
});

it("a request paid while the receipt was lost still settles, from the wallet alone", async () => {
  seed("payments", [{ id: "r1", linkId: "l", kind: "request", direction: "out", amount: 50, unit: "sat", state: "pending", createdAt: Date.now(), target: target("tark1psrvC") }]);
  const { desk } = setup({ received: async () => "c".repeat(64) });
  await desk.start();
  await desk.reconcileBarkReceipts();
  expect(desk.payment("r1")?.state).toBe("settled");
});

it("a settled Bark send is recorded, settles the request, and tells the contact", async () => {
  seed("payments", [{ id: "r1", linkId: "l", kind: "request", direction: "in", amount: 300, unit: "sat", state: "pending", createdAt: 1, target: target() }]);
  const { desk, sent } = setup();
  await desk.start();
  await desk.recordBark({ ...target(), id: "i1", requestId: "r1", linkId: "l", payee: "bob", amount: 300, fee: 0, feeCap: 100, createdAt: 2, state: "settled", txid: "d".repeat(64) });
  expect(desk.payment("r1")?.state).toBe("settled");
  expect(desk.payment("i1")).toMatchObject({ kind: "payment", direction: "out", state: "settled" });
  expect(sent.map((s) => s.kind)).toEqual(["pay"]);
  expect((sent[0].frame.endpoint as [string, string])[0]).toBe(ENDPOINT.bark);
  await desk.recordBark({ ...target(), id: "i2", linkId: "l", payee: "bob", amount: 1, fee: 0, feeCap: 1, createdAt: 3, state: "unknown" });
  expect(desk.payment("i2"), "nothing is said about a payment whose outcome is unknown").toBeUndefined();
});
