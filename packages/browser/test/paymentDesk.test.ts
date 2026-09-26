import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINT, ONCHAIN_PROVIDER, cashuRequestPayload, type GhostLink, type PaymentRequest, type PaymentReview, type PaymentTarget } from "@ghostly/core";
import { PaymentDesk, type DeskBitcoin, type DeskLightning } from "../src/engine/payments";
import { CashuAdapter } from "../src/engine/paymentAdapters/cashu";
import type { CashuPrepared, CashuWallet } from "../src/engine/wallet";
import type { ArkWallet } from "../src/engine/paymentAdapters/arkWallet";
import type { BarkWallet } from "../src/engine/paymentAdapters/barkWallet";
import type { UsdtWallet } from "../src/engine/paymentAdapters/usdtWallet";
import { fakeAddress } from "../src/engine/paymentAdapters/providers/testing";
import type { StoredMessage, StoredPayment } from "../src/shared/types";
import { resetDb, rows, seed } from "./fakes";
// covers: payments.cashu.send, payments.cashu.request, payments.cashu.reclaim, payments.cashu.test-sats, payments.lightning.request, payments.chat.methods, payments.chat.refused, payments.external, payments.arkade.request, payments.bark.send, payments.bitcoin.send, payments.usdt.send, delivery.hold.request, chat.waiting

vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);
beforeEach(() => resetDb());

/**
 * The chat's payment desk, rail by rail: nothing is ever paid twice, a request is settled only by the
 * payee's own wallet (or its word, for a request it sent us), and ecash a contact did not take stays ours.
 */

const MINT = "https://mint.example";
const ARK = "https://mutinynet.arkade.sh";
const BARK = "https://ark.signet.2nd.dev";
const INVOICE = "lnbc-invoice";
const CHECK = JSON.stringify({ check: true });
const tx = (c: string) => c.repeat(64);

const ark = (address = "tark1fresh", extra: Partial<PaymentTarget> = {}): PaymentTarget => ({ method: "arkade", network: "mutinynet", provider: ARK, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 3_600_000, ...extra });
const bark = (address = "tark1bark", extra: Partial<PaymentTarget> = {}): PaymentTarget => ({ method: "bark", network: "signet", provider: BARK, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 3_600_000, ...extra });
const btc = (extra: Partial<PaymentTarget> = {}): PaymentTarget => ({ method: "bitcoin", network: "regtest", provider: ONCHAIN_PROVIDER, asset: "BTC", unit: "sat", address: fakeAddress(), expiresAt: Date.now() + 3_600_000, ...extra });
const usdt = (extra: Partial<PaymentTarget> = {}): PaymentTarget => ({ method: "usdt", network: "evm-local", chainId: 31337, asset: "TEST-USDT", unit: "token-base", decimals: 6, token: "0x" + "1".repeat(40), address: "0x" + "2".repeat(40), provider: "http://127.0.0.1:43210", issuedAt: Date.now(), expiresAt: Date.now() + 3_600_000, ...extra });
const cashuTarget = (): PaymentTarget => ({ method: "cashu", network: "bitcoin", provider: MINT, asset: "BTC", unit: "sat", address: "peer", expiresAt: Date.now() + 60_000 });

const record = (extra: Partial<StoredPayment> & { id: string }): StoredPayment => ({ linkId: "l", kind: "request", direction: "in", amount: 100, unit: "sat", state: "pending", createdAt: 1, ...extra });
const review = (target: PaymentTarget, extra: Partial<PaymentReview> = {}): PaymentReview => ({ ...target, id: "rv", linkId: "l", payee: "bob", amount: 100, fee: 1, feeCap: 10, createdAt: 7, state: "settled", ...extra });

type Frame = Record<string, unknown>;
function setup(stored: StoredPayment[] = []) {
  seed("payments", stored as unknown as Record<string, unknown>[]);
  const sent: { kind: "req" | "pay" | "res" | "ask"; frame: Frame }[] = [];
  const allowed: Record<string, boolean> = { cashu: true, lightning: true };
  const enabled: Record<string, boolean> = { cashu: true, lightning: true };
  const link = {
    isDataLinkOpen: true, supportsPayments: true, supportsArkPayments: true, supportsBarkPayments: true, supportsBitcoinPayments: true, supportsUsdtPayments: true,
    requirePaymentSupport: vi.fn(async () => {}),
    allowsPayment: vi.fn((m: string) => allowed[m] ?? false),
    paymentEnabled: vi.fn((m: string) => enabled[m] ?? false),
    sendPaymentRequest: vi.fn(async (frame: Frame) => { sent.push({ kind: "req", frame }); }),
    sendPaymentAsk: vi.fn(async (frame: Frame) => { sent.push({ kind: "ask", frame }); }),
    sendPayment: vi.fn(async (frame: Frame) => { sent.push({ kind: "pay", frame }); }),
    sendPaymentResult: vi.fn((frame: Frame) => { sent.push({ kind: "res", frame }); }),
  };
  const net = { online: true };
  const host = {
    getLink: vi.fn(() => (net.online ? (link as unknown as GhostLink) : null)),
    storeMessage: vi.fn(async (_message: StoredMessage) => {}),
    onChange: vi.fn(),
    heldPaymentMethods: vi.fn((): ("cashu" | "lightning")[] | null => null),
    waitingPaymentMethods: vi.fn((): ("cashu" | "lightning")[] | null => null),
    holdRequest: vi.fn(async (_linkId: string, _request: PaymentRequest, _messageId: string) => {}),
    onReviewedPaymentResult: vi.fn(async () => {}),
    onReviewedPaymentRefused: vi.fn(async () => {}),
  };
  const wallet = {
    receiveToken: vi.fn(async (): Promise<{ amount: number; mint: string }> => ({ amount: 100, mint: MINT })),
    createToken: vi.fn(async (_amount: number, _mints: string[], _memo: string | undefined, outbox: (token: string, mint: string) => StoredPayment) => { outbox("cashuBtoken", MINT); return { token: "cashuBtoken", mint: MINT }; }),
    view: vi.fn(async () => ({ mints: [{ url: MINT }] })),
  };
  const lightning = {
    createInvoice: vi.fn(async () => ({ invoice: INVOICE })),
    quote: vi.fn(async () => ({ quote: "q", mint: MINT, amount: 100, feeReserve: 1 })),
    pay: vi.fn(async () => true),
    check: vi.fn(async () => {}),
  };
  const arkWallet = { target: vi.fn(async () => ark()), adapter: { config: { provider: ARK, network: "mutinynet" }, received: vi.fn(async (): Promise<string | undefined> => undefined), verifyReceipt: vi.fn(async () => false) } };
  const barkWallet = { target: vi.fn(async () => bark()), adapter: { config: { provider: BARK, network: "signet" }, received: vi.fn(async (): Promise<string | undefined> => undefined), sync: vi.fn(async () => {}) } };
  const usdtWallet = { target: vi.fn(async () => usdt()), adapter: { receipt: vi.fn(async (): Promise<{ settled?: boolean; failed?: boolean; error?: string }> => ({ settled: false })) } };
  const bitcoin = { requestTarget: vi.fn(async () => btc()), received: vi.fn<DeskBitcoin["received"]>(async () => undefined) };
  const desk = new PaymentDesk(wallet as unknown as CashuWallet, host, arkWallet as unknown as ArkWallet, usdtWallet as unknown as UsdtWallet, barkWallet as unknown as BarkWallet, lightning as DeskLightning, bitcoin);
  const state = (id: string) => rows<StoredPayment>("payments").find((p) => p.id === id);
  const texts = () => host.storeMessage.mock.calls.map((c) => c[0].text);
  return { desk, sent, link, allowed, enabled, net, host, wallet, lightning, arkWallet, barkWallet, usdtWallet, bitcoin, state, texts };
}
const cashuPayment = (id: string, extra: Record<string, unknown> = {}) => ({ id, timestamp: 9, amount: { value: "100", asset: "sat" }, endpoint: [ENDPOINT.cashu, "cashuBin"] as [string, string], ...extra });

