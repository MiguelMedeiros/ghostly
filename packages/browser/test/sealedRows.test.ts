import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropDataKey, openSecret, sealSecret, setDataKey, setSealedOnly } from "../src/engine/dataKey";
import { RowSeals, openRow, proofKey, sealRow, sealedStore } from "../src/engine/sealedRows";
import { createProfileKey, isSealedField } from "../src/shared/profileKey";
import { STORES, openDb, store, transact, wrap } from "../src/shared/idb";
import type { PendingMelt, StoredLink, StoredProof } from "../src/shared/types";

/*
 * The database layer of the encrypted profile's phase 1 fields (WISP 04, slice 3): which fields of a row are sealed,
 * where each is bound, and what the reader takes.
 */

const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
beforeEach(async () => {
  vi.spyOn(crypto.subtle, "deriveKey").mockImplementation(((algorithm: Pbkdf2Params, ...rest: [CryptoKey, AesKeyGenParams, boolean, KeyUsage[]]) =>
    derive({ ...algorithm, iterations: 1_000 }, ...rest)) as typeof crypto.subtle.deriveKey);
  dropDataKey();
  setDataKey((await createProfileKey("throwaway passphrase 1", "")).key);
  await transact([STORES.proofs, STORES.links], (s) => { for (const name of Object.keys(s)) s[name].clear(); });
});
afterEach(() => { dropDataKey(); vi.restoreAllMocks(); });

const link = { id: "l1", seedB64: "seed-1", encKeyB64: "enc-1", peerPubKeyZ32: "pub", createdAt: 1, label: "Ana" } as StoredLink;
const proof: StoredProof = { mint: "https://mint.example", id: "009a1f293253e41e", amount: 8, secret: "coin-secret-1", C: "02ab" };

describe("a row sealed and opened", () => {
  it("seals only the listed fields, each bound where it is, and opens back to the row", async () => {
    const sealed = await sealRow(STORES.links, link);
    expect(isSealedField(sealed.seedB64)).toBe(true);
    expect(sealed).toMatchObject({ id: "l1", label: "Ana", peerPubKeyZ32: "pub" });
    expect(link.seedB64, "the caller's row is not changed").toBe("seed-1");
    expect(await openRow(STORES.links, sealed)).toEqual(link);
    // Moved to another chat or another field, a sealed value fails instead of being read as that one.
    await expect(openRow(STORES.links, { ...sealed, id: "l2" })).rejects.toThrow("could not be opened");
    await expect(openRow(STORES.links, { ...sealed, encKeyB64: sealed.seedB64 })).rejects.toThrow("could not be opened");
  });

  it("a melt's proof secrets and blank outputs are sealed as one field each", async () => {
    const melt = { quote: "q1", mint: "m", request: "lnbc1", amount: 1, secrets: ["s1", "s2"], outlay: 2, outputs: [{ secret: "o1" }], createdAt: 1 } satisfies PendingMelt;
    const sealed = await sealRow(STORES.melts, melt);
    expect(JSON.stringify(sealed)).not.toMatch(/s1|o1/);
    expect(sealed.request, "the invoice is not a secret").toBe("lnbc1");
    expect(await openRow(STORES.melts, sealed)).toEqual(melt);
  });

  it("a proof is kept under a hash of its secret, the secret sealed beside it, and is found by its secret", async () => {
    const sealed = await sealRow(STORES.proofs, proof);
    expect(sealed.secret).toBe(proofKey(proof.secret));
    expect(JSON.stringify(sealed)).not.toContain(proof.secret);
    expect(await openRow(STORES.proofs, sealed)).toEqual(proof);
    // The sealed secret of one proof put under another's key does not open as that one.
    const other = await sealRow(STORES.proofs, { ...proof, secret: "coin-secret-2" });
    await expect(openRow(STORES.proofs, { ...other, sealedSecret: (sealed as unknown as { sealedSecret: unknown }).sealedSecret })).rejects.toThrow("could not be opened");

    const seals = await new RowSeals().prepare(STORES.proofs, [proof]);
    await transact([STORES.proofs], (s) => { sealedStore(s[STORES.proofs], seals).put({ ...proof, reserved: true }); });
    const tx = (await openDb()).transaction(STORES.proofs, "readwrite");
    const found = await wrap<StoredProof>(sealedStore(tx.objectStore(STORES.proofs), new RowSeals()).get(proof.secret));
    expect(await openRow(STORES.proofs, found)).toEqual({ ...proof, reserved: true });
  });
});

describe("writing inside a transaction", () => {
  it("a value not sealed ahead aborts the transaction: nothing goes out in the clear", async () => {
    const seals = await new RowSeals().prepare(STORES.proofs, [proof]);
    await expect(transact([STORES.proofs], (s) => { sealedStore(s[STORES.proofs], seals).put({ ...proof, secret: "coin-secret-not-prepared" }); })).rejects.toThrow("not sealed before it was saved");
    expect(await wrap((await store(STORES.proofs, "readonly")).count())).toBe(0);
  });

  it("seals made with the key are used even if it is dropped meanwhile, and none are made without it", async () => {
    const seals = await new RowSeals().prepare(STORES.links, [link]);
    dropDataKey();
    expect(isSealedField(seals.row(STORES.links, link).seedB64)).toBe(true);
    const plain = new RowSeals();
    expect(plain.on).toBe(false);
    expect(plain.row(STORES.links, link)).toBe(link);
  });
});

describe("what the reader takes", () => {
  const at = { store: STORES.settings, key: "k1", field: "seed" };

  it("until the migration ends, plain and version 1 values in a sealed place are read", async () => {
    expect(await openRow(STORES.links, link)).toEqual(link);
    dropDataKey();
    const v1 = await sealSecret("seed-1", at);
    setDataKey((await createProfileKey("throwaway passphrase 1", "")).key);
    expect(await openSecret(v1, at)).toBe("seed-1");
  });

  it("once it has, they are refused: a value put there by someone who can write the profile but not read it", async () => {
    dropDataKey();
    const v1 = await sealSecret("seed-1", at);
    setDataKey((await createProfileKey("throwaway passphrase 1", "")).key);
    setSealedOnly(true);
    await expect(openSecret(v1, at)).rejects.toThrow("not sealed with its key");
    await expect(openRow(STORES.links, link)).rejects.toThrow("not sealed with its key");
    await expect(openRow(STORES.proofs, proof)).rejects.toThrow("not sealed with its key");
    expect(await openRow(STORES.links, await sealRow(STORES.links, link))).toEqual(link);
  });
});
