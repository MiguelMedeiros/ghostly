import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Amount, PaymentRequest, createBlindSignature, createNewMintKeys, deriveKeysetId, getEncodedToken, pointFromHex, type Proof } from "@cashu/cashu-ts";
import { CashuWallet } from "../src/engine/wallet";
import { STORES, setDatabaseName, transact } from "../src/shared/idb";
// covers: wallet.cashu.receive-token

/**
 * cashu-ts warns (once a process, on stderr in the CLI) when an Amount is turned into a number implicitly, and its
 * next major throws there. Reading a token or a payment request and redeeming a token take its amounts explicitly.
 * Every implicit numeric read of an Amount is counted, not only the first one the library warns about.
 */
const MINT = "https://mint.example";
const { pubKeys: keys, privKeys } = createNewMintKeys(7, new Uint8Array(32).fill(5));
const pubKeys = Object.fromEntries(Object.entries(keys).map(([amount, key]) => [amount, Buffer.from(key).toString("hex")]));
const KEYSET = deriveKeysetId(pubKeys, { input_fee_ppk: 0, unit: "sat", versionByte: 1 });

function mintAnswering() {
  const answer = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = { method: "bolt11", unit: "sat", min_amount: 1, max_amount: 1_000_000 };
    if (url.pathname === "/v1/info") return answer({ name: "Test", version: "cdk-mintd/0.17.7", nuts: { 4: { methods: [method], disabled: false }, 5: { methods: [method], disabled: false } } });
    if (url.pathname === "/v1/keysets") return answer({ keysets: [{ id: KEYSET, unit: "sat", active: true, input_fee_ppk: 0 }] });
    if (url.pathname === "/v1/keys" || url.pathname === `/v1/keys/${KEYSET}`) return answer({ keysets: [{ id: KEYSET, unit: "sat", active: true, input_fee_ppk: 0, keys: pubKeys }] });
    if (url.pathname === "/v1/swap") {
      const { outputs } = JSON.parse(String(init?.body)) as { outputs: { id: string; amount: number; B_: string }[] };
      return answer({ signatures: outputs.map((o) => ({ id: o.id, amount: o.amount, C_: createBlindSignature(pointFromHex(o.B_), privKeys[o.amount], o.id).C_.toHex(true) })) });
    }
    return new Response("not found", { status: 404 });
  }));
}

const token = getEncodedToken({ mint: MINT, unit: "sat", proofs: [{ id: KEYSET, amount: 8, secret: "contact", C: pubKeys[1] } as unknown as Proof] });
const wallet = () => new CashuWallet(() => [MINT], { onChange: vi.fn(), onTestMintNeeded: vi.fn(async () => {}), onQuotePaid: vi.fn(), onMeltResolved: vi.fn() }, () => [MINT]);

/** The hints of every time an Amount was turned into a primitive other than for display, and what cashu-ts warned. */
function coercions() {
  const toPrimitive = Amount.prototype[Symbol.toPrimitive] as (this: Amount, hint: string) => unknown;
  const numeric: string[] = [];
  vi.spyOn(Amount.prototype, Symbol.toPrimitive as never).mockImplementation(function (this: Amount, hint: string) {
    if (hint !== "string") numeric.push(hint);
    return toPrimitive.call(this, hint);
  } as never);
  const warn = vi.spyOn(console, "warn");
  return { numeric, warned: () => warn.mock.calls.filter((args) => String(args[0]).includes("Amount")) };
}

beforeAll(() => { setDatabaseName("wallet-amount-coercion"); });
beforeEach(async () => {
  mintAnswering();
  await transact([STORES.proofs, STORES.swaps, STORES.walletTx, STORES.payments], (s) => { for (const name of Object.keys(s)) s[name].clear(); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("cashu amounts are read explicitly", () => {
  it("when a token is read", async () => {
    const seen = coercions();
    expect(await wallet().inspect(token)).toMatchObject({ kind: "token", amount: 8, unit: "sat", mint: MINT });
    expect(seen.numeric).toEqual([]);
    expect(seen.warned()).toEqual([]);
  });

  it("when a payment request is read", async () => {
    const request = new PaymentRequest(undefined, "r1", 21, "sat", [MINT], "coffee").toEncodedRequest();
    const seen = coercions();
    expect(await wallet().inspect(request)).toMatchObject({ kind: "request", amount: 21, unit: "sat", mints: [MINT] });
    expect(seen.numeric).toEqual([]);
    expect(seen.warned()).toEqual([]);
  });

  it("when a token is redeemed", async () => {
    const seen = coercions();
    expect(await wallet().receiveToken(token, "ecash-in")).toEqual({ amount: 8, mint: MINT, fee: 0 });
    expect(seen.numeric).toEqual([]);
    expect(seen.warned()).toEqual([]);
  });
});