describe("paying a contact's request, never twice", () => {
  it("refuses what is not an open request of this chat it may pay without a review", async () => {
    const { desk, wallet, lightning } = setup([
      record({ id: "r1", invoice: INVOICE, mints: [MINT] }), record({ id: "r2", direction: "out" }), record({ id: "r3", kind: "payment" }),
      record({ id: "r4", target: ark() }), record({ id: "r5", state: "settled", invoice: INVOICE }),
    ]);
    await desk.start();
    await expect(desk.payRequest({ linkId: "x", paymentId: "r1" }), "another chat").rejects.toThrow("Unknown payment request");
    for (const id of ["r2", "r3", "nope"]) await expect(desk.payRequest({ linkId: "l", paymentId: id }), id).rejects.toThrow("Unknown payment request");
    await expect(desk.payRequest({ linkId: "l", paymentId: "r4", confirmedReal: true })).rejects.toThrow("Review and explicitly approve");
    await expect(desk.payRequest({ linkId: "l", paymentId: "r5", confirmedReal: true })).rejects.toThrow("no longer open");
    expect(wallet.createToken).not.toHaveBeenCalled();
    expect(lightning.pay).not.toHaveBeenCalled();
  });

  it("ecash that came back, or never went, does not count: the request can be paid again", async () => {
    const { desk, wallet } = setup([
      record({ id: "r1", mints: [MINT] }),
      record({ id: "p0", kind: "payment", direction: "out", requestId: "r1", state: "reclaimed" }),
      record({ id: "p1", kind: "payment", direction: "out", requestId: "r1", state: "failed", token: "cashuBold" }),
    ]);
    await desk.start();
    await desk.payRequest({ linkId: "l", paymentId: "r1", confirmedReal: true });
    expect(wallet.createToken).toHaveBeenCalledWith(100, [MINT], undefined, expect.any(Function), "mainnet");
  });

  it("goes to Lightning only when no ecash was made and the request has an invoice", async () => {
    const { desk, wallet, lightning, allowed } = setup([record({ id: "r1", mints: [MINT] })]);
    await desk.start();
    wallet.createToken.mockRejectedValue(new Error("You share no mint with this contact"));
    await expect(desk.payRequest({ linkId: "l", paymentId: "r1", confirmedReal: true })).rejects.toThrow("You share no mint");
    allowed.cashu = false;
    await expect(desk.payRequest({ linkId: "l", paymentId: "r1", confirmedReal: true })).rejects.toThrow("No way of paying this request is allowed");
    expect(lightning.quote).not.toHaveBeenCalled();
  });

  it("pays an invoice only for the amount asked, and for at most 3% in fees (10 sats at least)", async () => {
    const { desk, lightning, allowed, state } = setup([record({ id: "r1", amount: 1_000, invoice: INVOICE })]);
    await desk.start();
    allowed.cashu = false;
    lightning.quote.mockResolvedValueOnce({ quote: "q", mint: MINT, amount: 999, feeReserve: 1 });
    await expect(desk.payRequest({ linkId: "l", paymentId: "r1", confirmedReal: true })).rejects.toThrow("does not match the requested amount");
    lightning.quote.mockResolvedValueOnce({ quote: "q", mint: MINT, amount: 1_000, feeReserve: 31 });
    await expect(desk.payRequest({ linkId: "l", paymentId: "r1", confirmedReal: true })).rejects.toThrow("fee (31 sats) is too high");
    expect(lightning.pay).not.toHaveBeenCalled();
    lightning.quote.mockResolvedValueOnce({ quote: "q", mint: MINT, amount: 1_000, feeReserve: 30 });
    await desk.payRequest({ linkId: "l", paymentId: "r1", confirmedReal: true });
    expect(lightning.pay).toHaveBeenCalledWith(expect.objectContaining({ quote: "q" }), "Paid a contact's request", "r1");
    expect(state("r1")).toMatchObject({ state: "settled", mint: MINT });
  });

  it("a Lightning payment that did not go out opens the request again, and it can be paid", async () => {
    const { desk, lightning, allowed, state } = setup([record({ id: "r1", invoice: INVOICE })]);
    await desk.start();
    allowed.cashu = false;
    lightning.pay.mockRejectedValueOnce(new Error("No route"));
    await expect(desk.payRequest({ linkId: "l", paymentId: "r1", confirmedReal: true })).rejects.toThrow("No route");
    expect(state("r1")?.lightningPending).toBeUndefined();
    await desk.payRequest({ linkId: "l", paymentId: "r1", confirmedReal: true });
    expect(state("r1")?.state).toBe("settled");
  });
});

describe("requests we send", () => {
  it("none goes out when the chat allows neither Cashu nor Lightning", async () => {
    const { desk, allowed, sent } = setup();
    allowed.cashu = allowed.lightning = false;
    await expect(desk.request({ linkId: "l", amount: 10, timestamp: 1 })).rejects.toThrow("Cashu and Lightning are off");
    expect(sent).toEqual([]);
    expect(rows("payments")).toEqual([]);
  });

  it("an away contact's request is held, carrying only what their app allowed, and needs no session", async () => {
    const { desk, link, host, lightning, sent, texts, enabled } = setup();
    link.isDataLinkOpen = false;
    link.requirePaymentSupport.mockRejectedValue(new Error("You are offline"));
    host.heldPaymentMethods.mockReturnValue(["cashu"]);
    const { paymentId } = await desk.request({ linkId: "l", amount: 50, timestamp: 5, memo: "  pizza  " });
    expect(lightning.createInvoice, "Lightning was not allowed by the contact").not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    const [linkId, held, messageId] = host.holdRequest.mock.calls[0];
    expect([linkId, messageId]).toEqual(["l", "me_5"]);
    expect(held).toMatchObject({ id: paymentId, memo: "pizza", amount: { value: "50", asset: "sat" }, endpoints: [[ENDPOINT.cashu, cashuRequestPayload([MINT])]] });
    expect(host.storeMessage).toHaveBeenCalledWith(expect.objectContaining({ via: "hold", delivery: "sending" }));
    expect(desk.requestFor(paymentId), "the held copy can be rebuilt as it went").toEqual(held);
    expect(texts()).toEqual(["⚡ Requested 50 sats"]);

    host.heldPaymentMethods.mockReturnValue(["lightning"]);
    enabled.lightning = false; // Allowed by the contact, but no longer on this device.
    await expect(desk.request({ linkId: "l", amount: 50, timestamp: 6 })).rejects.toThrow("Your contact allowed neither");
    await expect(desk.request({ linkId: "l", amount: 50, timestamp: 7, method: "arkade" }), "Ark needs the contact there").rejects.toThrow("You are offline");
  });

  it("a request while the chat is not live and nothing holds it waits here, goes with the replay when live, and a cancel withdraws it", async () => {
    const { desk, link, host, sent, state } = setup();
    link.isDataLinkOpen = false;
    link.requirePaymentSupport.mockRejectedValue(new Error("dialled for 90 s"));
    host.waitingPaymentMethods.mockReturnValue(["cashu", "lightning"]);
    const { paymentId } = await desk.request({ linkId: "l", amount: 21, timestamp: 5 });
    expect(link.requirePaymentSupport, "a waiting request dials nobody").not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(host.holdRequest).not.toHaveBeenCalled();
    expect(host.storeMessage).toHaveBeenCalledWith(expect.objectContaining({ via: "datalink", delivery: "waiting", paymentId }));
    expect(state(paymentId)).toMatchObject({ state: "pending", invoice: INVOICE, mints: [MINT] });
    link.isDataLinkOpen = true;
    await desk.replay("l");
    expect(sent.map(s => s.frame.id)).toEqual([paymentId]);

    // Cancelled before the chat was live: withdrawn, so no later session sends it.
    link.isDataLinkOpen = false;
    const second = (await desk.request({ linkId: "l", amount: 7, timestamp: 6 })).paymentId;
    await desk.withdraw(second);
    expect(state(second)?.state).toBe("failed");
    link.isDataLinkOpen = true;
    sent.length = 0;
    await desk.replay("l");
    expect(sent.map(s => s.frame.id)).not.toContain(second);
    // Ark and the others need the contact there: they never wait.
    link.isDataLinkOpen = false;
    await expect(desk.request({ linkId: "l", amount: 5, timestamp: 8, method: "arkade" })).rejects.toThrow("dialled");
  });

  it("rebuilds only our own Cashu or Lightning requests", async () => {
    const { desk } = setup([record({ id: "in", invoice: INVOICE }), record({ id: "ark", direction: "out", target: ark() }), record({ id: "ln", direction: "out", invoice: INVOICE, mints: [] })]);
    await desk.start();
    expect([desk.requestFor("in"), desk.requestFor("ark"), desk.requestFor("nope")]).toEqual([null, null, null]);
    expect(desk.requestFor("ln")?.endpoints).toEqual([[ENDPOINT.bolt11, INVOICE]]);
  });

  it("a USDT request carries the payee's address in token units, and needs USDT on both sides", async () => {
    const { desk, link, sent, state, texts } = setup();
    const { paymentId } = await desk.request({ linkId: "l", amount: 1_500_000, timestamp: 1, method: "usdt" });
    expect(state(paymentId)).toMatchObject({ unit: "testusdt", target: { method: "usdt" }, state: "pending" });
    expect(sent[0].frame).toMatchObject({ amount: { value: "1500000", asset: "testusdt" }, endpoints: [[ENDPOINT.usdt, JSON.stringify(state(paymentId)!.target)]] });
    expect(texts()).toEqual(["Requested 1.5 TEST-USDT"]);
    link.supportsUsdtPayments = false;
    await expect(desk.request({ linkId: "l", amount: 1, timestamp: 2, method: "usdt" })).rejects.toThrow("Both peers need USDT");
    link.supportsArkPayments = false;
    await expect(desk.request({ linkId: "l", amount: 1, timestamp: 2, method: "arkade" })).rejects.toThrow("Both peers need the Ark payment capability");
  });
});

