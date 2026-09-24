import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINT, cashuRequestPayload, type GhostLink } from "@ghostly/core";
import { PaymentDesk } from "../src/engine/payments";
import type { CashuWallet } from "../src/engine/wallet";
import type { PendingMelt, StoredPayment } from "../src/shared/types";
import { resetDb, rows, seed } from "./fakes";
// covers: payments.cashu.send, payments.cashu.request, payments.cashu.reclaim, payments.cashu.test-sats, payments.lightning.request, payments.chat.methods, payments.chat.refused, payments.chat.reconcile, payments.arkade.send

vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);

const MINT = "https://mint.example";

const sentPayment: StoredPayment = {
  id: "p1",
  linkId: "l1",
  kind: "payment",
  direction: "out",
  amount: 40,
  unit: "sat",
  state: "pending",
  createdAt: 0,
  mint: MINT,
  token: "cashuBtoken",
};

const incomingRequest: StoredPayment = {
  id: "r1",
  linkId: "l1",
  kind: "request",
  direction: "in",
  amount: 40,
  unit: "sat",
  state: "pending",
  createdAt: 0,
  invoice: "lnbc40",
  mints: [MINT],
};

async function setup(stored: StoredPayment[]) {
  seed("payments", stored);
  const wallet = {
    receiveToken: vi.fn(),
    createToken: vi.fn(),
    quoteInvoice: vi.fn().mockResolvedValue({ quote: "m1", mint: MINT, amount: 40, feeReserve: 2 }),
    payQuote: vi.fn(),
  };
  const allowed: Record<string, boolean> = { cashu: true, lightning: true };
  const link = { requirePaymentSupport: vi.fn(), connect: vi.fn(), sendPayment: vi.fn(), sendPaymentResult: vi.fn(), allowsPayment: vi.fn((m: string) => allowed[m] ?? false) };
  const host = { getLink: () => link as unknown as GhostLink, storeMessage: vi.fn(), onChange: vi.fn(), onReviewedPaymentResult: vi.fn(), onReviewedPaymentRefused: vi.fn() };
  const desk = new PaymentDesk(wallet as unknown as CashuWallet, host);
  await desk.start();
  const state = (id: string) => rows<StoredPayment>("payments").find((p) => p.id === id);
  return { desk, wallet, link, state, allowed, host };
}

beforeEach(() => resetDb());

describe("reclaim", () => {
  it("redeems once when two reclaims race, and ends up reclaimed", async () => {
    const { desk, wallet, state } = await setup([sentPayment]);
    let redeem!: () => void;
    wallet.receiveToken.mockImplementationOnce(() => new Promise<void>((resolve) => (redeem = resolve)));
    wallet.receiveToken.mockRejectedValue(new Error("Token already spent"));

    const first = desk.reclaim("p1");
    const second = desk.reclaim("p1");
    redeem();
    await Promise.all([first, second]);

    expect(wallet.receiveToken).toHaveBeenCalledOnce();
    expect(state("p1")).toMatchObject({ state: "reclaimed" });
    expect(state("p1")?.token).toBeUndefined();
  });

  it("calls a spent token settled only while the payment is still pending", async () => {
    const { desk, wallet, state } = await setup([sentPayment, { ...sentPayment, id: "p2", state: "failed" }]);
    wallet.receiveToken.mockRejectedValue(new Error("Token already spent"));
    await desk.reclaim("p1");
    await desk.reclaim("p2");
    expect(state("p1")).toMatchObject({ state: "settled" });
    expect(state("p2")).toMatchObject({ state: "failed" });
  });
});

