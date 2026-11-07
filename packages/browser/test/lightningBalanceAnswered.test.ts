import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORES, transact } from "../src/shared/idb";
import type { CashuWallet } from "../src/engine/wallet";
import { cashuMint, CASHU_MINT_SOURCE } from "../src/engine/paymentAdapters/providers/cashuMint";
import type { LightningProviderDescriptor } from "../src/engine/paymentAdapters/providers/lightning";
import { LightningService, lightningJournalWritten, type LightningEvents } from "../src/engine/paymentAdapters/providers/lightningService";
import { FakeLightningProvider, fakeInvoice, fakeLightning } from "../src/engine/paymentAdapters/providers/testing";
// covers: wallet.lightning.sources

/**
 * A Lightning card whose source stopped answering has its balance read less and less often, up to every 30 min. When
 * the source is back, a payment through the card (or an invoice of ours seen paid) goes through: that answer says the
 * source is back, so the balance is read again then, not when the 30 min wait ends (the card kept the balance from
 * before the payment and "Could not read the balance" meanwhile). A source still down keeps its slow pace, and one
 * that answers everything but its balance gets one more read for it, not one per answer.
 */

const HOUR = 3_600_000;
/**
 * Fake time, a second at a time. IndexedDB (fake-indexeddb) answers on real macrotasks, which fake timers do not run:
 * each step lets them, so a read ends at the fake second it started in.
 */
async function advance(ms: number, step = 1000) {
  for (let left = ms; left > 0; left -= step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, left));
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  }
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
const fail = () => { throw new TypeError("Failed to fetch"); };

/**
 * A fake Lightning card whose source can stop answering (`net.down`: every call fails as an unreachable node does;
 * `net.balanceDown`: only the balance read does). `reads`: balance reads asked; `inFlight`/`most`: reads under way.
 */
async function card() {
  const provider = new FakeLightningProvider({ settleMs: 10 * HOUR });
  const net = { down: false, balanceDown: false, readMs: 0 };
  const counts = { reads: 0, inFlight: 0, most: 0 };
  const info = provider.info.bind(provider), fee = provider.estimateFee.bind(provider), pay = provider.payInvoice.bind(provider);
  const make = provider.createInvoice.bind(provider), status = provider.invoiceStatus.bind(provider);
  provider.info = async () => {
    counts.reads++; counts.inFlight++; counts.most = Math.max(counts.most, counts.inFlight);
    try {
      // Sent while the source is down, it gets no answer, however long it takes.
      const unanswered = net.down || net.balanceDown;
      if (net.readMs) await new Promise((resolve) => setTimeout(resolve, net.readMs));
      if (unanswered) fail();
      return await info();
    } finally { counts.inFlight--; }
  };
  provider.estimateFee = async (invoice, amount) => { if (net.down) fail(); return fee(invoice, amount); };
  provider.payInvoice = async (invoice, maxFee) => { if (net.down) fail(); return pay(invoice, maxFee); };
  provider.createInvoice = async (amount, memo) => { if (net.down) fail(); return make(amount, memo); };
  provider.invoiceStatus = async (invoice) => { if (net.down) fail(); return status(invoice); };
  const events: LightningEvents = { changed: vi.fn(), received: vi.fn(), resolved: vi.fn() };
  const descriptor: LightningProviderDescriptor = { ...fakeLightning, fields: [], validate: undefined, create: async () => provider };
  const lightning = new LightningService("testnet", () => [cashuMint, descriptor], () => ({ platform: "web", cashu: { balance: async () => 0 } as unknown as CashuWallet }), events, CASHU_MINT_SOURCE);
  services.push(lightning);
  await lightning.start();
  await lightning.sources.set(fakeLightning.id, {});
  await advance(1_000);
  expect(lightning.view).toMatchObject({ status: "ready", balance: 100_000 });
  expect(lightning.view.error).toBeUndefined();
  return { lightning, provider, net, counts };
}

/** Down for `ms`, then back right after a balance read that got no answer (its wait is the longest left). */
async function outage(at: Awaited<ReturnType<typeof card>>, ms: number) {
  at.net.down = true;
  await advance(ms);
  const reads = at.counts.reads;
  while (at.counts.reads === reads) await advance(1_000);
  at.net.down = false;
  expect(at.lightning.view.error).toBe("Could not read the balance: Failed to fetch");
}

/** Seconds until the card shows its source's real balance with no error (up to `capS`). */
async function untilRight(at: Awaited<ReturnType<typeof card>>, capS = 45 * 60) {
  for (let s = 0; s <= capS; s++) {
    if (at.lightning.view.balance === at.provider.balance && at.lightning.view.error === undefined) return s;
    await advance(1_000);
  }
  return Infinity;
}

