import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORES, transact } from "../src/shared/idb";
import type { CashuWallet } from "../src/engine/wallet";
import { cashuMint, CASHU_MINT_SOURCE } from "../src/engine/paymentAdapters/providers/cashuMint";
import type { LightningProviderDescriptor } from "../src/engine/paymentAdapters/providers/lightning";
import { LightningService, lightningJournalWritten, type LightningEvents } from "../src/engine/paymentAdapters/providers/lightningService";
import { FakeLightningProvider, fakeInvoice, fakeLightning } from "../src/engine/paymentAdapters/providers/testing";
// covers: wallet.lightning.card

/**
 * A payment through a Lightning card shows in the card's recent list once it ends, paid or refused. The list was only
 * read again by a later pass (a balance read that changed something): a refused one, with no balance change to bring
 * that pass (the card's first payment, or one right after a paid one whose balance was already read), never showed
 * its "failed" line.
 */

/** IndexedDB (fake-indexeddb) answers on real macrotasks: lets them run, with no fake time passing. */
async function settle() { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); }
async function advance(ms: number, step = 1000) {
  for (let left = ms; left > 0; left -= step) { await vi.advanceTimersByTimeAsync(Math.min(step, left)); await settle(); }
}
const services: LightningService[] = [];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  await transact([STORES.settings], (s) => { s[STORES.settings].clear(); });
  lightningJournalWritten();
});
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  vi.useRealTimers();
});

const hash = () => crypto.getRandomValues(new Uint8Array(32));

async function card() {
  const provider = new FakeLightningProvider({ behaviour: "settle" });
  const events: LightningEvents = { changed: vi.fn(), received: vi.fn(), resolved: vi.fn() };
  const descriptor: LightningProviderDescriptor = { ...fakeLightning, fields: [], validate: undefined, create: async () => provider };
  const lightning = new LightningService("testnet", () => [cashuMint, descriptor], () => ({ platform: "web", cashu: { balance: async () => 0 } as unknown as CashuWallet }), events, CASHU_MINT_SOURCE);
  services.push(lightning);
  await lightning.start();
  await lightning.sources.set(fakeLightning.id, {});
  await advance(1_000);
  expect(lightning.view).toMatchObject({ status: "ready", balance: 100_000 });
  return { lightning, provider, events };
}

describe("a Lightning card's recent list after a payment", () => {
  it("a paid payment is listed paid as soon as it ends", async () => {
    const at = await card();
    const quote = await at.lightning.quote(fakeInvoice(5_000, hash()));
    vi.mocked(at.events.changed).mockClear();
    expect(await at.lightning.pay(quote.quote)).toBe(true);
    expect(at.lightning.view.recent[0]).toMatchObject({ direction: "out", amount: 5_000, state: "paid" });
    expect(at.events.changed).toHaveBeenCalled();
  });

  it("the card's first payment refused: it is listed failed, with nothing else to bring the list", async () => {
    const at = await card();
    at.provider.behaviour = "refuse";
    const refused = await at.lightning.quote(fakeInvoice(1_000, hash()));
    await expect(at.lightning.pay(refused.quote)).rejects.toThrow("No route (fake)");
    await advance(20_000);
    expect(at.lightning.view.recent.map((op) => [op.amount, op.state])).toEqual([[1_000, "failed"]]);
  });

  it("refused right after a paid one: the refused one is listed first, failed, and the wallet view is told", async () => {
    const at = await card();
    const paid = await at.lightning.quote(fakeInvoice(5_000, hash()));
    expect(await at.lightning.pay(paid.quote)).toBe(true);
    // The balance read after it is done, and shows the paid one.
    await advance(2_000);
    expect(at.lightning.view.balance).toBe(at.provider.balance);
    expect(at.lightning.view.recent[0]).toMatchObject({ amount: 5_000, state: "paid" });
    at.provider.behaviour = "refuse";
    const refused = await at.lightning.quote(fakeInvoice(1_000, hash()));
    vi.mocked(at.events.changed).mockClear();
    await expect(at.lightning.pay(refused.quote)).rejects.toThrow("No route (fake)");
    expect(at.lightning.view.recent[0]).toMatchObject({ amount: 1_000, state: "failed", error: "No route (fake)" });
    expect(at.events.changed).toHaveBeenCalled();
    // Nothing left the wallet: the balance reads after it say the same, and the list stays as it is.
    await advance(20_000);
    expect(at.lightning.view.recent.map((op) => [op.amount, op.state])).toEqual([[1_000, "failed"], [5_000, "paid"]]);
  });
});