describe("paying a request", () => {
  it("falls back to Lightning when no ecash could be made", async () => {
    const { desk, wallet, state } = await setup([incomingRequest]);
    wallet.createToken.mockRejectedValue(new Error("Not enough sats in your wallet"));
    wallet.payQuote.mockResolvedValue(true);
    await desk.payRequest({ linkId: "l1", paymentId: "r1" });
    expect(wallet.payQuote).toHaveBeenCalledOnce();
    expect(state("r1")).toMatchObject({ state: "settled", mint: MINT });
  });

  it("never pays over Lightning once a token exists", async () => {
    const { desk, wallet, link } = await setup([incomingRequest]);
    wallet.createToken.mockImplementation(async (_amount, _mints, _memo, outbox) => {
      outbox("cashuBtoken", MINT);
      return { token: "cashuBtoken", mint: MINT };
    });
    link.sendPayment.mockRejectedValue(new Error("The contact went away"));
    wallet.receiveToken.mockRejectedValue(new Error("Token already spent"));
    await expect(desk.payRequest({ linkId: "l1", paymentId: "r1" })).rejects.toThrow(/went away/);
    expect(wallet.quoteInvoice).not.toHaveBeenCalled();
    expect(wallet.payQuote).not.toHaveBeenCalled();
  });

  it("reports a pending Lightning payment as pending, refuses to pay twice, and settles when the mint pays", async () => {
    const { desk, wallet, state } = await setup([incomingRequest]);
    wallet.createToken.mockRejectedValue(new Error("You share no mint with this contact"));
    wallet.payQuote.mockResolvedValue(false);

    await desk.payRequest({ linkId: "l1", paymentId: "r1" });
    expect(state("r1")).toMatchObject({ state: "pending", lightningPending: true });
    await expect(desk.payRequest({ linkId: "l1", paymentId: "r1" })).rejects.toThrow(/still pending/);

    await desk.onMeltResolved({ quote: "m1", mint: MINT, paymentId: "r1" } as PendingMelt, true);
    expect(state("r1")).toMatchObject({ state: "settled", mint: MINT });
    expect(state("r1")?.lightningPending).toBeUndefined();
  });

  it("opens the request again when a pending Lightning payment fails", async () => {
    const { desk, wallet, state } = await setup([incomingRequest]);
    wallet.createToken.mockRejectedValue(new Error("You share no mint with this contact"));
    wallet.payQuote.mockResolvedValue(false);
    await desk.payRequest({ linkId: "l1", paymentId: "r1" });
    await desk.onMeltResolved({ quote: "m1", mint: MINT, paymentId: "r1" } as PendingMelt, false);
    expect(state("r1")).toMatchObject({ state: "pending", error: "The Lightning payment did not go through" });
    expect(state("r1")?.lightningPending).toBeUndefined();
  });
});

describe("paired payment admission and concurrency", () => {
  it("never spends or creates a token for an incompatible peer", async () => {
    const { desk, wallet, link } = await setup([]);
    link.requirePaymentSupport.mockRejectedValue(new Error("Peer needs update"));
    await expect(desk.send({ linkId: "l1", amount: 10, timestamp: 1 })).rejects.toThrow(/update/);
    expect(wallet.createToken).not.toHaveBeenCalled();
  });
  it("coalesces simultaneous pay clicks into one spend", async () => {
    const { desk, wallet } = await setup([incomingRequest]);
    wallet.createToken.mockResolvedValue({ token: "fixture", mint: MINT });
    await Promise.all([desk.payRequest({ linkId: "l1", paymentId: "r1" }), desk.payRequest({ linkId: "l1", paymentId: "r1" })]);
    expect(wallet.createToken).toHaveBeenCalledOnce();
    await expect(desk.payRequest({ linkId: "l1", paymentId: "r1" })).rejects.toThrow(/already paid/);
  });
  it("deduplicates concurrent incoming tokens and repeats the receipt", async () => {
    const { desk, wallet, link } = await setup([]);
    wallet.receiveToken.mockResolvedValue({ amount: 10, mint: MINT });
    const payment = { id: "payment12345678", timestamp: 1, amount: { value: "10", asset: "sat" }, endpoint: ["cashu", "fixture"] as [string, string] };
    await Promise.all([desk.onPayment("l1", payment), desk.onPayment("l1", payment)]);
    expect(wallet.receiveToken).toHaveBeenCalledOnce();
    expect(link.sendPaymentResult).toHaveBeenCalledTimes(2);
    expect(link.sendPaymentResult).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true }));
  });
});

