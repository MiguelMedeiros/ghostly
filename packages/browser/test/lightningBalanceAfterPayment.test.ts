import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORES, transact } from "../src/shared/idb";
import type { CashuWallet } from "../src/engine/wallet";
import { cashuMint, CASHU_MINT_SOURCE } from "../src/engine/paymentAdapters/providers/cashuMint";
import type { LightningProviderDescriptor } from "../src/engine/paymentAdapters/providers/lightning";
import { LightningService, lightningJournalWritten, type LightningEvents } from "../src/engine/paymentAdapters/providers/lightningService";
import { FakeLightningProvider, fakeInvoice, fakeLightning, type FakeBehaviour } from "../src/engine/paymentAdapters/providers/testing";
// covers: wallet.lightning.sources

/**
 * A healthy Lightning card with its own source reads its balance every 15 s. A payment through it, an invoice of ours
 * seen paid, or a payment left unknown that turns out paid changes that balance: the card reads it again then, so the
 * card, the Bitcoin total and the Send picker do not keep the balance from before it for up to 15 s.
 */

const HOUR = 3_600_000;
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

/** A connected card on a fake node with 100,000 sats, its first balance read done. `readMs`: how long a read takes. */
async function card(behaviour: FakeBehaviour = "settle") {
  const provider = new FakeLightningProvider({ behaviour, settleMs: 10 * HOUR });
  const net = { readMs: 0 };
  const counts = { reads: 0, inFlight: 0, most: 0 };
  const info = provider.info.bind(provider);
  provider.info = async () => {
    counts.reads++; counts.inFlight++; counts.most = Math.max(counts.most, counts.inFlight);
    try {
      // What the node holds when the read starts.
      const answer = await info();
      if (net.readMs) await new Promise((resolve) => setTimeout(resolve, net.readMs));
      return answer;
    } finally { counts.inFlight--; }
  };
  const events: LightningEvents = { changed: vi.fn(), received: vi.fn(), resolved: vi.fn() };
  const descriptor: LightningProviderDescriptor = { ...fakeLightning, fields: [], validate: undefined, create: async () => provider };
  const lightning = new LightningService("testnet", () => [cashuMint, descriptor], () => ({ platform: "web", cashu: { balance: async () => 0 } as unknown as CashuWallet }), events, CASHU_MINT_SOURCE);
  services.push(lightning);
  await lightning.start();
  await lightning.sources.set(fakeLightning.id, {});
  await advance(1_000);
  expect(lightning.view).toMatchObject({ status: "ready", balance: 100_000 });
  return { lightning, provider, net, counts, events };
}

describe("a healthy Lightning card after its balance changed", () => {
  it("pays 5,000 sats through it: the card shows what the node holds at once, not 15 s later", async () => {
    const at = await card();
    const quote = await at.lightning.quote(fakeInvoice(5_000, hash()));
    expect(await at.lightning.pay(quote.quote)).toBe(true);
    await settle();
    expect(at.provider.balance).toBe(100_000 - 5_000 - 50);
    expect(at.lightning.view.balance).toBe(at.provider.balance);
  });

  it("an invoice of ours seen paid: the card shows the 2,000 sats at once", async () => {
    const at = await card();
    const invoice = await at.lightning.createInvoice(2_000);
    at.provider.markPaid(invoice.paymentHash);
    expect(await at.lightning.check(invoice.invoice)).toBe(true);
    expect(at.events.received).toHaveBeenCalledTimes(1);
    await settle();
    expect(at.lightning.view.balance).toBe(102_000);
  });

  it("a payment with no answer, then looked up paid: the card shows it at once", async () => {
    const at = await card("hang");
    const quote = await at.lightning.quote(fakeInvoice(5_000, hash()));
    expect(await at.lightning.pay(quote.quote)).toBe(false);
    // The node has not settled it yet: lookups say pending, and the card's reads still see 100,000.
    const [paymentHash] = [...at.provider.payments.keys()];
    const paid = at.provider.payments.get(paymentHash)!;
    at.provider.payments.set(paymentHash, { state: "pending" });
    at.provider.balance += 5_050;
    await advance(40_000);
    expect(at.lightning.view.balance).toBe(100_000);
    // It settles: a lookup sees it paid, and the card reads its balance with no further wait.
    at.provider.payments.set(paymentHash, paid);
    at.provider.balance -= 5_050;
    await at.lightning.reconcile();
    await settle();
    expect(at.events.resolved).toHaveBeenCalledWith(expect.anything(), true);
    expect(at.lightning.view.balance).toBe(94_950);
  });

  it("paid while a read that started before is under way: one read right after it, never two at once", async () => {
    const at = await card();
    at.net.readMs = 3_000;
    // The 15 s read starts, with the balance from before the payment.
    const reads = at.counts.reads;
    while (at.counts.reads === reads) await advance(1_000);
    expect(at.counts.inFlight).toBe(1);
    at.counts.most = 0;
    const quote = await at.lightning.quote(fakeInvoice(5_000, hash()));
    expect(await at.lightning.pay(quote.quote)).toBe(true);
    await advance(7_000);
    expect(at.counts.most, "reads under way at once").toBe(1);
    expect(at.counts.reads - reads, "the timer's read and one for the payment").toBe(2);
    expect(at.lightning.view.balance).toBe(94_950);
  });
});