describe("a contact's request arriving", () => {
  const lnRequest = (id: string, extra: Partial<PaymentRequest> = {}): PaymentRequest => ({ id, timestamp: 3, amount: { value: "40", asset: "sat" }, endpoints: [[ENDPOINT.bolt11, INVOICE], [ENDPOINT.cashu, cashuRequestPayload([MINT])]], ...extra });

  it("is taken once, whatever a second copy says", async () => {
    const { desk } = setup();
    await desk.onPaymentRequest("l", lnRequest("r1"));
    await desk.onPaymentRequest("l", lnRequest("r1", { amount: { value: "4000", asset: "sat" } }));
    expect(desk.payment("r1")?.amount).toBe(40);
  });

  it("a held copy keeps only Cashu or Lightning, as this device allows them", async () => {
    const { desk, allowed, host } = setup();
    await desk.onPaymentRequest("l", { ...lnRequest("r-ark"), endpoints: [[ENDPOINT.arkade, JSON.stringify(ark())]] }, true);
    await desk.onPaymentRequest("l", { ...lnRequest("r-mix"), endpoints: [[ENDPOINT.bolt11, INVOICE], [ENDPOINT.usdt, JSON.stringify(usdt())]] }, true);
    expect([desk.payment("r-ark"), desk.payment("r-mix")]).toEqual([undefined, undefined]);
    allowed.lightning = false; // Not on a live session: what counts is what this device enabled.
    await desk.onPaymentRequest("l", lnRequest("r-held"), true);
    expect(desk.payment("r-held")).toMatchObject({ invoice: INVOICE, mints: [MINT] });
    expect(host.storeMessage).toHaveBeenCalledWith(expect.objectContaining({ via: "hold", paymentId: "r-held" }));
  });

  it("only whole sats: anything else is answered as refused and not kept", async () => {
    const { desk, sent } = setup();
    await desk.onPaymentRequest("l", lnRequest("r1", { amount: { value: "1.5", asset: "sat" } }));
    await desk.onPaymentRequest("l", lnRequest("r2", { amount: { value: "40", asset: "msat" } }));
    expect(sent.map((s) => s.frame)).toEqual([{ id: "r1", ok: false, error: "Only whole amounts in sats are supported" }, { id: "r2", ok: false, error: "Only whole amounts in sats are supported" }]);
    expect(rows("payments")).toEqual([]);
  });

  it("an Ark or on-chain request is dropped when the chat lacks that rail or its target is unreadable", async () => {
    const { desk, link } = setup();
    const at = (id: string, endpoint: string, payload: string) => desk.onPaymentRequest("l", { ...lnRequest(id), endpoints: [[endpoint, payload]] });
    await at("a1", ENDPOINT.arkade, "{not json");
    await at("a2", ENDPOINT.arkade, JSON.stringify(bark()));
    await at("b1", ENDPOINT.bitcoin, "{not json");
    await at("b2", ENDPOINT.bitcoin, JSON.stringify(ark()));
    await at("k1", ENDPOINT.bark, "{not json");
    link.supportsArkPayments = false;
    await at("a3", ENDPOINT.arkade, JSON.stringify(ark()));
    expect(rows("payments")).toEqual([]);
    link.supportsArkPayments = true;
    await at("a4", ENDPOINT.arkade, JSON.stringify(ark()));
    expect(desk.payment("a4")).toMatchObject({ target: { method: "arkade" }, invoice: undefined, mints: [] });
  });
});

describe("ecash arriving", () => {
  it("a payment id of another chat, or of one of our own payments, is refused without a word about it", async () => {
    const { desk, wallet, sent } = setup([
      record({ id: "ours", kind: "payment", direction: "out", token: "cashuBours" }),
      record({ id: "theirs", kind: "payment", linkId: "other", state: "settled" }),
    ]);
    await desk.start();
    await desk.onPayment("l", cashuPayment("ours"));
    await desk.onPayment("l", cashuPayment("theirs"));
    expect(wallet.receiveToken).not.toHaveBeenCalled();
    expect(sent.map((s) => s.frame)).toEqual([{ id: "ours", ok: false, error: "Unknown payment" }, { id: "theirs", ok: false, error: "Unknown payment" }]);
  });

  it("an unknown way of paying, or an amount that is not whole sats, is refused and said once in the chat", async () => {
    const { desk, wallet, sent, host, texts } = setup();
    await desk.onPayment("l", cashuPayment("p1", { endpoint: ["btc-offer/1", "x"] }));
    await desk.onPayment("l", cashuPayment("p2", { amount: { value: "1e3", asset: "sat" } }));
    host.storeMessage.mockRejectedValueOnce(new Error("disk full"));
    await desk.onPayment("l", cashuPayment("p3", { endpoint: ["btc-offer/1", "x"] }));
    expect(wallet.receiveToken).not.toHaveBeenCalled();
    expect(sent.map((s) => s.frame)).toEqual([
      { id: "p1", ok: false, error: "Unsupported payment method" },
      { id: "p2", ok: false, error: "Unsupported amount" },
      { id: "p3", ok: false, error: "Unsupported payment method" },
    ]);
    expect(texts().slice(0, 2)).toEqual(["Could not receive 100 sats: Unsupported payment method", "Could not receive a payment: Unsupported amount"]);
  });

  it("settles our request only in full, from a mint it named, and only when it came through this chat", async () => {
    const { desk, wallet, state } = setup([record({ id: "r", direction: "out", mints: [MINT] })]);
    await desk.start();
    wallet.receiveToken.mockResolvedValueOnce({ amount: 60, mint: MINT });
    await desk.onPayment("l", cashuPayment("p1", { requestId: "r" }));
    wallet.receiveToken.mockResolvedValueOnce({ amount: 100, mint: "https://other.mint" });
    await desk.onPayment("l", cashuPayment("p2", { requestId: "r" }));
    await desk.onPayment("x", cashuPayment("p3", { requestId: "r" }));
    expect(state("r")?.state).toBe("pending");
    expect(["p1", "p2", "p3"].map((id) => state(id)?.state), "each is received all the same").toEqual(["settled", "settled", "settled"]);
    await desk.onPayment("l", cashuPayment("p4", { requestId: "r" }));
    expect(state("r")).toMatchObject({ state: "settled", mint: MINT });
  });
});