describe("ways of paying chosen per chat", () => {
  it("refuses ecash when Cashu is off in the chat, leaving the token to its sender", async () => {
    const { desk, wallet, link, allowed } = await setup([]);
    allowed.cashu = false;
    await desk.onPayment("l1", { id: "in1", timestamp: 1, amount: { value: "40", asset: "sat" }, endpoint: [ENDPOINT.cashu, "cashuBtoken"] });
    expect(wallet.receiveToken).not.toHaveBeenCalled();
    expect(link.sendPaymentResult).toHaveBeenCalledWith(expect.objectContaining({ id: "in1", ok: false, error: "Cashu is off in this chat" }));
  });
  it("keeps only the allowed ways of paying from an incoming request", async () => {
    const { desk, state, allowed } = await setup([]);
    allowed.lightning = false;
    await desk.onPaymentRequest("l1", { id: "r2", timestamp: 1, amount: { value: "40", asset: "sat" }, endpoints: [[ENDPOINT.bolt11, "lnbc40"], [ENDPOINT.cashu, cashuRequestPayload([MINT])]] });
    expect(state("r2")?.invoice).toBeUndefined();
    allowed.cashu = false;
    await desk.onPaymentRequest("l1", { id: "r3", timestamp: 1, amount: { value: "40", asset: "sat" }, endpoints: [[ENDPOINT.bolt11, "lnbc40"]] });
    expect(state("r3"), "nothing left to pay it with").toBeUndefined();
  });
  it("pays a request over Lightning without touching ecash when Cashu is off", async () => {
    const { desk, wallet, allowed } = await setup([incomingRequest]);
    allowed.cashu = false;
    wallet.payQuote.mockResolvedValue(true);
    await desk.payRequest({ linkId: "l1", paymentId: "r1" });
    expect(wallet.createToken).not.toHaveBeenCalled();
    expect(wallet.quoteInvoice).toHaveBeenCalledWith("lnbc40");
  });
  it("pays a Lightning payment reviewed as such over Lightning, never with ecash in its place, within its fee", async () => {
    const { desk, wallet, allowed, state } = await setup([incomingRequest]);
    wallet.createToken.mockResolvedValue({ token: "fixture", mint: MINT });
    wallet.payQuote.mockResolvedValue(true);
    allowed.lightning = false;
    await expect(desk.payRequest({ linkId: "l1", paymentId: "r1", via: "lightning" })).rejects.toThrow(/cannot be paid over Lightning/);
    allowed.lightning = true;
    await expect(desk.payRequest({ linkId: "l1", paymentId: "r1", via: "lightning", maxFee: 1 })).rejects.toThrow(/fee \(2 sats\) is too high/);
    await desk.payRequest({ linkId: "l1", paymentId: "r1", via: "lightning", maxFee: 2 });
    expect(wallet.createToken).not.toHaveBeenCalled();
    expect(wallet.payQuote).toHaveBeenCalledOnce();
    expect(state("r1")).toMatchObject({ state: "settled" });
  });
});

