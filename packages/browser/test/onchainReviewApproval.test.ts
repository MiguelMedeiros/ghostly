import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { ONCHAIN_PROVIDER, type PaymentTarget } from "@ghostly/core";
import { FakeEsplora } from "./helpers/fakeEsplora";
import { nodeBdk } from "./helpers/bdkNode";
import { fakeAddress } from "../src/engine/paymentAdapters/providers/testing";
// covers: backup.profile.file, wallet.onchain.bdk.send

vi.setConfig({ testTimeout: 60_000 });

class FakeStorage {
  entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  getItem(k: string) { return this.entries.get(k) ?? null; }
  setItem(k: string, v: string) { this.entries.set(k, v); }
  removeItem(k: string) { this.entries.delete(k); }
}
afterEach(() => { vi.unstubAllGlobals(); });

const ESPLORA = "http://127.0.0.1:44299";
const PASSPHRASE = "a long backup passphrase";

/** One engine's on-chain payments (the real BitcoinService adapter and coordinator, a BDK source) on database `db`. */
async function engineOn(db: string, esplora: FakeEsplora) {
  vi.resetModules();
  const idb = await import("../src/shared/idb");
  idb.setDatabaseName(db);
  const { BitcoinService } = await import("../src/engine/paymentAdapters/providers/bitcoinService");
  const { BdkOnchain, bdk } = await import("../src/engine/paymentAdapters/providers/bdk");
  const { PaymentCoordinator } = await import("../src/engine/paymentAdapters/coordinator");
  const { intentRepository } = await import("../src/engine/paymentAdapters/persistence");
  const descriptor = { ...bdk, create: (s: never, h: never) => BdkOnchain.open(s, h, { bdk: nodeBdk, fetch: esplora.fetch }) };
  const service = new BitcoinService("testnet", () => [descriptor], () => ({ platform: "web" }), () => {});
  const coordinator = new PaymentCoordinator(intentRepository, [service.adapter]);
  await service.sources.start();
  await service.sources.ensureReady(true);
  /** What the engine's status poll does for on-chain payments: every submitted or unknown one is reconciled. */
  const poll = async () => {
    for (const { review } of await intentRepository.list()) {
      if (!["submitted", "unknown"].includes(review.state) || (review.method === "bitcoin" && !service.sources.active)) continue;
      await coordinator.reconcile(review.id).catch(() => {});
    }
  };
  return { service, coordinator, intentRepository, poll };
}

it("a payment review that was never approved is never sent by a restored profile; an approved one still is", async () => {
  Object.defineProperty(globalThis, "localStorage", { value: new FakeStorage(), configurable: true });
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: vi.fn(), location: { hash: "", reload: vi.fn() }, crypto: globalThis.crypto }, configurable: true });
  const esplora = new FakeEsplora();
  vi.stubGlobal("fetch", esplora.fetch);

  const a = await engineOn("ghostly", esplora);
  const { newBdkPhrase } = await import("../src/engine/paymentAdapters/providers/bdkPhrase");
  await a.service.sources.set("bdk", { network: "regtest", esplora: ESPLORA, script: "bip84", mnemonic: newBdkPhrase() });
  const provider = a.service.sources.active!;
  const sync = (provider as unknown as { sync(full: boolean): Promise<void> }).sync.bind(provider);
  await sync(true);
  for (let i = 0; i < 4; i++) esplora.fund(await provider.receiveAddress(), 50_000);
  await sync(true); await sync(true);
  const target = (): PaymentTarget => ({ method: "bitcoin", network: "regtest", provider: ONCHAIN_PROVIDER, asset: "BTC", unit: "sat", address: fakeAddress(), expiresAt: Date.now() + 15 * 60_000 } as PaymentTarget);
  const txidOf = async (id: string) => ((await a.intentRepository.get(id))!.prepared as { txid: string }).txid;

  // Four reviews: one left pending, one cancelled before the backup, one cancelled after it, one approved.
  const pending = await a.coordinator.prepare(target(), 20_000, 5_000, { payee: "someone" });
  const cancelledBefore = await a.coordinator.prepare(target(), 20_000, 5_000, { payee: "someone" });
  await a.coordinator.cancel(cancelledBefore.id);
  const cancelledAfter = await a.coordinator.prepare(target(), 20_000, 5_000, { payee: "someone" });
  const approved = await a.coordinator.prepare(target(), 20_000, 5_000, { payee: "someone" });
  expect(await a.coordinator.approve(approved.id)).toMatchObject({ state: "submitted" });
  expect(esplora.broadcasts).toBe(1);
  await a.poll();
  expect(esplora.broadcasts, "a pending review is never sent").toBe(1);

  const { createProfileBackup, restoreProfileBackup } = await import("../../../apps/ui/src/lib/profileBackup");
  const bundle = await createProfileBackup(PASSPHRASE);
  await a.coordinator.cancel(cancelledAfter.id);
  await a.service.sources.stop();
  // The approved payment then leaves the mempool without confirming.
  const approvedTxid = await txidOf(approved.id);
  esplora.txs.delete(approvedTxid);
  for (const [outpoint, by] of [...esplora.spends]) if (by === approvedTxid) esplora.spends.delete(outpoint);
  const unsent = await Promise.all([pending.id, cancelledBefore.id, cancelledAfter.id].map(txidOf));

  const restored = await restoreProfileBackup(bundle, PASSPHRASE);
  const b = await engineOn(`ghostly_${restored.id}`, esplora);
  expect(b.service.sources.active).toBeTruthy();
  const stateOf = async (id: string) => (await b.intentRepository.get(id))!.review.state;
  expect(await stateOf(pending.id), "a review never approved comes back cancelled").toBe("cancelled");
  expect(await stateOf(cancelledAfter.id)).toBe("cancelled");
  expect(await stateOf(cancelledBefore.id)).toBe("cancelled");
  expect(await stateOf(approved.id)).toBe("unknown");

  // A review never approved and saved as of unknown outcome (as an older copy of the store could hold it) is not sent either.
  const older = (await b.intentRepository.get(cancelledAfter.id))!;
  await b.intentRepository.put({ ...older, review: { ...older.review, state: "unknown" } });

  await b.poll(); await b.poll();
  expect(esplora.broadcasts, "only the approved payment goes out again").toBe(2);
  expect(esplora.txs.has(approvedTxid)).toBe(true);
  for (const txid of unsent) expect(esplora.txs.has(txid)).toBe(false);
  expect(await stateOf(approved.id)).toBe("submitted");
  expect(await b.intentRepository.get(cancelledAfter.id)).toMatchObject({ review: { state: "failed", error: expect.stringContaining("never approved") } });
  expect(await stateOf(pending.id)).toBe("cancelled");
  await b.service.sources.stop();
});
