import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlindSignature, createNewMintKeys, deriveKeysetId, getEncodedToken, pointFromHex, type Proof } from "@cashu/cashu-ts";
import { dropDataKey, setDataKey } from "../src/engine/dataKey";
import { sealRow } from "../src/engine/sealedRows";
import { CashuWallet } from "../src/engine/wallet";
import { createProfileKey } from "../src/shared/profileKey";
import { STORES, setDatabaseName, transact } from "../src/shared/idb";
import type { StoredProof } from "../src/shared/types";
// covers: wallet.cashu.receive-token

/**
 * A contact's ecash taken in costs the size of its swap, not of the wallet: a redeem reads none of the proofs already
 * stored (with the data key, opens none of them), however many there are. The real cashu-ts wallet on real IndexedDB
 * semantics, in front of a mint that signs with real keys.
 */
const MINT = "https://mint.example";
const { pubKeys: keys, privKeys } = createNewMintKeys(7, new Uint8Array(32).fill(5));
const pubKeys = Object.fromEntries(Object.entries(keys).map(([amount, key]) => [amount, Buffer.from(key).toString("hex")]));
const KEYSET = deriveKeysetId(pubKeys, { input_fee_ppk: 0, unit: "sat", versionByte: 1 });
const STORED = 2_000;
const TOKENS = 10;

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

const coin = (amount: number, secret: string): StoredProof => ({ mint: MINT, id: KEYSET, amount, secret, C: pubKeys[1] });
const token = (i: number) => getEncodedToken({ mint: MINT, unit: "sat", proofs: [{ id: KEYSET, amount: 8, secret: `contact-${i}`, C: pubKeys[1] } as unknown as Proof] });

/** PBKDF2 at 600,000 rounds costs about a second per call; the derivation runs with fewer rounds here. */
const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
const dataKey = async () => {
  vi.spyOn(crypto.subtle, "deriveKey").mockImplementationOnce(((algorithm: Pbkdf2Params, ...rest: [CryptoKey, AesKeyGenParams, boolean, KeyUsage[]]) =>
    derive({ ...algorithm, iterations: 1_000 }, ...rest)) as typeof crypto.subtle.deriveKey);
  return (await createProfileKey("throwaway passphrase 1", "")).key;
};

/** How many proof rows a call reads, whole-store reads and reads by key alike. */
async function proofReads<T>(work: () => Promise<T>): Promise<{ result: T; read: number }> {
  let read = 0;
  const { getAll, get } = IDBObjectStore.prototype;
  const all = vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["getAll"]>) {
    const request = getAll.apply(this, args);
    if (this.name === STORES.proofs) request.addEventListener("success", () => { read += (request.result as unknown[]).length; });
    return request;
  });
  const one = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["get"]>) {
    const request = get.apply(this, args);
    if (this.name === STORES.proofs) request.addEventListener("success", () => { if (request.result) read++; });
    return request;
  });
  try { return { result: await work(), read }; } finally { all.mockRestore(); one.mockRestore(); }
}

beforeAll(() => { setDatabaseName("wallet-receive-reads"); });
beforeEach(async () => {
  dropDataKey();
  mintAnswering();
  await transact([STORES.proofs, STORES.swaps, STORES.walletTx, STORES.payments], (s) => { for (const name of Object.keys(s)) s[name].clear(); });
});
afterEach(() => { dropDataKey(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe.each([
  ["without the data key", false],
  ["with the data key", true],
])("a contact's ecash redeemed %s", (_, sealed) => {
  it(`reads none of the ${STORED} proofs already stored`, async () => {
    if (sealed) setDataKey(await dataKey());
    const held = await Promise.all(Array.from({ length: STORED }, (_, i) => sealRow(STORES.proofs, coin(1, `held-${i}`))));
    await transact([STORES.proofs], (s) => { for (const row of held) s[STORES.proofs].put(row); });
    const wallet = new CashuWallet(() => [MINT], { onChange: vi.fn(), onTestMintNeeded: vi.fn(async () => {}), onQuotePaid: vi.fn(), onMeltResolved: vi.fn() }, () => [MINT]);

    for (let i = 0; i < TOKENS; i++) {
      const { result, read } = await proofReads(() => wallet.receiveToken(token(i), "ecash-in"));
      expect(result).toEqual({ amount: 8, mint: MINT, fee: 0 });
      expect(read, `token ${i}: what a redeem reads of the proofs held`).toBe(0);
    }
    expect(await wallet.balanceAt(MINT), "every token was stored, beside what was held").toBe(STORED + TOKENS * 8);
    const swaps = vi.mocked(fetch).mock.calls.filter(([input]) => new URL(String(input)).pathname === "/v1/swap");
    expect(swaps, "one swap per token").toHaveLength(TOKENS);
  });
});
