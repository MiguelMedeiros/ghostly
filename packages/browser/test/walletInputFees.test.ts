import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNewMintKeys, deriveKeysetId } from "@cashu/cashu-ts";
import { CashuWallet } from "../src/engine/wallet";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { resetDb, seed } from "./fakes";
// covers: wallet.cashu.pay-invoice

vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);

/** Charges 1 sat for each coin it takes in (input_fee_ppk 1000). */
const FEE_MINT = "https://fee.example";
/** Charges nothing. */
const FREE_MINT = "https://free.example";
const INVOICE = fakeInvoice(30, new Uint8Array(32).fill(7));

/** A keyset of coins from 1 to 64 sats, its id derived with its fee as a mint's /v1/keysets checks it. */
const keyset = (seed: number, fee: number) => {
  const pubKeys = Object.fromEntries(Object.entries(createNewMintKeys(7, new Uint8Array(32).fill(seed)).pubKeys).map(([amount, key]) => [amount, Buffer.from(key).toString("hex")]));
  return { keysetId: deriveKeysetId(pubKeys, { input_fee_ppk: fee, unit: "sat", versionByte: 1 }), pubKeys, fee };
};
const MINTS: Record<string, ReturnType<typeof keyset>> = { [FEE_MINT]: keyset(1, 1000), [FREE_MINT]: keyset(2, 0) };
const keysetOf = (mint: string) => MINTS[mint].keysetId;

/** Real cashu-ts wallets in front of the two mints, as their /v1 endpoints would answer; a melt quote is for 30 + 2 sats. */
function mintsAnswering() {
  const answer = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const mint = MINTS[url.origin];
    if (!mint) return new Response("not found", { status: 404 });
    const id = keysetOf(url.origin);
    const method = { method: "bolt11", unit: "sat", min_amount: 1, max_amount: 1_000_000 };
    if (url.pathname === "/v1/info") return answer({ name: "Test", version: "cdk-mintd/0.17.7", nuts: { 4: { methods: [method], disabled: false }, 5: { methods: [method], disabled: false } } });
    if (url.pathname === "/v1/keysets") return answer({ keysets: [{ id, unit: "sat", active: true, input_fee_ppk: mint.fee }] });
    if (url.pathname === "/v1/keys" || url.pathname === `/v1/keys/${id}`) return answer({ keysets: [{ id, unit: "sat", active: true, input_fee_ppk: mint.fee, keys: mint.pubKeys }] });
    if (url.pathname === "/v1/melt/quote/bolt11" || url.pathname === "/v1/melt/quote/bolt11/m1") return answer({ quote: "m1", amount: 30, unit: "sat", request: INVOICE, fee_reserve: 2, state: "UNPAID", expiry: 4_000_000_000 });
    return new Response("not found", { status: 404 });
  }));
}

const coins = (mint: string, amounts: number[]) => amounts.map((amount, i) => ({ mint, id: keysetOf(mint), amount, secret: `${mint}-${i}`, C: MINTS[mint].pubKeys[1] }));

const wallet = (mints: string[]) => new CashuWallet(() => mints, { onChange: vi.fn(), onTestMintNeeded: vi.fn(async () => {}), onQuotePaid: vi.fn(), onMeltResolved: vi.fn() }, () => mints);

beforeEach(() => {
  resetDb();
  mintsAnswering();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("a send at a mint that charges for each coin it takes in", () => {
  it("goes to the next mint when what the first one holds does not cover the fees", async () => {
    seed("proofs", [...coins(FEE_MINT, [64, 32, 4]), ...coins(FREE_MINT, [64, 32, 4])]);
    const cashu = wallet([FEE_MINT, FREE_MINT]);
    await expect(cashu.createToken(100)).resolves.toMatchObject({ mint: FREE_MINT });
    expect(await cashu.balanceAt(FEE_MINT)).toBe(100);
    expect(await cashu.balanceAt(FREE_MINT)).toBe(0);
  });

  it("says how much fits with the fees when no mint can send the amount", async () => {
    seed("proofs", coins(FEE_MINT, [64, 32, 4]));
    const cashu = wallet([FEE_MINT]);
    // All three coins go as they are: 97 sats, and 3 for the receiver to redeem them.
    await expect(cashu.createToken(99)).rejects.toThrow("Not enough sats in your wallet: 97 sats leave room for the fee");
    await expect(cashu.createToken(97)).resolves.toMatchObject({ mint: FEE_MINT });
    expect(await cashu.balanceAt(FEE_MINT)).toBe(0);
  });
});

describe("a Lightning quote at a mint that charges for each coin it takes in", () => {
  it("counts the fee of the coins the payment would spend", async () => {
    seed("proofs", coins(FEE_MINT, [32]));
    // 30 sats and a 2 sat reserve are all 32 held, and the mint takes 1 more to spend that coin.
    await expect(wallet([FEE_MINT]).quoteInvoice(INVOICE)).rejects.toThrow("Not enough sats in your wallet: 29 sats leave room for the fee");
  });

  it("still quotes when the coins cover the payment, its reserve and their own fee, and says that fee", async () => {
    seed("proofs", coins(FEE_MINT, [32, 4]));
    // A swap of both coins (2 sats) makes 32 and 2 for the melt, which takes those two in for 2 more: 36 out, 6 in fees.
    await expect(wallet([FEE_MINT]).quoteInvoice(INVOICE)).resolves.toMatchObject({ quote: "m1", mint: FEE_MINT, amount: 30, feeReserve: 6 });
  });

  it("says the reserve alone at a mint that charges nothing for coins", async () => {
    seed("proofs", coins(FREE_MINT, [32, 4]));
    await expect(wallet([FREE_MINT]).quoteInvoice(INVOICE)).resolves.toMatchObject({ mint: FREE_MINT, amount: 30, feeReserve: 2 });
  });

  it("pays for no more than it said: coins that now cost more to spend stop it before the mint sees them", async () => {
    seed("proofs", coins(FEE_MINT, [32, 4]));
    const cashu = wallet([FEE_MINT]);
    await expect(cashu.quoteInvoice(INVOICE)).resolves.toMatchObject({ feeReserve: 6 });
    // Other coins by the time it is paid: it takes all four, 8 sats in fees, more than the 6 said.
    resetDb();
    seed("proofs", coins(FEE_MINT, [16, 16, 4, 4]));
    await expect(cashu.payQuote("m1", FEE_MINT)).rejects.toThrow("The mint quoted another amount");
    const asked = vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(asked).not.toContain("/v1/swap");
    expect(asked).not.toContain("/v1/melt/bolt11");
    expect(await cashu.balanceAt(FEE_MINT)).toBe(40);
  });
});