describe("a contact refusing ecash", () => {
  it("takes a refused reviewed send back instead of offering the token again", async () => {
    const reviewed: StoredPayment = { ...sentPayment, id: "rv1", target: { method: "cashu", network: "cashu-test", provider: MINT, asset: "BTC", unit: "sat", address: "peer", expiresAt: Date.now() + 60000 } };
    const { desk, wallet, host, state } = await setup([reviewed]);
    wallet.receiveToken.mockResolvedValue({ amount: 40, mint: MINT });
    await desk.onPaymentResult("l1", { id: "rv1", ok: false, error: "Ecash from mint.example is not accepted" });
    expect(wallet.receiveToken).toHaveBeenCalledWith("cashuBtoken", "reclaimed", undefined);
    expect(state("rv1")?.state).toBe("reclaimed");
    expect(host.onReviewedPaymentRefused).toHaveBeenCalledWith("rv1", "Ecash from mint.example is not accepted");
    expect(host.onReviewedPaymentResult, "no reconcile, which would publish the same token again").not.toHaveBeenCalled();
  });
  it("says in the chat when it cannot receive ecash", async () => {
    const { desk, wallet, link, host } = await setup([]);
    wallet.receiveToken.mockRejectedValue(new Error("Ecash from other.example is not accepted"));
    await desk.onPayment("l1", { id: "in2", timestamp: 7, amount: { value: "10", asset: "sat" }, endpoint: [ENDPOINT.cashu, "cashuBtoken"] });
    expect(link.sendPaymentResult).toHaveBeenCalledWith(expect.objectContaining({ id: "in2", ok: false }));
    expect(host.storeMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "peer_7_refused", text: "Could not receive 10 sats: Ecash from other.example is not accepted" }));
  });
});

describe("test sats are never money", () => {
  const TEST = "https://testnut.cashu.space", REAL = "https://mint.minibits.cash/Bitcoin";
  function desk(mints: string[]) {
    const wallet = {
      // What receiveToken does for a contact's test ecash: the test mint joins the wallet, as a secondary mint.
      receiveToken: vi.fn(async () => { if (!mints.includes(TEST)) mints.push(TEST); return { amount: wallet.nextAmount, mint: wallet.nextMint }; }),
      nextAmount: 1,
      nextMint: TEST,
      receiveLightning: vi.fn(async () => ({ invoice: "lnbc1000" })),
      view: vi.fn(async () => ({ mints: mints.map((url) => ({ url })) })),
    };
    const link = { requirePaymentSupport: vi.fn(), sendPayment: vi.fn(), sendPaymentRequest: vi.fn(), sendPaymentResult: vi.fn(), allowsPayment: () => true, supportsPayments: true };
    const host = { getLink: () => link as unknown as GhostLink, storeMessage: vi.fn(), onChange: vi.fn() };
    return { wallet, link, host, desk: new PaymentDesk(wallet as unknown as CashuWallet, host) };
  }
  const cashuMints = (link: { sendPaymentRequest: { mock: { calls: unknown[][] } } }) =>
    ((link.sendPaymentRequest.mock.calls[0][0] as { endpoints: string[][] }).endpoints.find((e) => e[0] === ENDPOINT.cashu)?.[1] ?? "");

  it("a contact cannot settle a request for real sats with test ecash", async () => {
    const { desk: d, link, host, wallet } = desk([REAL]);
    await d.start();
    await d.onPayment("l1", { id: "p0", timestamp: 1, amount: { value: "1", asset: "sat" }, endpoint: [ENDPOINT.cashu, "cashuBx"] });
    const { paymentId } = await d.request({ linkId: "l1", amount: 1000, timestamp: 2 });
    expect(cashuMints(link), "a real request never names the test mint").not.toContain("testnut");
    wallet.nextAmount = 1000;
    await d.onPayment("l1", { id: "p1", timestamp: 3, requestId: paymentId, amount: { value: "1000", asset: "sat" }, endpoint: [ENDPOINT.cashu, "cashuBy"] });
    expect(rows<StoredPayment>("payments").find((p) => p.id === paymentId)?.state).toBe("pending");
    expect(host.storeMessage.mock.calls.map((c) => (c[0] as { text: string }).text)).toContain("⚡ 1,000 test sats");
  });

  it("a request made while trying things out on the test mint is paid in test sats", async () => {
    const { desk: d, link, wallet } = desk([TEST, REAL]);
    await d.start();
    const { paymentId } = await d.request({ linkId: "l1", amount: 10, timestamp: 2 });
    expect(cashuMints(link)).toContain("testnut");
    expect(cashuMints(link)).not.toContain("minibits");
    wallet.nextAmount = 10;
    await d.onPayment("l1", { id: "p1", timestamp: 3, requestId: paymentId, amount: { value: "10", asset: "sat" }, endpoint: [ENDPOINT.cashu, "cashuBy"] });
    expect(rows<StoredPayment>("payments").find((p) => p.id === paymentId)?.state).toBe("settled");
  });

  it("an old request that named both kinds of mint is still not settled by test ecash", async () => {
    const { desk: d, wallet } = desk([REAL, TEST]);
    seed("payments", [{ id: "old", linkId: "l1", kind: "request", direction: "out", amount: 5, unit: "sat", state: "pending", createdAt: 0, mints: [REAL, TEST] }]);
    await d.start();
    wallet.nextAmount = 5;
    await d.onPayment("l1", { id: "p1", timestamp: 3, requestId: "old", amount: { value: "5", asset: "sat" }, endpoint: [ENDPOINT.cashu, "cashuBy"] });
    expect(rows<StoredPayment>("payments").find((p) => p.id === "old")?.state).toBe("pending");
    wallet.nextMint = REAL;
    await d.onPayment("l1", { id: "p2", timestamp: 4, requestId: "old", amount: { value: "5", asset: "sat" }, endpoint: [ENDPOINT.cashu, "cashuBz"] });
    expect(rows<StoredPayment>("payments").find((p) => p.id === "old")?.state).toBe("settled");
  });
});