describe("what the contact answers about our payments", () => {
  it("our ecash is settled on the contact's word, with the request it paid; another chat's word counts for nothing", async () => {
    const { desk, state } = setup([record({ id: "r" }), record({ id: "p", kind: "payment", direction: "out", requestId: "r", token: "cashuBp" })]);
    await desk.start();
    await desk.onPaymentResult("x", { id: "p", ok: true });
    expect(state("p")?.state).toBe("pending");
    await desk.onPaymentResult("l", { id: "p", ok: true });
    expect(state("p")).toMatchObject({ state: "settled", token: undefined });
    expect(state("r")?.state).toBe("settled");
  });

  it("refused ecash that cannot be taken back is failed, and stays reclaimable even when the chat is forgotten", async () => {
    const { desk, wallet, state } = setup([record({ id: "p", kind: "payment", direction: "out", token: "cashuBp" })]);
    await desk.start();
    wallet.receiveToken.mockRejectedValue(new Error("mint offline"));
    await desk.onPaymentResult("l", { id: "p", ok: false });
    expect(state("p")).toMatchObject({ state: "failed", error: "The payment was refused", token: "cashuBp" });
    await desk.forgetLink("l");
    expect(state("p")?.token).toBe("cashuBp");
  });

  it("a payment with a target, one we received, or one already over is never changed by the contact's word", async () => {
    const { desk, wallet, state } = setup([
      record({ id: "a", kind: "payment", direction: "out", target: ark(), txid: tx("a") }),
      record({ id: "i", kind: "payment", direction: "in" }),
      record({ id: "s", kind: "payment", direction: "out", state: "settled" }),
    ]);
    await desk.start();
    for (const id of ["a", "i"]) await desk.onPaymentResult("l", { id, ok: true });
    await desk.onPaymentResult("l", { id: "s", ok: false, error: "no" });
    expect(["a", "i", "s"].map((id) => state(id)?.state)).toEqual(["pending", "pending", "settled"]);
    expect(wallet.receiveToken).not.toHaveBeenCalled();
  });

  it("a refused reviewed Cashu send is closed as refused only once its ecash is back", async () => {
    const reviewed = record({ id: "rv", kind: "payment", direction: "out", token: "cashuBrv", target: cashuTarget() });
    const { desk, wallet, host, state } = setup([reviewed, { ...reviewed, id: "rv2", token: "cashuBrv2" }]);
    await desk.start();
    wallet.receiveToken.mockRejectedValueOnce(new Error("mint offline"));
    await desk.onPaymentResult("l", { id: "rv", ok: false, error: "No thanks" });
    expect(state("rv")).toMatchObject({ state: "pending", error: "No thanks" });
    expect(host.onReviewedPaymentRefused).not.toHaveBeenCalled();
    await desk.onPaymentResult("l", { id: "rv2", ok: false });
    expect(host.onReviewedPaymentRefused).toHaveBeenCalledWith("rv2", "The payment was refused");
    await desk.onPaymentResult("x", { id: "rv", ok: true });
    expect(host.onReviewedPaymentResult, "another chat cannot confirm it").not.toHaveBeenCalled();
  });

  it("only ecash we sent and still hold can be taken back, and a mint that cannot be reached is said so", async () => {
    const { desk, wallet } = setup([record({ id: "in", kind: "payment" }), record({ id: "p", kind: "payment", direction: "out", token: "cashuBp" })]);
    await desk.start();
    await expect(desk.reclaim("in")).rejects.toThrow("Nothing to reclaim");
    await expect(desk.reclaim("nope")).rejects.toThrow("Nothing to reclaim");
    wallet.receiveToken.mockRejectedValueOnce(new Error("mint offline"));
    await expect(desk.reclaim("p")).rejects.toThrow("mint offline");
  });
});

describe("asks to pay without a request", () => {
  it("a USDT ask is answered in token units only, and nothing answers an ask from a chat that is gone", async () => {
    const { desk, sent, net } = setup();
    await desk.onPaymentAsk("l", { id: "ask_000001", timestamp: 1, amount: { value: "1000000", asset: "sat" }, method: "usdt" });
    await desk.onPaymentAsk("l2", { id: "ask_000002", timestamp: 1, amount: { value: "1000000", asset: "usdtbase" }, method: "usdt" });
    expect(sent.map((s) => s.frame.ask)).toEqual(["ask_000002"]);
    expect(sent[0].frame).toMatchObject({ amount: { value: "1000000", asset: "testusdt" } });
    net.online = false;
    await desk.onPaymentAsk("l3", { id: "ask_000003", timestamp: 1, amount: { value: "10", asset: "sat" }, method: "arkade" });
    expect(sent).toHaveLength(1);
  });

  it("the payer ties a request to its ask only for the same way of paying, and only while it is fresh", async () => {
    const { desk, sent } = setup();
    await expect(desk.ask({ linkId: "l", amount: 1.5, method: "usdt", timestamp: 1 })).rejects.toThrow("positive amount");
    const { askId: usdtAsk } = await desk.ask({ linkId: "l", amount: 2_000_000, method: "usdt", timestamp: 1 });
    expect(sent[0].frame.amount).toEqual({ value: "2000000", asset: "usdtbase" });
    await desk.onPaymentRequest("l", { id: "u1", timestamp: 2, amount: { value: "2000000", asset: "testusdt" }, endpoints: [[ENDPOINT.usdt, JSON.stringify(usdt())]], ask: usdtAsk });
    expect(desk.payment("u1")?.ask).toBe(usdtAsk);

    const { askId } = await desk.ask({ linkId: "l", amount: 700, method: "arkade", timestamp: 1 });
    await desk.onPaymentRequest("l", { id: "b1", timestamp: 2, amount: { value: "700", asset: "sat" }, endpoints: [[ENDPOINT.bitcoin, JSON.stringify(btc())]], ask: askId });
    expect(desk.payment("b1")?.ask, "an on-chain request does not answer an Ark ask").toBeUndefined();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 3 * 60_000);
    try {
      await desk.onPaymentRequest("l", { id: "a1", timestamp: 2, amount: { value: "700", asset: "sat" }, endpoints: [[ENDPOINT.arkade, JSON.stringify(ark())]], ask: askId });
    } finally { clock.mockRestore(); }
    expect(desk.payment("a1")?.ask, "asked more than two minutes ago").toBeUndefined();
  });
});

