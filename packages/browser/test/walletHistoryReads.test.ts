import "fake-indexeddb/auto";
import { beforeAll, expect, it, vi } from "vitest";
import { CashuWallet } from "../src/engine/wallet";
import { STORES, WALLET_TX_INDEX, openDb, setDatabaseName } from "../src/shared/idb";
import { TEST_MINT } from "../src/shared/mints";
import type { WalletTx } from "../src/shared/types";
// covers: wallet.history

/**
 * A wallet refresh reads each network's newest 100 movements and nothing more, however long the history is: a contact
 * can add a movement to the Testnet wallet with every 1-test-sat payment, for free. On real IndexedDB semantics.
 */
const MINT = "https://mint.example";
const tx = (id: string, mint: string, timestamp: number, fee: number): WalletTx => ({ id, mint, timestamp, kind: "ecash-in", amount: 1, fee });

beforeAll(async () => {
  // Written by a build from before the history's index (14): the upgrade indexes what is already there.
  setDatabaseName("wallet-history-reads");
  const fourteen = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("wallet-history-reads", 14);
    request.onupgradeneeded = () => {
      const s = request.result.createObjectStore(STORES.walletTx, { keyPath: "id" });
      for (let i = 0; i < 3; i++) s.put(tx(`real-${i}`, MINT, 1 + i, 7));
      // Newer than every Mainnet movement: a contact's flood of test payments.
      for (let i = 0; i < 5_000; i++) s.put(tx(`test-${i}`, TEST_MINT, 1_000 + i, 0));
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  fourteen.close();
  expect((await openDb()).transaction(STORES.walletTx).objectStore(STORES.walletTx).indexNames.contains(WALLET_TX_INDEX)).toBe(true);
});

/** How many walletTx records a call reads: whole-store reads count every record, a cursor one per step. */
async function reads<T>(work: () => Promise<T>): Promise<{ result: T; read: number }> {
  let read = 0;
  const onWalletTx = (source: IDBObjectStore | IDBIndex) => ("objectStore" in source ? source.objectStore : source).name === STORES.walletTx;
  for (const proto of [IDBObjectStore.prototype, IDBIndex.prototype]) {
    const getAll = proto.getAll;
    vi.spyOn(proto, "getAll").mockImplementation(function (this: IDBObjectStore & IDBIndex, ...args: Parameters<IDBObjectStore["getAll"]>) {
      const request = getAll.apply(this, args);
      if (onWalletTx(this)) request.addEventListener("success", () => { read += (request.result as unknown[]).length; });
      return request;
    });
    const openCursor = proto.openCursor;
    vi.spyOn(proto, "openCursor").mockImplementation(function (this: IDBObjectStore & IDBIndex, ...args: Parameters<IDBObjectStore["openCursor"]>) {
      const request = openCursor.apply(this, args);
      if (onWalletTx(this)) request.addEventListener("success", () => { if (request.result) read++; });
      return request;
    });
  }
  try { return { result: await work(), read }; } finally { vi.restoreAllMocks(); }
}

it("reads a network's newest 100 movements, not the whole history, and shows each network its own", async () => {
  const wallet = new CashuWallet((network) => (network === "testnet" ? [TEST_MINT] : [MINT]), { onChange: () => {}, onTestMintNeeded: async () => {}, onQuotePaid: () => {}, onMeltResolved: () => {} }, () => [MINT, TEST_MINT]);

  const mainnet = await reads(() => wallet.view("mainnet"));
  expect(mainnet.read, "Mainnet reads its 3 movements and steps over the Testnet ones at once").toBeLessThan(10);
  expect(mainnet.read).toBeGreaterThanOrEqual(3);
  expect(mainnet.result.history.map((t) => t.id)).toEqual(["real-2", "real-1", "real-0"]);
  expect(mainnet.result.feesPaid).toBe(21);

  const testnet = await reads(() => wallet.view("testnet"));
  expect(testnet.read, "Testnet reads its newest 100 of 5,000").toBeLessThan(110);
  expect(testnet.read).toBeGreaterThanOrEqual(100);
  expect(testnet.result.history).toHaveLength(100);
  expect(testnet.result.history[0].id).toBe("test-4999");
  expect(testnet.result.history[99].id).toBe("test-4900");
});
