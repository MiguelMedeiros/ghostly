import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { DefaultVtxo, IndexedDBContractRepository, IndexedDBWalletRepository, type ExtendedVirtualCoin } from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { ARK_DB_VERSIONS, restoreArkDatabase, snapshotArkDatabase, type ArkDatabaseSnapshot } from "../src/engine/paymentAdapters/backup";
import { wrap } from "../src/shared/idb";
// covers: backup.database-snapshot, wallet.ark.backup

// The real SDK makes the wallet database here, so an SDK update that changes its schema fails this file
// rather than a restore in someone's hands.
const key = (n: number) => schnorr.getPublicKey(new Uint8Array(32).fill(n));
const vtxoScript = new DefaultVtxo.Script({ pubKey: key(1), serverPubKey: key(2), csvTimelock: { value: 144n, type: "blocks" } });
const address = vtxoScript.address("tark", key(2)).encode();
const script = hex.encode(vtxoScript.pkScript);
const coin = (txid: string, spent: boolean): ExtendedVirtualCoin => ({
  txid, vout: 0, value: 5000, status: { confirmed: false }, createdAt: new Date(1_700_000_000_000), script,
  isUnrolled: false, isSpent: spent, spentBy: spent ? "cd".repeat(32) : undefined, virtualStatus: { state: "preconfirmed" },
  tapTree: vtxoScript.encode(), forfeitTapLeafScript: vtxoScript.forfeit(), intentTapLeafScript: vtxoScript.forfeit(),
});
const UNSPENT = "aa".repeat(32), SPENT = "bb".repeat(32);

async function makeWallet(walletId: string) {
  const wallet = new IndexedDBWalletRepository(`ghostly-ark-${walletId}`), contracts = new IndexedDBContractRepository(`ghostly-ark-${walletId}`);
  await wallet.saveVtxos(address, [coin(UNSPENT, false), coin(SPENT, true)]);
  await contracts.getContracts();
  await wallet[Symbol.asyncDispose]();await contracts[Symbol.asyncDispose]();
}
async function openWallet(walletId: string) {
  const wallet = new IndexedDBWalletRepository(`ghostly-ark-${walletId}`);
  try { return { all: await wallet.getVtxos(address), unspent: await wallet.getVtxosForScripts!([script], { unspentOnly: true }) }; } finally { await wallet[Symbol.asyncDispose](); }
}
async function vtxoStore(walletId: string) {
  const db = await wrap(indexedDB.open(`ghostly-ark-${walletId}`));
  try { const s = db.transaction("vtxos").objectStore("vtxos"); return { version: db.version, indexes: Array.from(s.indexNames), rows: await wrap(s.getAll()) as Record<string, unknown>[] }; } finally { db.close(); }
}
/** What Ghostly 1.1.3 (SDK 0.4.76, database version 3) wrote: no scriptUnspent index, no `unspent` field. */
function asVersion3(snapshot: ArkDatabaseSnapshot): ArkDatabaseSnapshot {
  return { version: 3, stores: snapshot.stores.map(s => s.name !== "vtxos" ? s : {
    ...s, indexes: s.indexes.filter(i => i.name !== "scriptUnspent"),
    values: s.values.map(v => { const { unspent: _drop, ...rest } = v as Record<string, unknown>; return rest; }),
  }) };
}

it("backs up the database the installed SDK makes, and restores it as a working wallet", async () => {
  await makeWallet("sdk-src");
  const snapshot = await snapshotArkDatabase("sdk-src");
  expect(snapshot.version, "the SDK's database version is one a backup can carry; update ARK_DB_VERSIONS with it").toBe(Math.max(...ARK_DB_VERSIONS));
  await restoreArkDatabase("sdk-copy", snapshot);
  const { all, unspent } = await openWallet("sdk-copy");
  expect(all.map(v => v.txid).sort()).toEqual([UNSPENT, SPENT]);
  expect(unspent.map(v => v.txid)).toEqual([UNSPENT]);
});

it("a backup made with the older database (1.1.3) restores, and the SDK upgrades it on first open", async () => {
  await makeWallet("old-src");
  const old = asVersion3(await snapshotArkDatabase("old-src"));
  await restoreArkDatabase("old-copy", old);
  const before = await vtxoStore("old-copy");
  expect(before.version).toBe(3);
  expect(before.indexes).not.toContain("scriptUnspent");
  const { all, unspent } = await openWallet("old-copy");
  expect(all.map(v => v.txid).sort()).toEqual([UNSPENT, SPENT]);
  expect(unspent.map(v => v.txid)).toEqual([UNSPENT]);
  const after = await vtxoStore("old-copy");
  expect(after.version).toBe(Math.max(...ARK_DB_VERSIONS));
  expect(after.indexes).toContain("scriptUnspent");
  expect(Object.fromEntries(after.rows.map(r => [r.txid, r.unspent]))).toEqual({ [UNSPENT]: 1, [SPENT]: undefined });
});

it("refuses a database version it does not know, older or newer", async () => {
  await makeWallet("versions");
  const snapshot = await snapshotArkDatabase("versions");
  for (const version of [2, Math.max(...ARK_DB_VERSIONS) + 1, 3.5])
    await expect(restoreArkDatabase(`versions-${version}`, { ...snapshot, version })).rejects.toThrow("Unsupported Ark backup schema");
});