describe("paid from another wallet", () => {
  it("the payer can say so only for a rail another wallet can pay, and only while the request is open", async () => {
    const { desk, sent } = setup([record({ id: "u", target: usdt() }), record({ id: "c", target: cashuTarget() }), record({ id: "a", target: ark() }), record({ id: "s", state: "settled", invoice: INVOICE })]);
    await desk.start();
    for (const id of ["u", "c"]) await expect(desk.checkPayment({ linkId: "l", paymentId: id }), id).rejects.toThrow("cannot be paid from another wallet");
    await desk.checkPayment({ linkId: "l", paymentId: "s" });
    await desk.checkPayment({ linkId: "l", paymentId: "a" });
    expect(sent.map((s) => s.frame.endpoint)).toEqual([[ENDPOINT.arkade, CHECK]]);
  });

  it("the payee looks at its Bark wallet when told, and a wallet that cannot be asked right now changes nothing", async () => {
    const { desk, barkWallet, lightning, state } = setup([record({ id: "k", direction: "out", target: bark() }), record({ id: "n", direction: "out", invoice: INVOICE }), record({ id: "u", direction: "out", target: usdt(), unit: "testusdt" })]);
    await desk.start();
    const check = (requestId: string, endpoint: [string, string]) => desk.onPayment("l", { id: `c-${requestId}`, requestId, timestamp: 1, amount: { value: "100", asset: "sat" }, endpoint });
    await check("k", [ENDPOINT.bark, CHECK]);
    expect(barkWallet.adapter.sync).toHaveBeenCalledOnce();
    expect(barkWallet.adapter.received).toHaveBeenCalledWith("tark1bark", 100, 1, expect.any(Set));
    lightning.check.mockRejectedValueOnce(new Error("offline"));
    await check("n", [ENDPOINT.bolt11, INVOICE]);
    await check("u", [ENDPOINT.bolt11, INVOICE]);
    expect(lightning.check).toHaveBeenCalledOnce();
    expect(["k", "n", "u"].map((id) => state(id)?.state)).toEqual(["pending", "pending", "pending"]);
  });
});

describe("what our own Lightning wallet says", () => {
  it("an invoice paid settles only a request still open; a melt resolved touches only a request we were paying", async () => {
    const { desk, sent, state } = setup([
      record({ id: "mine", direction: "out", invoice: INVOICE }), record({ id: "done", direction: "out", state: "settled" }),
      record({ id: "theirs", state: "settled", lightningPending: true }),
    ]);
    await desk.start();
    await desk.onLightningPaid({ paymentId: "done" });
    await desk.onLightningPaid({});
    expect(sent).toEqual([]);
    await desk.onQuotePaid({ paymentId: "mine", mint: MINT } as never);
    expect(state("mine")).toMatchObject({ state: "settled", mint: MINT });
    expect(sent).toEqual([{ kind: "res", frame: { id: "mine", ok: true } }]);
    await desk.onLightningResolved({ paymentId: "done" }, false);
    expect(state("done")?.error, "our own request is not ours to pay").toBeUndefined();
    await desk.onLightningResolved({ paymentId: "theirs", mint: "https://late.mint" }, true);
    expect(state("theirs")).toMatchObject({ state: "settled", lightningPending: undefined });
    expect(state("theirs")?.mint, "already settled: nothing else changes").toBeUndefined();
  });
});

describe("forgetting a chat", () => {
  it("drops its records but keeps ecash the contact has not taken", async () => {
    const { desk, state } = setup([
      record({ id: "pending", kind: "payment", direction: "out", token: "t1" }),
      record({ id: "failed", kind: "payment", direction: "out", state: "failed", token: "t2" }),
      record({ id: "settled", kind: "payment", direction: "out", state: "settled" }),
      record({ id: "reclaimed", kind: "payment", direction: "out", state: "reclaimed" }),
      record({ id: "request" }),
      record({ id: "elsewhere", linkId: "other" }),
    ]);
    await desk.start();
    await desk.forgetLink("l");
    expect(rows<StoredPayment>("payments").map((p) => p.id).sort()).toEqual(["elsewhere", "failed", "pending"]);
    expect(Object.keys(desk.views()).sort()).toEqual(["elsewhere", "failed", "pending"]);
    expect(desk.views().pending, "the token never reaches a page").not.toHaveProperty("token");
    expect(state("pending")?.token).toBe("t1");
  });
});

describe("replaying after a reconnect", () => {
  const past = Date.now() - 1;
  const stored = () => [
    record({ id: "cashu-pay", kind: "payment", direction: "out", token: "cashuBsame", requestId: "r0" }),
    record({ id: "cashu-req", direction: "out", invoice: INVOICE, mints: [MINT] }),
    record({ id: "cashu-done", kind: "payment", direction: "out", state: "settled" }),
    record({ id: "incoming", invoice: INVOICE }),
    record({ id: "usdt-req", direction: "out", unit: "testusdt", target: usdt() }),
    record({ id: "usdt-old", direction: "out", unit: "testusdt", target: usdt({ expiresAt: past }) }),
    record({ id: "usdt-pay", kind: "payment", direction: "out", unit: "testusdt", target: usdt(), txid: "0x" + tx("a") }),
    record({ id: "usdt-failed", kind: "payment", direction: "out", unit: "testusdt", target: usdt(), txid: "0x" + tx("b"), state: "failed" }),
    record({ id: "bark-req", direction: "out", target: bark() }),
    record({ id: "bark-old", direction: "out", target: bark("tark1old", { expiresAt: past }) }),
    record({ id: "bark-pay", kind: "payment", direction: "out", target: bark(), state: "settled", txid: tx("c") }),
    record({ id: "ark-req", direction: "out", target: ark() }),
    record({ id: "ark-pay", kind: "payment", direction: "out", target: ark(), state: "settled", txid: tx("d") }),
    record({ id: "ark-unsure", kind: "payment", direction: "out", target: ark(), txid: tx("e") }),
  ];

  it("says again, per rail, what is still open or already went out: the same token and ids, never a new spend", async () => {
    const { desk, sent, wallet } = setup(stored());
    await desk.start();
    await desk.replay("l");
    expect(sent.map((s) => [s.kind, s.frame.id])).toEqual([
      ["pay", "cashu-pay"], ["req", "cashu-req"], ["req", "usdt-req"], ["pay", "usdt-pay"], ["req", "bark-req"], ["pay", "bark-pay"], ["req", "ark-req"], ["pay", "ark-pay"],
    ]);
    expect(sent[0].frame).toMatchObject({ requestId: "r0", endpoint: [ENDPOINT.cashu, "cashuBsame"] });
    expect(sent[1].frame.endpoints).toEqual([[ENDPOINT.bolt11, INVOICE], [ENDPOINT.cashu, cashuRequestPayload([MINT])]]);
    expect(wallet.createToken).not.toHaveBeenCalled();
  });

  it("says nothing on a rail the chat lost, nor about ecash being taken back, nor to a chat without payments", async () => {
    const { desk, sent, link, wallet } = setup(stored());
    await desk.start();
    link.supportsUsdtPayments = link.supportsBarkPayments = link.supportsArkPayments = false;
    wallet.receiveToken.mockReturnValue(new Promise(() => {}));
    void desk.reclaim("cashu-pay");
    await desk.replay("l");
    expect(sent.map((s) => s.frame.id)).toEqual(["cashu-req"]);
    link.supportsPayments = false;
    await desk.replay("l");
    expect(sent).toHaveLength(1);
  });
});