describe("ecash taken back", () => {
  it("stays taken back when the mint later says its proofs are spent", async () => {
    seed("payments", [
      { id: "r", linkId: "l1", kind: "request", direction: "in", amount: 40, unit: "sat", state: "pending", createdAt: 0 },
      { id: "p", linkId: "l1", kind: "payment", direction: "out", amount: 40, unit: "sat", state: "reclaimed", createdAt: 0, requestId: "r", target: { method: "cashu" } },
    ]);
    const desk = new PaymentDesk({} as CashuWallet, { getLink: () => ({}) as GhostLink, storeMessage: vi.fn(), onChange: vi.fn() });
    await desk.start();
    await desk.confirmReviewedCashu({ id: "p", linkId: "l1", method: "cashu", state: "settled" } as never);
    expect(rows<StoredPayment>("payments").find((x) => x.id === "p")?.state).toBe("reclaimed");
    expect(rows<StoredPayment>("payments").find((x) => x.id === "r")?.state).toBe("pending");
  });
});

describe("the chat's inbound queue", () => {
  it("a reviewed payment's result never waits on reconciling it (that could wait on this very result)", async () => {
    seed("payments", [{ id: "p", linkId: "l1", kind: "payment", direction: "out", amount: 21, unit: "sat", state: "pending", createdAt: 0, target: { method: "cashu" } }]);
    const host = { getLink: () => ({}) as GhostLink, storeMessage: vi.fn(), onChange: vi.fn(), onReviewedPaymentResult: vi.fn(() => new Promise<void>(() => {})) };
    const desk = new PaymentDesk({} as CashuWallet, host);
    await desk.start();
    const handled = desk.onPaymentResult("l1", { id: "p", ok: true, credited: "21" });
    await expect(Promise.race([handled.then(() => "done"), new Promise((resolve) => setTimeout(() => resolve("stuck"), 200))])).resolves.toBe("done");
    expect(host.onReviewedPaymentResult).toHaveBeenCalledWith("p");
  });
});

