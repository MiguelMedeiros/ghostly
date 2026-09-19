import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GhostLink } from "@ghostly/core";
import { PaymentDesk } from "../src/engine/payments";
import type { CashuWallet } from "../src/engine/wallet";
import type { PendingMelt, StoredPayment } from "../src/shared/types";
import { resetDb, rows, seed } from "./fakes";

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
  const link = { connect: vi.fn(), sendPayment: vi.fn(), sendPaymentResult: vi.fn() };
  const desk = new PaymentDesk(wallet as unknown as CashuWallet, {
    getLink: () => link as unknown as GhostLink,
    storeMessage: vi.fn(),
    onChange: vi.fn(),
  });
  await desk.start();
  const state = (id: string) => rows<StoredPayment>("payments").find((p) => p.id === id);
  return { desk, wallet, link, state };
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
