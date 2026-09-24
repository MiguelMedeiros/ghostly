import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeBolt11 } from "@ghostly/core";
import { NoAnswer, NwcLightning } from "../src/engine/paymentAdapters/providers/nwc";
import { NothingSpentError } from "../src/engine/paymentAdapters/providers/types";
import { describeLightningProvider } from "./helpers/providerContract";
// covers-gated: wallet.lightning.nwc.pay, wallet.lightning.provider-contract

/**
 * NWC against a real wallet service: Alby Hub in front of a regtest LND node, and a second node on the
 * other end of a channel (e2e/infra and e2e/support/nwc-regtest, see e2e/README.md). Worthless coins; skipped unless
 * GHOSTLY_NWC_REGTEST=1, and it never starts or stops the stack. No URI is printed.
 */
const enabled = process.env.GHOSTLY_NWC_REGTEST === "1";
type Regtest = typeof import("../../../e2e/support/nwc-regtest/regtest.mjs");
const regtest = async (): Promise<Regtest> => import("../../../e2e/support/nwc-regtest/regtest.mjs");
const TIMEOUT = 60_000;
// Real payments and a real relay: the contract suite's tests need more than the default five seconds.
vi.setConfig({ testTimeout: TIMEOUT });

if (enabled) {
  describeLightningProvider("NWC (Alby Hub on regtest LND)", async () => {
    const { nwcUri, invoice, pay, balances } = await regtest();
    const provider = await NwcLightning.connect(await nwcUri("alice"));
    return {
      provider, network: "regtest",
      payIncoming: async (incoming) => { expect(pay("bob", incoming.invoice).status).toBe("SUCCEEDED"); },
      payable: async (amount) => invoice("bob", amount).invoice,
      // More than Alice's side of the channel holds: LND finds no route before any HTLC leaves.
      refused: async () => invoice("bob", balances().alice.local + 20_000).invoice,
    };
  }, { timeout: TIMEOUT });
}

describe.skipIf(!enabled)("NWC on regtest Lightning", () => {
  const opened: NwcLightning[] = [];
  afterEach(async () => { for (const p of opened.splice(0)) await p.close(); });
  const connect = async (who: "alice" | "bob", options: Parameters<typeof NwcLightning.connect>[1] = {}) => {
    const { nwcUri } = await regtest();
    const provider = await NwcLightning.connect(await nwcUri(who), options);
    opened.push(provider);
    return provider;
  };

  it("pays and receives over the channel, and both nodes' balances move by it", { timeout: TIMEOUT }, async () => {
    const { balances } = await regtest();
    const [alice, bob] = [await connect("alice"), await connect("bob")];
    expect(await alice.info()).toMatchObject({ network: "regtest" });
    const before = balances(), aliceBefore = (await alice.info()).balance!;

    const bill = await bob.createInvoice(1_234, "NWC regtest");
    expect(decodeBolt11(bill.invoice)).toMatchObject({ network: "regtest", amountSat: 1_234, paymentHash: bill.paymentHash });
    const paid = await alice.payInvoice(bill.invoice, 10);
    expect(paid).toMatchObject({ state: "paid", fee: 0 });
    await vi.waitFor(async () => expect(await bob.invoiceStatus(bill)).toEqual({ state: "paid", amount: 1_234 }), { timeout: 20_000, interval: 500 });
    expect(await alice.paymentStatus({ invoice: bill.invoice, paymentHash: bill.paymentHash })).toMatchObject({ state: "paid", fee: 0, preimage: (paid as { preimage: string }).preimage });

    const after = balances();
    expect(after.alice.local).toBe(before.alice.local - 1_234);
    expect(after.bob.local).toBe(before.bob.local + 1_234);
    expect((await alice.info()).balance).toBe(aliceBefore - 1_234);
    console.log(`NWC regtest: alice → bob 1234 sats, hash ${bill.paymentHash}; channel alice ${before.alice.local} → ${after.alice.local}, bob ${before.bob.local} → ${after.bob.local}`);
  });

  it("an answer that comes too late is unknown, and lookup_invoice finds the payment made", { timeout: TIMEOUT }, async () => {
    const { invoice } = await regtest();
    // Gives up almost at once: the hub still gets the request, and pays.
    const alice = await connect("alice", { payMs: 50 });
    const bill = invoice("bob", 321);
    const error = await alice.payInvoice(bill.invoice, 10).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoAnswer);
    expect(error).not.toBeInstanceOf(NothingSpentError);
    await vi.waitFor(async () => expect((await alice.paymentStatus({ invoice: bill.invoice, paymentHash: bill.paymentHash })).state).toBe("paid"), { timeout: 30_000, interval: 500 });
  });

  it("a payment over the app's budget is refused before anything leaves", { timeout: TIMEOUT }, async () => {
    const { nwcUri, invoice } = await regtest();
    const provider = await NwcLightning.connect(await nwcUri("alice", { budgetSat: 100 }));
    opened.push(provider);
    await expect(provider.payInvoice(invoice("bob", 500).invoice, 10)).rejects.toBeInstanceOf(NothingSpentError);
  });
});