describe("USDT receipts", () => {
  const txid = "0x" + tx("a");
  it("our send is said in the chat and to the contact while it is not failed, and settles the request once confirmed", async () => {
    const { desk, sent, link, state } = setup([record({ id: "r", unit: "testusdt", target: usdt(), amount: 2_000_000 })]);
    await desk.start();
    const r = (extra: Partial<PaymentReview>) => review(usdt(), { amount: 2_000_000, requestId: "r", txid, ...extra });
    await desk.recordUsdt(r({ method: "arkade" }));
    await desk.recordUsdt(r({ txid: undefined }));
    await desk.recordUsdt(r({ state: "pending" }));
    expect(rows("payments")).toHaveLength(1);
    await desk.recordUsdt(r({ state: "submitted" }));
    expect(state("rv")).toMatchObject({ state: "pending", unit: "testusdt", txid });
    expect(state("r")?.state).toBe("pending");
    await desk.recordUsdt(r({ state: "settled" }));
    expect(state("r")?.state).toBe("settled");
    await desk.recordUsdt(r({ id: "rv2", state: "failed", error: "reverted" }));
    link.supportsUsdtPayments = false;
    await desk.recordUsdt(r({ id: "rv3", state: "unknown" }));
    expect(state("rv2")).toMatchObject({ state: "failed", error: "reverted" });
    expect(sent.map((s) => s.frame.id)).toEqual(["rv", "rv"]);
  });

  it("the payee checks a receipt on its own chain, and takes only a well-formed one for the exact request", async () => {
    const { desk, usdtWallet, state } = setup([
      record({ id: "r", direction: "out", unit: "testusdt", target: usdt(), amount: 2_000_000 }),
      record({ id: "p-other", kind: "payment", linkId: "other", requestId: "r" }),
    ]);
    await desk.start();
    const pay = (id: string, payload: string, value = "2000000") => desk.onPayment("l", { id, requestId: "r", timestamp: 1, amount: { value, asset: "testusdt" }, endpoint: [ENDPOINT.usdt, payload] });
    await pay("p1", "{nope");
    await pay("p2", JSON.stringify({ txid: "0x1234" }));
    await pay("p3", JSON.stringify({ txid }), "1");
    await pay("p-other", JSON.stringify({ txid }));
    expect(["p1", "p2", "p3"].map((id) => state(id))).toEqual([undefined, undefined, undefined]);
    expect(state("p-other")?.linkId, "another chat's record is not taken over").toBe("other");

    usdtWallet.adapter.receipt.mockRejectedValueOnce(new Error("rpc down"));
    await pay("p4", JSON.stringify({ txid }));
    expect(state("p4")).toMatchObject({ state: "pending", txid });
    usdtWallet.adapter.receipt.mockResolvedValueOnce({ failed: true, error: "reverted" });
    await desk.reconcileUsdtReceipts();
    expect(state("p4")).toMatchObject({ state: "failed", error: "reverted" });
    expect(state("r")?.state).toBe("pending");
  });
});

describe("Ark receipts", () => {
  it("our settled Ark send is recorded, settles the request, and the contact is told when the chat has Ark", async () => {
    const { desk, sent, link, state } = setup([record({ id: "r", target: ark() })]);
    await desk.start();
    await desk.recordArk(review(ark(), { state: "submitted", requestId: "r", txid: tx("a") }));
    await desk.recordArk(review(ark(), { requestId: "r" }));
    expect(rows("payments"), "nothing is said before it is settled, or without a txid").toHaveLength(1);
    await desk.recordArk(review(ark(), { requestId: "r", txid: tx("a") }));
    expect(state("rv")).toMatchObject({ kind: "payment", direction: "out", state: "settled", txid: tx("a") });
    expect(state("r")?.state).toBe("settled");
    link.supportsArkPayments = false;
    await desk.recordArk(review(ark(), { id: "rv2", txid: tx("b") }));
    expect(sent.map((s) => s.frame.id)).toEqual(["rv"]);
  });

  it("a receipt is checked against our Ark server; one for another amount, a bad txid, or money that paid another request is ignored", async () => {
    const { desk, arkWallet, link, sent, state } = setup([
      record({ id: "r", direction: "out", target: ark("tark1mine") }),
      record({ id: "r-old", direction: "out", target: ark("tark1old"), state: "settled", txid: tx("f") }),
    ]);
    await desk.start();
    const pay = (id: string, payload: string, value = "100") => desk.onPayment("l", { id, requestId: "r", timestamp: 1, amount: { value, asset: "sat" }, endpoint: [ENDPOINT.arkade, payload] });
    await pay("p1", JSON.stringify({ txid: tx("a") }), "99");
    await pay("p2", "{nope");
    await pay("p3", JSON.stringify({ txid: "ab" }));
    await pay("p4", JSON.stringify({ txid: tx("f") }));
    link.supportsArkPayments = false;
    await pay("p5", JSON.stringify({ txid: tx("a") }));
    link.supportsArkPayments = true;
    expect(["p1", "p2", "p3", "p4", "p5"].map((id) => state(id))).toEqual([undefined, undefined, undefined, undefined, undefined]);

    arkWallet.adapter.verifyReceipt.mockResolvedValue(true);
    await pay("p6", JSON.stringify({ txid: tx("a") }));
    expect(arkWallet.adapter.verifyReceipt).toHaveBeenCalledWith(tx("a"), "tark1mine", 100);
    expect(state("p6")?.state).toBe("settled");
    expect(state("r")).toMatchObject({ state: "settled", txid: tx("a") });
    expect(sent).toEqual([{ kind: "res", frame: { id: "r", ok: true } }]);
    await pay("p6", JSON.stringify({ txid: tx("a") }));
    expect(arkWallet.adapter.verifyReceipt, "a settled receipt is not checked again").toHaveBeenCalledOnce();
  });

  it("requests and receipts of another Ark server or network are left for it", async () => {
    const { desk, arkWallet, state } = setup([
      record({ id: "r1", direction: "out", target: ark("tark1a", { provider: "https://other.ark" }) }),
      record({ id: "r2", direction: "out", target: ark("tark1b", { network: "regtest" }) }),
      record({ id: "p1", kind: "payment", requestId: "r1", target: ark("tark1a", { provider: "https://other.ark" }), txid: tx("a") }),
    ]);
    await desk.start();
    arkWallet.adapter.received.mockResolvedValue(tx("b"));
    arkWallet.adapter.verifyReceipt.mockResolvedValue(true);
    await desk.reconcileArkReceipts();
    expect(arkWallet.adapter.received).not.toHaveBeenCalled();
    expect(arkWallet.adapter.verifyReceipt).not.toHaveBeenCalled();
    expect(["r1", "r2", "p1"].map((id) => state(id)?.state)).toEqual(["pending", "pending", "pending"]);
  });

  it("a request our server saw paid settles the contact's pending receipt with it", async () => {
    const { desk, arkWallet, state } = setup([record({ id: "r", direction: "out", target: ark() }), record({ id: "p", kind: "payment", requestId: "r", target: ark(), txid: tx("a") })]);
    await desk.start();
    arkWallet.adapter.received.mockResolvedValue(tx("a"));
    await desk.reconcileArkReceipts();
    expect([state("r")?.state, state("p")?.state]).toEqual(["settled", "settled"]);
  });
});

describe("reviewed Cashu sends", () => {
  it("publishes the token only for the reviewed payment its outbox recorded", async () => {
    const outbox = record({ id: "rv", kind: "payment", direction: "out", token: "cashuBrv", requestId: "r", target: cashuTarget() });
    const { desk, sent, texts } = setup([outbox]);
    await expect(desk.recordCashu(review(ark()), "cashuBx")).rejects.toThrow("Cashu chat recipient missing");
    await expect(desk.recordCashu(review(cashuTarget(), { linkId: undefined }), "cashuBx")).rejects.toThrow("Cashu chat recipient missing");
    await expect(desk.recordCashu(review(cashuTarget(), { id: "nope", requestId: "r" }), "cashuBx")).rejects.toThrow("does not match");
    await expect(desk.recordCashu(review(cashuTarget(), { requestId: "other" }), "cashuBx")).rejects.toThrow("does not match");
    expect(sent).toEqual([]);
    await desk.recordCashu(review(cashuTarget(), { requestId: "r", memo: "tea" }), "cashuBrv");
    expect(sent[0].frame).toMatchObject({ id: "rv", requestId: "r", memo: "tea", endpoint: [ENDPOINT.cashu, "cashuBrv"] });
    expect(texts()).toEqual(["100 sats via Cashu"]);
    expect(desk.payment("rv")).toMatchObject({ state: "pending" });
  });

  it("a reviewed send the mint says is spent settles, with its request, only for its own chat", async () => {
    const { desk, state } = setup([record({ id: "r" }), record({ id: "rv", kind: "payment", direction: "out", token: "cashuBrv", requestId: "r", target: cashuTarget() })]);
    await desk.start();
    await desk.confirmReviewedCashu(review(cashuTarget(), { state: "submitted" }));
    await desk.confirmReviewedCashu(review(cashuTarget(), { linkId: "other" }));
    expect(state("rv")?.state).toBe("pending");
    await desk.confirmReviewedCashu(review(cashuTarget()));
    expect(state("rv")).toMatchObject({ state: "settled", token: undefined });
    expect(state("r")?.state).toBe("settled");
  });
});