describe("a Lightning card whose source is back", () => {
  it.each([1, 2, 3])("down 2 h, back, pays 1,000 sats through the card at once: right again within 15 s, not 30 min (run %i)", async () => {
    const at = await card();
    await outage(at, 2 * HOUR);
    const quote = await at.lightning.quote(fakeInvoice(1_000, hash()));
    expect(await at.lightning.pay(quote.quote)).toBe(true);
    expect(at.provider.balance).toBe(100_000 - 1_000 - 10);
    const took = await untilRight(at);
    if (process.env.BALANCE_PACE) console.log(`paid after the outage: balance right again after ${took} s`);
    expect(took, "seconds until the balance is right").toBeLessThanOrEqual(15);
    expect(at.lightning.view).toMatchObject({ balance: 98_990, status: "ready" });
  }, 120_000);

  it("an invoice of ours seen paid after the outage: right again within 15 s", async () => {
    const at = await card();
    const invoice = await at.lightning.createInvoice(500);
    await outage(at, 40 * 60_000);
    at.provider.markPaid(invoice.paymentHash);
    // The payer says it paid it: the reconcile pass asks the source now and sees it paid.
    expect(await at.lightning.check(invoice.invoice)).toBe(true);
    expect(at.lightning.view.recent.find((op) => op.paymentHash === invoice.paymentHash)?.state).toBe("paid");
    const took = await untilRight(at);
    if (process.env.BALANCE_PACE) console.log(`invoice paid after the outage: balance right again after ${took} s`);
    expect(took, "seconds until the balance is right").toBeLessThanOrEqual(15);
    expect(at.lightning.view.balance).toBe(100_500);
  }, 120_000);

  it("a source still down keeps its slow pace: calls that get no answer bring no read", async () => {
    const at = await card();
    at.net.down = true;
    await advance(HOUR);
    const before = at.counts.reads;
    // Someone tries to pay through it every 5 min for an hour: each fee estimate fails.
    for (let i = 0; i < 12; i++) {
      await expect(at.lightning.quote(fakeInvoice(1_000, hash()))).rejects.toThrow("Failed to fetch");
      await advance(5 * 60_000);
    }
    if (process.env.BALANCE_PACE) console.log(`still down, reads in the hour of failed quotes: ${at.counts.reads - before}`);
    expect(at.counts.reads - before, "reads in the second hour").toBeLessThanOrEqual(2);
    expect(at.lightning.view.error).toBe("Could not read the balance: Failed to fetch");
  }, 120_000);

  it("a source that answers everything but its balance: one more read, not one per answer", async () => {
    const at = await card();
    at.net.balanceDown = true;
    await advance(HOUR);
    const before = at.counts.reads;
    for (let i = 0; i < 12; i++) {
      await at.lightning.quote(fakeInvoice(1_000, hash()));
      await advance(5 * 60_000);
    }
    if (process.env.BALANCE_PACE) console.log(`answers all but its balance, reads in the hour of quotes: ${at.counts.reads - before}`);
    // The slow pace (2 an hour) plus the one read the first answer brought.
    expect(at.counts.reads - before, "reads in the second hour").toBeLessThanOrEqual(3);
    expect(at.lightning.view.error).toBe("Could not read the balance: Failed to fetch");
    // Once a read answers, the next stretch of failed reads gets its one read again.
    at.net.balanceDown = false;
    await advance(31 * 60_000);
    expect(at.lightning.view.error).toBeUndefined();
  }, 120_000);

  it("an answer while a read sent during the outage is under way: the next read comes 15 s later, not 30 min", async () => {
    const at = await card();
    at.net.down = true;
    await advance(HOUR);
    at.net.readMs = 5_000;
    const reads = at.counts.reads;
    while (at.counts.reads === reads) await advance(1_000);
    expect(at.counts.inFlight, "a read sent while down, under way").toBe(1);
    at.net.down = false;
    await at.lightning.quote(fakeInvoice(1_000, hash()));
    const took = await untilRight(at);
    if (process.env.BALANCE_PACE) console.log(`answered during a read sent while down: balance right again after ${took} s`);
    expect(took, "seconds until the balance is right").toBeLessThanOrEqual(25);
  }, 120_000);

  it("several quick answers: at most one balance read under way, and only one read for them", async () => {
    const at = await card();
    await outage(at, HOUR);
    at.net.readMs = 5_000;
    const before = at.counts.reads;
    at.counts.most = 0;
    for (let i = 0; i < 5; i++) await at.lightning.quote(fakeInvoice(1_000, hash()));
    expect(at.counts.inFlight, "a read under way").toBe(1);
    await advance(6_000);
    expect(at.counts.most, "reads under way at once").toBe(1);
    expect(at.counts.reads - before, "reads for five answers").toBe(1);
    expect(at.lightning.view.error).toBeUndefined();
  }, 120_000);
});
