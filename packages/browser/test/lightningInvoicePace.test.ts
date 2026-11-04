import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORES, transact } from "../src/shared/idb";
import type { CashuWallet } from "../src/engine/wallet";
import { cashuMint, CASHU_MINT_SOURCE } from "../src/engine/paymentAdapters/providers/cashuMint";
import type { LightningProviderDescriptor } from "../src/engine/paymentAdapters/providers/lightning";
import { LightningService, lightningJournalWritten, type LightningEvents } from "../src/engine/paymentAdapters/providers/lightningService";
import { FakeLightningProvider, fakeLightning } from "../src/engine/paymentAdapters/providers/testing";
// covers: wallet.lightning.sources

/**
 * agents#2447: an open invoice of a Lightning card (LND, NWC, Core Lightning: an hour each) is asked about often while
 * someone is likely paying it, then less and less. Before, its source was asked every 4 s for the whole hour.
 */

const HOUR = 3_600_000;
/**
 * Fake time, a second at a time. IndexedDB (fake-indexeddb) answers on real macrotasks, which fake timers do not run:
 * each step lets them, so a pass ends at the fake second it started in.
 */
async function advance(ms: number) {
  for (let left = ms; left > 0; left -= 1000) {
    await vi.advanceTimersByTimeAsync(Math.min(1000, left));
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

/** A card whose source nobody pays: its invoices stay open for their hour. */
async function card(closed = new Set<string>()) {
  const provider = new FakeLightningProvider({ settleMs: 10 * HOUR });
  const status = vi.spyOn(provider, "invoiceStatus");
  const events = { changed: vi.fn(), received: vi.fn(), resolved: vi.fn(), requestClosed: (id: string) => closed.has(id) } satisfies LightningEvents;
  const descriptor: LightningProviderDescriptor = { ...fakeLightning, fields: [], validate: undefined, create: async () => provider };
  const lightning = new LightningService("testnet", () => [cashuMint, descriptor], () => ({ platform: "web", cashu: { balance: async () => 7 } as unknown as CashuWallet }), events, CASHU_MINT_SOURCE);
  services.push(lightning);
  await lightning.start();
  await lightning.sources.set("fake-lightning", {});
  await advance(1000);
  status.mockClear();
  return { lightning, provider, status, events, closed };
}

describe("an invoice of a Lightning card nobody pays (agents#2447)", () => {
  it("is asked about about a hundred times in its hour, not every 4 s, and ends expired", async () => {
    const { lightning, status } = await card();
    const created = await lightning.createInvoice(100);
    await advance(HOUR + 3 * 60_000);
    if (process.env.INVOICE_PACE) console.log(`one unpaid Lightning card invoice, one hour: ${status.mock.calls.length} lookups`);
    expect(status.mock.calls.length).toBeLessThan(110);
    expect(status.mock.calls.length).toBeGreaterThanOrEqual(28);
    expect((await lightning.list()).find((op) => op.paymentHash === created.paymentHash)?.state).toBe("expired");
  });

  it("paid while the screen watches it, shows within seconds", async () => {
    const { lightning, provider, status, events } = await card();
    const created = await lightning.createInvoice(100);
    await advance(30 * 60_000);
    expect(await lightning.watch(created.invoice)).toBe(true);
    const before = status.mock.calls.length;
    await advance(40_000);
    expect(status.mock.calls.length - before, "fast while watched").toBeGreaterThanOrEqual(9);
    provider.markPaid(created.paymentHash);
    await advance(5_000);
    expect(events.received).toHaveBeenCalledOnce();
  });
});

describe("the invoice of a chat request that was closed (agents#2447)", () => {
  it("is asked about no more until it expired, then once", async () => {
    const { lightning, status, closed } = await card();
    const created = await lightning.createInvoice(100, { paymentId: "request-1" });
    await advance(60_000);
    closed.add("request-1");
    status.mockClear();
    await advance(HOUR + 3 * 60_000);
    if (process.env.INVOICE_PACE) console.log(`closed request's Lightning invoice, the rest of its hour: ${status.mock.calls.length} lookups`);
    expect(status.mock.calls.length).toBe(1);
    expect((await lightning.list()).find((op) => op.paymentHash === created.paymentHash)?.state).toBe("expired");
  });

  it("is asked about at once when its payer says it paid (the request's check)", async () => {
    const { lightning, provider, events, closed } = await card();
    const created = await lightning.createInvoice(100, { paymentId: "request-1" });
    closed.add("request-1");
    provider.markPaid(created.paymentHash);
    expect(await lightning.check(created.invoice)).toBe(true);
    expect(events.received).toHaveBeenCalledOnce();
  });
});

describe("a payer's \"I paid\" for one invoice of a card with 100 open", () => {
  it("asks the source about that invoice alone, then at the fast pace a while; the others keep theirs", async () => {
    const { lightning, provider, status, events } = await card();
    const created = [];
    for (let i = 0; i < 100; i++) created.push(await lightning.createInvoice(100 + i));
    await advance(30 * 60_000);
    status.mockClear();
    expect(await lightning.check(created[42].invoice)).toBe(true);
    if (process.env.INVOICE_PACE) console.log(`one "I paid", 100 open card invoices: ${status.mock.calls.length} lookups`);
    expect(status.mock.calls.map(([asked]) => asked.paymentHash)).toEqual([created[42].paymentHash]);
    expect(await lightning.check("lnbc1notours")).toBe(false);
    expect(status).toHaveBeenCalledOnce();
    provider.markPaid(created[42].paymentHash);
    await advance(5_000);
    expect(events.received, "fast while the payment settles").toHaveBeenCalledOnce();
  });
});