describe("the reviewed Cashu adapter", () => {
  const prepared: CashuPrepared = { mint: MINT, swap: {} as CashuPrepared["swap"] };
  function adapter() {
    const wallet = {
      prepareReviewedCashu: vi.fn(async () => ({ fee: 2, prepared })),
      executeReviewedCashu: vi.fn(async () => "cashuBfresh"),
      reviewedCashuSpent: vi.fn(async () => false),
      recoverReviewedCashu: vi.fn(async (): Promise<string | undefined> => "cashuBrecovered"),
    };
    const order: string[] = [];
    const publish = vi.fn(async (_review: PaymentReview, token: string) => { order.push(`publish ${token}`); });
    return { wallet, publish, order, cashu: new CashuAdapter(wallet as unknown as CashuWallet, publish) };
  }

  it("prepares only a Cashu target on the network its mint belongs to, within the fee cap", async () => {
    const { cashu, wallet } = adapter();
    await expect(cashu.prepare(ark(), 100, 10)).rejects.toThrow("mint/network mismatch");
    await expect(cashu.prepare({ ...cashuTarget(), network: "cashu-test" }, 100, 10), "a real mint is not test money").rejects.toThrow("mint/network mismatch");
    await expect(cashu.prepare({ ...cashuTarget(), provider: "https://testnut.cashu.space" }, 100, 10), "the test mint is not real money").rejects.toThrow("mint/network mismatch");
    await expect(cashu.prepare({ ...cashuTarget(), provider: "http://127.0.0.1:3338" }, 100, 10), "a mint on this machine is not real money").rejects.toThrow("mint/network mismatch");
    expect(wallet.prepareReviewedCashu).not.toHaveBeenCalled();
    await expect(cashu.prepare(cashuTarget(), 100, 1)).rejects.toThrow("fee exceeds your limit");
    // A Testnet wallet's own mint on this machine pays in test sats, as its card says.
    expect(await cashu.prepare({ ...cashuTarget(), provider: "http://127.0.0.1:3338", network: "cashu-test" }, 100, 2)).toEqual({ fee: 2, prepared });
    expect(await cashu.prepare({ ...cashuTarget(), provider: "https://testnut.cashu.space", network: "cashu-test" }, 100, 2)).toEqual({ fee: 2, prepared });
  });

  it("sends only to a chat recipient, writes the token down before publishing it, and says whether it was taken", async () => {
    const { cashu, wallet, publish, order } = adapter();
    await expect(cashu.execute(review(cashuTarget(), { linkId: undefined }), prepared)).rejects.toThrow("authenticated chat recipient");
    expect(wallet.executeReviewedCashu).not.toHaveBeenCalled();
    wallet.reviewedCashuSpent.mockResolvedValue(true);
    expect(await cashu.execute(review(cashuTarget()), prepared, async () => { order.push("persist"); })).toEqual({ settled: true });
    expect(order).toEqual(["persist", "publish cashuBfresh"]);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("reconciling repeats the very same token, never a new one, and nothing once it was taken", async () => {
    const { cashu, wallet, publish } = adapter();
    expect(await cashu.reconcile(review(cashuTarget()), { ...prepared, token: "cashuBkept" })).toEqual({ settled: false });
    expect(publish).toHaveBeenLastCalledWith(expect.anything(), "cashuBkept");
    await cashu.reconcile(review(cashuTarget()), prepared);
    expect(publish).toHaveBeenLastCalledWith(expect.anything(), "cashuBrecovered");
    wallet.recoverReviewedCashu.mockResolvedValueOnce(undefined);
    await cashu.reconcile(review(cashuTarget()), prepared);
    wallet.reviewedCashuSpent.mockResolvedValue(true);
    expect(await cashu.reconcile(review(cashuTarget()), { ...prepared, token: "cashuBkept" })).toEqual({ settled: true });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(wallet.executeReviewedCashu).not.toHaveBeenCalled();
  });
});

describe("on-chain and Bark receipts", () => {
  it("a review whose id is someone else's record changes nothing; a chat without on-chain is not told", async () => {
    const { desk, sent, link, state } = setup([record({ id: "rv", kind: "payment", direction: "in", target: btc(), txid: tx("0") })]);
    await desk.start();
    await desk.recordBitcoin(review(btc(), { state: "submitted", txid: tx("1") }));
    expect(state("rv")).toMatchObject({ direction: "in", txid: tx("0") });
    link.supportsBitcoinPayments = false;
    await desk.recordBitcoin(review(btc(), { id: "rv2", state: "submitted", txid: tx("1") }));
    expect(state("rv2")?.state).toBe("pending");
    expect(sent).toEqual([]);
  });

  it("a receipt for an on-chain request already paid is recorded as paid, with the txid our wallet saw", async () => {
    const { desk, texts, state } = setup([record({ id: "r", direction: "out", target: btc(), state: "settled", txid: tx("9") }), record({ id: "known", kind: "payment", requestId: "r", linkId: "other" })]);
    await desk.start();
    const pay = (id: string) => desk.onPayment("l", { id, requestId: "r", timestamp: 4, amount: { value: "100", asset: "sat" }, endpoint: [ENDPOINT.bitcoin, JSON.stringify({ txid: tx("1") })] });
    await pay("known");
    expect(state("known")?.linkId).toBe("other");
    await pay("p");
    expect(state("p")).toMatchObject({ state: "settled", txid: tx("9") });
    expect(texts()).toEqual(["100 test sats on-chain"]);
  });

  it("a source that cannot be asked leaves an on-chain request open", async () => {
    const { desk, bitcoin, state } = setup([record({ id: "r", direction: "out", target: btc() })]);
    await desk.start();
    bitcoin.received.mockRejectedValue(new Error("esplora down"));
    await desk.reconcileBitcoinReceipts();
    expect(state("r")?.state).toBe("pending");
    const bare = new PaymentDesk({} as CashuWallet, { getLink: () => null, storeMessage: vi.fn(), onChange: vi.fn() });
    await expect(bare.reconcileBitcoinReceipts()).resolves.toBeUndefined();
  });

  it("a Bark receipt for a request already paid is recorded as paid; one already known, or a request of another server, is left", async () => {
    const { desk, barkWallet, texts, state } = setup([
      record({ id: "r", direction: "out", target: bark(), state: "settled", txid: tx("7") }),
      record({ id: "r2", direction: "out", target: bark("tark1else", { provider: "https://other.bark" }) }),
    ]);
    await desk.start();
    const pay = (id: string, requestId = "r") => desk.onPayment("l", { id, requestId, timestamp: 4, amount: { value: "100", asset: "sat" }, endpoint: [ENDPOINT.bark, JSON.stringify({ txid: tx("1") })] });
    await pay("p");
    expect(state("p")).toMatchObject({ state: "settled", txid: tx("7") });
    expect(texts()).toEqual(["100 test sats on Bark"]);
    await pay("p");
    expect(texts(), "said once").toHaveLength(1);
    await pay("p2", "r2");
    expect(barkWallet.adapter.received, "another Bark server's request is not asked about").not.toHaveBeenCalled();
    expect(state("r2")?.state).toBe("pending");
  });

  it("with no open Bark request the wallet is not even synced", async () => {
    const { desk, barkWallet } = setup([record({ id: "r", direction: "out", target: bark(), state: "settled" })]);
    await desk.start();
    await desk.reconcileBarkReceipts();
    expect(barkWallet.adapter.sync).not.toHaveBeenCalled();
  });
});

describe("sending ecash", () => {
  it("is refused offline, or when Cashu is off in the chat, before any ecash is made", async () => {
    const { desk, wallet, allowed, net } = setup();
    allowed.cashu = false;
    await expect(desk.send({ linkId: "l", amount: 10, timestamp: 1 })).rejects.toThrow("Cashu is off in this chat");
    net.online = false;
    await expect(desk.send({ linkId: "l", amount: 10, timestamp: 1 })).rejects.toThrow("You are offline");
    expect(wallet.createToken).not.toHaveBeenCalled();
  });

  it("the token written down with the spend is the one the contact gets, and it stays ours until they answer", async () => {
    const { desk, sent, state } = setup();
    const { paymentId } = await desk.send({ linkId: "l", amount: 100, timestamp: 3, memo: " thanks ", confirmedReal: true });
    expect(sent).toEqual([{ kind: "pay", frame: { id: paymentId, timestamp: 3, requestId: undefined, amount: { value: "100", asset: "sat" }, memo: "thanks", endpoint: [ENDPOINT.cashu, "cashuBtoken"] } }]);
    expect(desk.payment(paymentId)).toMatchObject({ state: "pending", token: "cashuBtoken", mint: MINT });
    expect(state(paymentId), "the wallet's outbox, not the desk, wrote it").toBeUndefined();
  });
});

describe("receipts that do not add up", () => {
  it("a receipt id already used in another chat, or a receipt on a rail the chat lacks, is ignored", async () => {
    const { desk, link, arkWallet, state } = setup([
      record({ id: "ra", direction: "out", target: ark() }), record({ id: "rk", direction: "out", target: bark() }), record({ id: "rb", direction: "out", target: btc() }),
      record({ id: "taken", kind: "payment", linkId: "other" }),
    ]);
    await desk.start();
    const pay = (id: string, requestId: string, endpoint: string, payload = JSON.stringify({ txid: tx("a") })) => desk.onPayment("l", { id, requestId, timestamp: 1, amount: { value: "100", asset: "sat" }, endpoint: [endpoint, payload] });
    await pay("taken", "ra", ENDPOINT.arkade);
    await pay("taken", "rk", ENDPOINT.bark);
    await pay("taken", "rb", ENDPOINT.bitcoin);
    await pay("p1", "rb", ENDPOINT.bitcoin, "{nope");
    link.supportsBarkPayments = link.supportsBitcoinPayments = false;
    await pay("p2", "rk", ENDPOINT.bark);
    await pay("p3", "rb", ENDPOINT.bitcoin);
    expect(state("taken")?.linkId).toBe("other");
    expect(["p1", "p2", "p3"].map((id) => state(id))).toEqual([undefined, undefined, undefined]);
    expect(arkWallet.adapter.verifyReceipt).not.toHaveBeenCalled();
  });

  it("an Ark or Bark wallet that cannot answer right now leaves everything open", async () => {
    const { desk, arkWallet, barkWallet, state } = setup([
      record({ id: "ra", direction: "out", target: ark() }), record({ id: "pa", kind: "payment", requestId: "ra", target: ark(), txid: tx("a") }),
      record({ id: "rk", direction: "out", target: bark() }),
    ]);
    await desk.start();
    arkWallet.adapter.received.mockRejectedValue(new Error("indexer down"));
    arkWallet.adapter.verifyReceipt.mockRejectedValue(new Error("indexer down"));
    barkWallet.adapter.received.mockRejectedValue(new Error("server down"));
    barkWallet.adapter.sync.mockRejectedValue(new Error("server down"));
    await desk.reconcileArkReceipts();
    await desk.reconcileBarkReceipts();
    expect(["ra", "pa", "rk"].map((id) => state(id)?.state)).toEqual(["pending", "pending", "pending"]);
  });

  it("a USDT request of an unreadable target or an impossible amount is not kept", async () => {
    const { desk } = setup();
    const request = (id: string, value: string, payload = JSON.stringify(usdt())) => desk.onPaymentRequest("l", { id, timestamp: 1, amount: { value, asset: "testusdt" }, endpoints: [[ENDPOINT.usdt, payload]] });
    await request("u1", "10", "{nope");
    await request("u2", "9999999999999999");
    await request("u3", "10");
    expect([desk.payment("u1"), desk.payment("u2"), desk.payment("u3")?.amount]).toEqual([undefined, undefined, 10]);
  });

  it("a replay on a chat that lost on-chain Bitcoin says nothing about it", async () => {
    const { desk, sent, link } = setup([record({ id: "rb", direction: "out", target: btc() })]);
    await desk.start();
    link.supportsBitcoinPayments = false;
    await desk.replay("l");
    expect(sent).toEqual([]);
  });
});

describe("a request closed because its wallet was removed", () => {
  it("is never sent again, and the contact is told in its own words", async () => {
    const { desk, sent, state } = setup([
      record({ id: "ark", direction: "out", target: ark() }),
      record({ id: "ln", direction: "out", invoice: INVOICE, mints: [MINT] }),
      record({ id: "done", direction: "out", target: ark(), state: "settled" }),
    ]);
    await desk.start();
    await desk.replay("l");
    expect(sent.filter((s) => s.kind === "req").map((s) => s.frame.id).sort()).toEqual(["ark", "ln"]);

    sent.length = 0;
    expect(await desk.close("ark", "you removed the Mainnet Ark wallet it was paid to", "your contact removed the wallet it was paid to")).toBe(true);
    expect(await desk.close("done", "x", "y"), "a paid request stays paid").toBe(false);
    expect(state("ark")).toMatchObject({ state: "failed", closed: true, error: "you removed the Mainnet Ark wallet it was paid to" });
    expect(state("done")?.state).toBe("settled");
    expect(sent).toEqual([{ kind: "res", frame: { id: "ark", ok: false, error: "your contact removed the wallet it was paid to", closed: true } }]);

    sent.length = 0;
    await desk.replay("l");
    expect(sent.filter((s) => s.kind === "req").map((s) => s.frame.id)).toEqual(["ln"]);
  });

  it("on the payer's side it closes too, unless a Lightning payment for it is already in flight; nobody else can close it", async () => {
    const { desk, state } = setup([
      record({ id: "open", invoice: INVOICE }),
      record({ id: "flying", invoice: INVOICE, lightningPending: true }),
      record({ id: "ours", direction: "out", invoice: INVOICE }),
      record({ id: "other-chat", linkId: "m", invoice: INVOICE }),
    ]);
    await desk.start();
    // A bare refusal about a request changes nothing: only "closed", said in as many words, does.
    await desk.onPaymentResult("l", { id: "open", ok: false, error: "nope" });
    expect(state("open")?.state).toBe("pending");
    for (const id of ["open", "flying", "ours", "other-chat"]) await desk.onPaymentResult("l", { id, ok: false, error: "your contact removed the wallet it was paid to", closed: true });
    expect(state("open")).toMatchObject({ state: "failed", closed: true, error: "your contact removed the wallet it was paid to" });
    expect(state("flying")).toMatchObject({ state: "pending", lightningPending: true });
    expect(state("ours")?.state, "a contact never closes a request of ours").toBe("pending");
    expect(state("other-chat")?.state).toBe("pending");
    await expect(desk.payRequest({ linkId: "l", paymentId: "open", via: "lightning" })).rejects.toThrow("no longer open");
  });
});
