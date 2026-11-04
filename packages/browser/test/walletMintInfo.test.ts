import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bech32 } from "@scure/base";
import { deriveKeysetId } from "@cashu/cashu-ts";
import { CashuWallet } from "../src/engine/wallet";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { resetDb, seed } from "./fakes";
// covers: wallet.cashu.pay-invoice

vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);

const MINT = "https://mint.example";
const named = fakeInvoice(10, new Uint8Array(32).fill(7));
/** The fake regtest invoice with no amount in its prefix: the payer chooses. */
const ANY = bech32.encode("lnbcrt", bech32.decode(named as `${string}1${string}`, false).words, false);

const KEYS = { 1: `02${"ab".repeat(32)}`, 2: `03${"cd".repeat(32)}` };
const KEYSET = deriveKeysetId(KEYS);

/** A real cashu-ts wallet in front of a mint that answers with these melt methods, as its /v1/info would write them. */
function mintAnswering(meltMethods: object[]) {
  const quotes: { options?: { amountless?: { amount_msat: number } } }[] = [];
  const answer = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/info") return answer({ name: "Test", version: "cdk-mintd/0.17.7", nuts: { 4: { methods: [], disabled: false }, 5: { methods: meltMethods, disabled: false } } });
    if (path === "/v1/keysets") return answer({ keysets: [{ id: KEYSET, unit: "sat", active: true, input_fee_ppk: 0 }] });
    if (path === "/v1/keys" || path === `/v1/keys/${KEYSET}`) return answer({ keysets: [{ id: KEYSET, unit: "sat", keys: KEYS }] });
    if (path === "/v1/melt/quote/bolt11") {
      quotes.push(JSON.parse(String(init?.body)));
      return answer({ quote: "m1", amount: 90, unit: "sat", request: ANY, fee_reserve: 2, state: "UNPAID", expiry: 4_000_000_000 });
    }
    return new Response("not found", { status: 404 });
  }));
  return quotes;
}

const wallet = () => new CashuWallet(() => [MINT], { onChange: vi.fn(), onTestMintNeeded: vi.fn(async () => {}), onQuotePaid: vi.fn(), onMeltResolved: vi.fn() }, () => [MINT]);

beforeEach(() => {
  resetDb();
  seed("proofs", [{ mint: MINT, id: KEYSET, amount: 128, secret: "a", C: KEYS[1] }]);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("a mint's own words for an invoice with no amount", () => {
  const method = { method: "bolt11", unit: "sat", min_amount: 1, max_amount: 1_000_000 };

  it("takes one when the mint says so under options, as NUT-05 writes it", async () => {
    const quotes = mintAnswering([{ ...method, options: { amountless: true } }]);
    await expect(wallet().quoteInvoice(ANY, undefined, 90)).resolves.toMatchObject({ quote: "m1", mint: MINT, amount: 90, feeReserve: 2 });
    expect(quotes[0].options?.amountless?.amount_msat).toBe(90_000);
  });

  it("takes one when the mint says so beside the method, as cdk-mintd 0.17 writes it, and sends the amount", async () => {
    const quotes = mintAnswering([{ ...method, amountless: true }]);
    await expect(wallet().quoteInvoice(ANY, undefined, 90)).resolves.toMatchObject({ quote: "m1", mint: MINT, amount: 90, feeReserve: 2 });
    expect(quotes[0].options?.amountless?.amount_msat).toBe(90_000);
  });

  it("is refused by a mint that says nothing, or says no, and the mint is never asked", async () => {
    for (const methods of [[method], [{ ...method, amountless: false }], [{ ...method, options: { amountless: false } }], [{ method: "bolt12", unit: "sat", amountless: true }]]) {
      const quotes = mintAnswering(methods);
      await expect(wallet().quoteInvoice(ANY, undefined, 90)).rejects.toThrow("None of your mints can pay an invoice with no amount");
      expect(quotes).toEqual([]);
    }
  });
});