describe("paying on Ark or USDT without a request", () => {
  const arkTarget = { method: "arkade", network: "mutinynet", provider: "https://mutinynet.arkade.sh", asset: "BTC", unit: "sat", address: "tark1fresh", expiresAt: Date.now() + 60_000 };
  function desk(supports = true) {
    const sent: { kind: string; frame: Record<string, unknown> }[] = [];
    const link = {
      requirePaymentSupport: vi.fn(async () => {}), supportsArkPayments: supports, supportsUsdtPayments: supports, allowsPayment: () => true,
      sendPaymentRequest: vi.fn(async (frame: Record<string, unknown>) => { sent.push({ kind: "req", frame }); }),
      sendPaymentAsk: vi.fn(async (frame: Record<string, unknown>) => { sent.push({ kind: "ask", frame }); }),
    };
    const host = { getLink: () => link as unknown as GhostLink, storeMessage: vi.fn(), onChange: vi.fn() };
    const ark = { target: vi.fn(async () => arkTarget) };
    return { d: new PaymentDesk({} as CashuWallet, host, ark as never), sent, link };
  }

  it("the payee's app answers an ask with an ordinary request carrying its id, a fresh address each time", async () => {
    const { d, sent } = desk();
    await d.start();
    await d.onPaymentAsk("l1", { id: "ask_000001", timestamp: 1, amount: { value: "1500", asset: "sat" }, method: "arkade", memo: "lunch" });
    expect(sent).toHaveLength(1);
    expect(sent[0].frame).toMatchObject({ ask: "ask_000001", amount: { value: "1500", asset: "sat" }, memo: "lunch" });
    expect(rows<StoredPayment>("payments")[0]).toMatchObject({ kind: "request", direction: "out", amount: 1500, ask: "ask_000001" });
  });

  it("is bounded: not too often, not too many, only ways of paying the chat allows, only sound amounts", async () => {
    vi.useFakeTimers();
    try {
      const { d, sent } = desk();
      await d.start();
      const ask = (n: number, over: Record<string, unknown> = {}) => d.onPaymentAsk("l1", { id: `ask_00000${n}`, timestamp: n, amount: { value: "10", asset: "sat" }, method: "arkade", ...over } as never);
      await ask(1); await ask(2);
      expect(sent, "a second ask within 3 s is ignored").toHaveLength(1);
      for (let n = 3; n < 10; n++) { vi.advanceTimersByTime(3_100); await ask(n); }
      expect(sent, "five open asked-for requests at most").toHaveLength(5);
      const other = desk(false);
      await other.d.onPaymentAsk("l1", { id: "ask_000009", timestamp: 1, amount: { value: "10", asset: "sat" }, method: "arkade" });
      for (const bad of [{ amount: { value: "0", asset: "sat" } }, { amount: { value: "10", asset: "usdtbase" } }]) {
        const fresh = desk();
        await fresh.d.onPaymentAsk("l1", { id: "ask_000010", timestamp: 1, method: "arkade", ...bad } as never);
        expect(fresh.sent, JSON.stringify(bad)).toEqual([]);
      }
      expect(other.sent).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("the payer takes a request as the answer only to an ask it made: same chat, way of paying and amount", async () => {
    const { d, sent } = desk();
    await d.start();
    const { askId } = await d.ask({ linkId: "l1", amount: 700, method: "arkade", timestamp: 1 });
    expect(sent[0]).toMatchObject({ kind: "ask", frame: { id: askId, amount: { value: "700", asset: "sat" }, method: "arkade" } });
    const request = (id: string, value: string, ask?: string) => d.onPaymentRequest("l1", { id, timestamp: 2, amount: { value, asset: "sat" }, endpoints: [[ENDPOINT.arkade, JSON.stringify(arkTarget)]], ask });
    await request("req_forged", "700", "ask_notmine");
    await request("req_wrongamt", "9999", askId);
    await request("req_answer", "700", askId);
    await request("req_again", "700", askId);
    const byId = (id: string) => rows<StoredPayment>("payments").find((p) => p.id === id);
    expect(byId("req_forged")?.ask).toBeUndefined();
    expect(byId("req_wrongamt")?.ask).toBeUndefined();
    expect(byId("req_answer")?.ask).toBe(askId);
    expect(byId("req_again")?.ask, "an ask is answered once").toBeUndefined();
  });
});
