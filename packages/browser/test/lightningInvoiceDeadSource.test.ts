import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORES, transact } from "../src/shared/idb";
import type { CashuWallet } from "../src/engine/wallet";
import { cashuMint, CASHU_MINT_SOURCE } from "../src/engine/paymentAdapters/providers/cashuMint";
import { LndLightning, lnd, type LndTransport } from "../src/engine/paymentAdapters/providers/lnd";
import { LightningService, lightningJournalWritten, type LightningEvents } from "../src/engine/paymentAdapters/providers/lightningService";
import { FakeLndNode, bakeMacaroon } from "./helpers/fakeLnd";
// covers: wallet.lightning.sources

/**
 * An open invoice of a Lightning card whose source stops answering was asked about every minute for good (60 lookups
 * an hour per invoice, 1,200 for 20), and stayed "waiting for payment" hours after it expired, since only an answer
 * turned it expired. Now each such invoice waits twice as long after each ask with no answer, from 30 s up to 30 min
 * (as Cashu quotes), one failed lookup in a pass holds the card's other invoices until the next pass, and past its
 * expiry (and the grace) it shows expired while it is still asked, so a late "paid" counts. The real LND provider over
 * an in-memory node; nothing leaves the process.
 */

const HOUR = 3_600_000;
const MACAROON = bakeMacaroon(["info:read", "invoices:read", "invoices:write", "offchain:read", "offchain:write"]);
/**
 * Fake time, a second at a time. IndexedDB (fake-indexeddb) answers on real macrotasks, which fake timers do not run:
 * each step lets them, so a pass ends at the fake second it started in.
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

/** An in-memory LND node that can stop answering (`down`); `lookups`: every invoice lookup asked of it. */
function lndNode() {
  const node = new FakeLndNode();
  const net = { down: false };
  const lookups: string[] = [];
  const inner = node.transport();
  const transport: LndTransport = {
    request: async (request) => {
      if (request.method === "GET" && request.path.startsWith("/v1/invoice/")) lookups.push(request.path);
      if (net.down) throw new TypeError("Failed to fetch");
      return inner.request(request);
    },
    close: () => {},
  };
  return { node, net, lookups, transport };
}

/** A Lightning card on that node (its source stored, so a service on the same database reconnects to it). */
async function card(at: ReturnType<typeof lndNode>, connect = true) {
  const events = { changed: vi.fn(), received: vi.fn(), resolved: vi.fn() } satisfies LightningEvents;
  const descriptor = { ...lnd, create: async () => new LndLightning(at.transport, { receive: true, send: true, balance: true }) };
  const lightning = new LightningService("testnet", () => [cashuMint, descriptor], () => ({ platform: "web", cashu: { balance: async () => 0 } as unknown as CashuWallet }), events, CASHU_MINT_SOURCE);
  services.push(lightning);
  await lightning.start();
  if (connect) await lightning.sources.set("lnd", { url: "https://127.0.0.1:1", macaroon: MACAROON });
  await lightning.recover();
  await advance(1000);
  expect(lightning.view).toMatchObject({ providerId: "lnd", status: "ready" });
  return { lightning, events };
}

/** Invoice lookups in each of `hours` hours. */
async function perHour(lookups: string[], hours: number): Promise<number[]> {
  const counts: number[] = [];
  for (let h = 0; h < hours; h++) {
    const before = lookups.length;
    await advance(HOUR);
    counts.push(lookups.length - before);
  }
  return counts;
}
const shown = (lightning: LightningService, hash: string) => lightning.view.recent.find((op) => op.paymentHash === hash)?.state;
const stored = async (lightning: LightningService, hash: string) => (await lightning.list()).find((op) => op.paymentHash === hash)?.state;

