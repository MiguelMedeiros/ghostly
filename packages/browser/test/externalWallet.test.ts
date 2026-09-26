import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINT, ONCHAIN_PROVIDER, type GhostLink, type PaymentTarget } from "@ghostly/core";
import { PaymentDesk, type DeskBitcoin, type DeskLightning } from "../src/engine/payments";
import type { CashuWallet } from "../src/engine/wallet";
import type { ArkWallet } from "../src/engine/paymentAdapters/arkWallet";
import type { StoredPayment } from "../src/shared/types";
import { resetDb, rows, seed } from "./fakes";
// covers: payments.external, wallet.testnet.receive-held

vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);

/**
 * A request paid with a wallet that is not Ghostly: the payee's own wallet decides, the contact is told,
 * and "I paid" only makes the payee look now. Nothing here settles on anyone's word.
 */

const INVOICE = "lnbc210n1p4tgljxdqqpp5cy0xj543cj0zcj5r2zhdmpgztxsxlzf7c6yw898qnpuznly8ss6q";
const btc = (address = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080"): PaymentTarget => ({ method: "bitcoin", network: "regtest", provider: ONCHAIN_PROVIDER, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 60_000 });
const ark = (address: string): PaymentTarget => ({ method: "arkade", network: "regtest", provider: "http://localhost:7070", asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 60_000 });

function setup(stored: StoredPayment[], options: { received?: DeskBitcoin["received"]; arkReceived?: (address: string, amount: number, since: number, claimed: ReadonlySet<string>) => Promise<string | undefined> } = {}) {
  seed("payments", stored);
  const sent: { kind: string; frame: Record<string, unknown> }[] = [];
  const link = {
    requirePaymentSupport: vi.fn(async () => {}), allowsPayment: () => true, supportsPayments: true, supportsBitcoinPayments: true, supportsArkPayments: true, supportsBarkPayments: true, supportsUsdtPayments: true,
    sendPayment: vi.fn(async (frame: Record<string, unknown>) => { sent.push({ kind: "pay", frame }); }),
    sendPaymentResult: vi.fn((frame: Record<string, unknown>) => { sent.push({ kind: "res", frame }); }),
    sendPaymentRequest: vi.fn(async () => {}),
  };
  const host = { getLink: () => link as unknown as GhostLink, storeMessage: vi.fn(), onChange: vi.fn() };
  const lightning: DeskLightning = { createInvoice: vi.fn(), quote: vi.fn(), pay: vi.fn(), check: vi.fn(async () => {}) };
  const bitcoin: DeskBitcoin = { requestTarget: vi.fn(async () => btc()), received: vi.fn(options.received ?? (async () => undefined)) };
  const arkAdapter = { config: { provider: "http://localhost:7070", network: "regtest" }, received: vi.fn(options.arkReceived ?? (async () => undefined)), verifyReceipt: vi.fn(async () => false) };
  const desk = new PaymentDesk({} as CashuWallet, host, { adapter: arkAdapter } as unknown as ArkWallet, undefined, undefined, lightning, bitcoin);
  const state = (id: string) => rows<StoredPayment>("payments").find((p) => p.id === id);
  return { desk, link, sent, lightning, bitcoin, arkAdapter, state };
}

beforeEach(() => resetDb());

const incoming = (extra: Partial<StoredPayment>): StoredPayment => ({ id: "r1", linkId: "l", kind: "request", direction: "in", amount: 21, unit: "sat", state: "pending", createdAt: 0, ...extra });
const outgoing = (extra: Partial<StoredPayment>): StoredPayment => ({ ...incoming(extra), direction: "out" });

describe("the payer says it paid from another wallet", () => {
  it("sends the request's invoice back as the hint for a Lightning request, and a bare check for an on-chain one", async () => {
    const { desk, sent } = setup([incoming({ invoice: INVOICE }), incoming({ id: "r2", target: btc() })]);
    await desk.start();
    await desk.checkPayment({ linkId: "l", paymentId: "r1" });
    await desk.checkPayment({ linkId: "l", paymentId: "r2" });
    expect(sent.map((s) => s.frame.endpoint)).toEqual([[ENDPOINT.bolt11, INVOICE], [ENDPOINT.bitcoin, JSON.stringify({ check: true })]]);
    expect(sent[0].frame).toMatchObject({ requestId: "r1", amount: { value: "21", asset: "sat" } });
  });
  it("is bounded to one ask every few seconds, and says nothing once the request is paid", async () => {
    const { desk, sent } = setup([incoming({ invoice: INVOICE }), incoming({ id: "r2", invoice: INVOICE, state: "settled" })]);
    await desk.start();
    await desk.checkPayment({ linkId: "l", paymentId: "r1" });
    await desk.checkPayment({ linkId: "l", paymentId: "r1" });
    await desk.checkPayment({ linkId: "l", paymentId: "r2" });
    expect(sent).toHaveLength(1);
  });
  it("refuses for a request nothing else can pay, or that is not ours to pay", async () => {
    const { desk } = setup([incoming({ mints: ["https://mint.example"] }), outgoing({ id: "r2", invoice: INVOICE })]);
    await desk.start();
    await expect(desk.checkPayment({ linkId: "l", paymentId: "r1" })).rejects.toThrow(/cannot be paid from another wallet/);
    await expect(desk.checkPayment({ linkId: "l", paymentId: "r2" })).rejects.toThrow(/Unknown payment request/);
  });
  it("never marks its own copy paid: only the payee's word, and only for a request it sent us", async () => {
    const { desk, state } = setup([incoming({ invoice: INVOICE }), incoming({ id: "r2", target: btc() }), outgoing({ id: "r3", target: btc() })]);
    await desk.start();
    await desk.checkPayment({ linkId: "l", paymentId: "r1" });
    expect(state("r1")?.state).toBe("pending");
    await desk.onPaymentResult("l", { id: "r1", ok: false, error: "nope" });
    expect(state("r1")?.state).toBe("pending");
    await desk.onPaymentResult("l", { id: "r1", ok: true });
    await desk.onPaymentResult("l", { id: "r2", ok: true });
    await desk.onPaymentResult("l", { id: "r3", ok: true });
    await desk.onPaymentResult("other-link", { id: "r2", ok: true });
    expect([state("r1")?.state, state("r2")?.state], "a Lightning and an on-chain request, paid on the payee's say-so").toEqual(["settled", "settled"]);
    expect(state("r3")?.state, "our own request is settled by our wallet, never by the contact").toBe("pending");
  });
});

describe("the payee is asked to look", () => {
  const check = (endpoint: [string, string], requestId = "r1") => ({ id: "c1", requestId, timestamp: 1, amount: { value: "21", asset: "sat" }, endpoint });

  it("asks the Lightning source and the mints now, records nothing, and settles only when they see it", async () => {
    const { desk, lightning, sent, state } = setup([outgoing({ invoice: INVOICE })]);
    await desk.start();
    await desk.onPayment("l", check([ENDPOINT.bolt11, INVOICE]));
    expect(lightning.check).toHaveBeenCalledOnce();
    expect(state("c1")).toBeUndefined();
    expect(state("r1")?.state).toBe("pending");
    expect(sent).toEqual([]);
    // The source saw it paid: the request settles and the contact is told, as always.
    await desk.onLightningPaid({ paymentId: "r1" });
    expect(state("r1")?.state).toBe("settled");
    expect(sent).toEqual([{ kind: "res", frame: { id: "r1", ok: true } }]);
  });
  it("answers a check about a request already paid by saying so again", async () => {
    const { desk, lightning, sent } = setup([outgoing({ invoice: INVOICE, state: "settled" })]);
    await desk.start();
    await desk.onPayment("l", check([ENDPOINT.bolt11, INVOICE]));
    expect(lightning.check).not.toHaveBeenCalled();
    expect(sent).toEqual([{ kind: "res", frame: { id: "r1", ok: true } }]);
  });
  it("looks once every few seconds at most, and ignores a check for another rail or another contact's request", async () => {
    const { desk, lightning, bitcoin } = setup([outgoing({ invoice: INVOICE }), outgoing({ id: "r2", linkId: "other", target: btc() })]);
    await desk.start();
    await desk.onPayment("l", check([ENDPOINT.bolt11, INVOICE]));
    await desk.onPayment("l", check([ENDPOINT.bolt11, INVOICE]));
    await desk.onPayment("l", check([ENDPOINT.bitcoin, JSON.stringify({ check: true })]));
    await desk.onPayment("l", check([ENDPOINT.bitcoin, JSON.stringify({ check: true })], "r2"));
    expect(lightning.check).toHaveBeenCalledOnce();
    expect(bitcoin.received).not.toHaveBeenCalled();
  });
  it("on-chain: the source is asked for a confirmed receive on the request's address, and the contact is told once it is there", async () => {
    const chain = { txid: "f".repeat(64), confirmations: 0 };
    const { desk, bitcoin, sent, state } = setup([outgoing({ target: btc() })], { received: async () => ({ ...chain }) });
    await desk.start();
    await desk.onPayment("l", check([ENDPOINT.bitcoin, JSON.stringify({ check: true })]));
    expect(bitcoin.received).toHaveBeenCalledOnce();
    expect(state("r1")?.state, "in the mempool is not paid").toBe("pending");
    expect(state("c1")).toBeUndefined();
    chain.confirmations = 1;
    await desk.reconcileBitcoinReceipts();
    expect(state("r1")).toMatchObject({ state: "settled", txid: chain.txid });
    expect(sent).toEqual([{ kind: "res", frame: { id: "r1", ok: true } }]);
  });
  it("Ark: a virtual output on the request's address settles it with no receipt at all, one output per request", async () => {
    const paid = "a".repeat(64);
    const { desk, arkAdapter, sent, state } = setup(
      [outgoing({ target: ark("tark1first") }), outgoing({ id: "r2", target: ark("tark1second") })],
      { arkReceived: async (address, _amount, _since, claimed) => (address === "tark1first" && !claimed.has(paid) ? paid : undefined) },
    );
    await desk.start();
    await desk.onPayment("l", check([ENDPOINT.arkade, JSON.stringify({ check: true })]));
    expect(arkAdapter.received).toHaveBeenCalledWith("tark1first", 21, 0, expect.any(Set));
    expect(state("r1")).toMatchObject({ state: "settled", txid: paid });
    expect(state("r2")?.state).toBe("pending");
    expect(sent).toEqual([{ kind: "res", frame: { id: "r1", ok: true } }]);
    expect(state("c1")).toBeUndefined();
  });
});

describe("a test mint's invoice waits for the payer's word", () => {
  const check = (endpoint: [string, string]) => ({ id: "c1", requestId: "r1", timestamp: 1, amount: { value: "21", asset: "sat" }, endpoint });

  it("the payee lets go of the invoice the contact says it paid, and only that one", async () => {
    const { desk, lightning } = setup([outgoing({ invoice: INVOICE, network: "testnet" })]);
    await desk.start();
    await desk.onPayment("l", check([ENDPOINT.bolt11, INVOICE.toUpperCase()]));
    expect(lightning.check).toHaveBeenLastCalledWith(INVOICE);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10_000);
    // Another invoice is not this request's: the contact cannot speak for it, the wallet only looks.
    await desk.onPayment("l", check([ENDPOINT.bolt11, "lnbc1someoneelse"]));
    expect(lightning.check).toHaveBeenLastCalledWith(undefined);
    vi.useRealTimers();
  });

  it("the payer of a Testnet request over Lightning says so; a Mainnet payment needs no word", async () => {
    for (const network of ["testnet", "mainnet"] as const) {
      resetDb();
      const { desk, lightning, link, sent, state } = setup([incoming({ invoice: INVOICE, network })]);
      vi.mocked(lightning.quote).mockResolvedValue({ quote: "m1", amount: 21, feeReserve: 1 });
      vi.mocked(lightning.pay).mockResolvedValue(true);
      await desk.start();
      await desk.payRequest({ linkId: "l", paymentId: "r1", via: "lightning", network });
      expect(state("r1")?.state).toBe("settled");
      const said = sent.filter((s) => s.kind === "pay").map((s) => s.frame);
      if (network === "testnet") expect(said).toMatchObject([{ requestId: "r1", amount: { value: "21", asset: "sat" }, endpoint: [ENDPOINT.bolt11, INVOICE] }]);
      else expect(said, "Mainnet").toEqual([]);
      expect(link.sendPayment).toHaveBeenCalledTimes(network === "testnet" ? 1 : 0);
    }
  });

  it("a payment left pending says so once it settles", async () => {
    const { desk, lightning, sent, state } = setup([incoming({ invoice: INVOICE, network: "testnet" })]);
    vi.mocked(lightning.quote).mockResolvedValue({ quote: "m1", amount: 21, feeReserve: 1 });
    vi.mocked(lightning.pay).mockResolvedValue(false);
    await desk.start();
    await desk.payRequest({ linkId: "l", paymentId: "r1", via: "lightning", network: "testnet" });
    expect(sent).toEqual([]);
    await desk.onLightningResolved({ paymentId: "r1" }, true);
    expect(state("r1")?.state).toBe("settled");
    expect(sent.map((s) => s.frame.endpoint)).toEqual([[ENDPOINT.bolt11, INVOICE]]);
  });
});
