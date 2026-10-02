import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { STORES, openDb, transact, wrap } from "../src/shared/idb";
import { markRestoredWallet, restoredWalletRow } from "../src/shared/restoredRows";
// covers: backup.profile.file, headless.backup

const proof = (secret: string, extra: Record<string, unknown> = {}) => ({ mint: "https://mint.example", id: "009a1f293253e41e", amount: 64, secret, C: "02ab", ...extra });
const intent = (id: string, state: string) => ({ review: { id, state, amount: 21 }, prepared: { mint: "https://mint.example" } });
const all = async (store: string) => wrap((await openDb()).transaction(store, "readonly").objectStore(store).getAll());

it("a row of a restored wallet: free ecash is to be checked, a swap is a copy's, an unfinished attempt is unknown", () => {
  expect(restoredWalletRow(STORES.proofs, proof("free"))).toEqual(proof("free", { unchecked: true }));
  expect(restoredWalletRow(STORES.proofs, proof("held", { reserved: true })), "ecash a payment holds is left to that payment").toEqual(proof("held", { reserved: true }));
  expect(restoredWalletRow(STORES.swaps, { id: "swap-1", kind: "send" })).toEqual({ id: "swap-1", kind: "send", restored: true });
  for (const state of ["pending", "submitted", "unknown"]) expect((restoredWalletRow(STORES.intents, intent("a", state)) as ReturnType<typeof intent>).review.state).toBe("unknown");
  for (const state of ["settled", "failed"]) expect(restoredWalletRow(STORES.intents, intent("a", state))).toEqual(intent("a", state));
  // Anything else is kept as it is.
  expect(restoredWalletRow(STORES.payments, { id: "p", state: "pending" })).toEqual({ id: "p", state: "pending" });
  expect(restoredWalletRow(STORES.proofs, null)).toBe(null);
});

it("a database that came back whole is marked in place, once or twice the same", async () => {
  await openDb();
  await transact([STORES.proofs, STORES.swaps, STORES.intents, STORES.payments], (s) => {
    s[STORES.proofs].put(proof("free"));
    s[STORES.proofs].put(proof("held", { reserved: true }));
    s[STORES.swaps].put({ id: "swap-1", mint: "https://mint.example", kind: "send", swap: { inputs: [] }, createdAt: 1 });
    s[STORES.intents].put(intent("open", "submitted"));
    s[STORES.intents].put(intent("done", "settled"));
    s[STORES.payments].put({ id: "p", state: "pending" });
  });
  for (let round = 0; round < 2; round++) {
    await markRestoredWallet();
    expect(await all(STORES.proofs)).toEqual(expect.arrayContaining([proof("free", { unchecked: true }), proof("held", { reserved: true })]));
    expect(await all(STORES.swaps)).toEqual([{ id: "swap-1", mint: "https://mint.example", kind: "send", swap: { inputs: [] }, createdAt: 1, restored: true }]);
    expect((await all(STORES.intents) as ReturnType<typeof intent>[]).map((i) => [i.review.id, i.review.state]).sort()).toEqual([["done", "settled"], ["open", "unknown"]]);
    expect(await all(STORES.payments)).toEqual([{ id: "p", state: "pending" }]);
  }
});