describe("open invoices of a Lightning card whose node stops answering", () => {
  for (const count of [1, 20]) {
    it(`${count} open: asked less and less often, one failed lookup a pass for the card, and shown expired past the expiry`, async () => {
      const at = lndNode();
      const { lightning } = await card(at);
      const created = [];
      for (let i = 0; i < count; i++) created.push(await lightning.createInvoice(100 + i));
      at.net.down = true;
      const hours = await perHour(at.lookups, 3);
      if (process.env.INVOICE_PACE) console.log(`${count} open card invoice(s), node down, lookups per hour: ${hours.join(", ")}`);
      // About 8 the first hour (30 s, then twice as late each time), then 2 an hour; every minute, it was 60 per invoice.
      expect(hours[0], "first hour").toBeLessThanOrEqual(10);
      expect(hours[1], "second hour").toBeLessThanOrEqual(3);
      expect(hours[2], "third hour").toBeLessThanOrEqual(3);
      expect(hours[0], "still asked").toBeGreaterThanOrEqual(5);
      expect(hours[2], "still asked").toBeGreaterThanOrEqual(1);
      // Expired two hours ago: shown so, while the journal keeps it open for a late answer.
      for (const { paymentHash } of created) {
        expect(shown(lightning, paymentHash)).toBe("expired");
        expect(await stored(lightning, paymentHash)).toBe("open");
      }
    }, 120_000);
  }

  it("a late \"paid\" after the node is back still counts once", async () => {
    const at = lndNode();
    const { lightning, events } = await card(at);
    const created = await lightning.createInvoice(100, { paymentId: "request-1" });
    at.net.down = true;
    await advance(HOUR + 5 * 60_000);
    expect(shown(lightning, created.paymentHash)).toBe("expired");
    // Paid just before it expired, and the node only now tells.
    at.node.settle(created.paymentHash);
    at.net.down = false;
    await advance(30 * 60_000 + 5_000);
    expect(events.received).toHaveBeenCalledOnce();
    expect(events.received).toHaveBeenCalledWith(expect.objectContaining({ paymentId: "request-1", providerId: "lnd" }));
    expect(await stored(lightning, created.paymentHash)).toBe("paid");
    expect(shown(lightning, created.paymentHash)).toBe("paid");
    const after = at.lookups.length;
    await advance(HOUR);
    expect(at.lookups.length - after, "paid: asked no more").toBe(0);
    expect(events.received).toHaveBeenCalledOnce();
  }, 120_000);

  it("shows expired after a restart with the node still down, before any answer", async () => {
    const at = lndNode();
    const first = await card(at);
    const created = await first.lightning.createInvoice(100);
    await first.lightning.stop();
    at.net.down = true;
    // Two hours later: the node is still down, so the source does not even connect.
    vi.setSystemTime(Date.now() + 2 * HOUR);
    const events = { changed: vi.fn(), received: vi.fn(), resolved: vi.fn() } satisfies LightningEvents;
    const descriptor = { ...lnd, create: async () => new LndLightning(at.transport, { receive: true, send: true, balance: true }) };
    const again = new LightningService("testnet", () => [cashuMint, descriptor], () => ({ platform: "web", cashu: { balance: async () => 0 } as unknown as CashuWallet }), events, CASHU_MINT_SOURCE);
    services.push(again);
    await again.start();
    // As the engine starts a card.
    void again.recover().then(() => again.ensureReady()).catch(() => {});
    await advance(5_000);
    expect(shown(again, created.paymentHash)).toBe("expired");
    expect(await stored(again, created.paymentHash)).toBe("open");
  }, 60_000);

  it("the node back: the next lookup is within the wait earned, then the usual pace resumes", async () => {
    const at = lndNode();
    const { lightning } = await card(at);
    const created = await lightning.createInvoice(100);
    await advance(10 * 60_000);
    at.net.down = true;
    await advance(20 * 60_000);
    at.net.down = false;
    const back = at.lookups.length;
    // The longest wait earned in 20 min of silence is 16 min (30 s doubled five times).
    await advance(17 * 60_000);
    expect(at.lookups.length - back, "asked once the wait ran out").toBeGreaterThanOrEqual(1);
    const resumed = at.lookups.length;
    await advance(10 * 60_000);
    // The invoice's own pace (every minute at this age), not the wait its silence earned.
    expect(at.lookups.length - resumed, "every minute again").toBeGreaterThanOrEqual(9);
    expect(await stored(lightning, created.paymentHash)).toBe("open");
    expect(shown(lightning, created.paymentHash)).toBe("open");
  }, 120_000);

  it("the screen showing it, or a payer's \"I paid\", asks at once whatever the wait", async () => {
    const at = lndNode();
    const { lightning, events } = await card(at);
    const created = await lightning.createInvoice(100);
    at.net.down = true;
    await advance(30 * 60_000);
    at.net.down = false;
    at.node.settle(created.paymentHash);
    const before = at.lookups.length;
    expect(await lightning.check(created.invoice)).toBe(true);
    expect(at.lookups.length - before).toBe(1);
    expect(events.received).toHaveBeenCalledOnce();

    const other = await lightning.createInvoice(200);
    at.net.down = true;
    await advance(30 * 60_000);
    at.net.down = false;
    const watched = at.lookups.length;
    expect(await lightning.watch(other.invoice)).toBe(true);
    await advance(2_000);
    expect(at.lookups.length - watched, "asked at once").toBeGreaterThanOrEqual(1);
  }, 120_000);
});

describe("controls (unchanged)", () => {
  it("paid seen: no lookup afterwards, received once", async () => {
    const at = lndNode();
    const { lightning, events } = await card(at);
    const created = await lightning.createInvoice(100);
    at.node.settle(created.paymentHash);
    await advance(10_000);
    expect(events.received).toHaveBeenCalledOnce();
    const after = at.lookups.length;
    await advance(HOUR);
    expect(at.lookups.length - after).toBe(0);
    expect(events.received).toHaveBeenCalledOnce();
  }, 60_000);

  it("paid while the app was closed: found a second after the next start, counted once", async () => {
    const at = lndNode();
    const first = await card(at);
    const created = await first.lightning.createInvoice(100, { paymentId: "request-1" });
    await first.lightning.stop();
    at.node.settle(created.paymentHash);
    const events = { changed: vi.fn(), received: vi.fn(), resolved: vi.fn() } satisfies LightningEvents;
    const descriptor = { ...lnd, create: async () => new LndLightning(at.transport, { receive: true, send: true, balance: true }) };
    const again = new LightningService("testnet", () => [cashuMint, descriptor], () => ({ platform: "web", cashu: { balance: async () => 0 } as unknown as CashuWallet }), events, CASHU_MINT_SOURCE);
    services.push(again);
    await again.start();
    // As the engine starts a card.
    void again.recover().then(() => again.ensureReady()).catch(() => {});
    // Its stored secrets are unsealed by WebCrypto, which runs on real time.
    await vi.waitFor(() => expect(again.view.status).toBe("ready"), { interval: 0 });
    await advance(1_000);
    expect(events.received).toHaveBeenCalledOnce();
    expect(events.received).toHaveBeenCalledWith(expect.objectContaining({ paymentId: "request-1" }));
    await advance(60_000);
    expect(events.received).toHaveBeenCalledOnce();
  }, 60_000);
});
