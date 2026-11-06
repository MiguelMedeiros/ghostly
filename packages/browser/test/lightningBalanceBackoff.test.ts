import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORES, transact } from "../src/shared/idb";
import type { CashuWallet } from "../src/engine/wallet";
import { cashuMint, CASHU_MINT_SOURCE } from "../src/engine/paymentAdapters/providers/cashuMint";
import { LndLightning, lnd, type LndTransport } from "../src/engine/paymentAdapters/providers/lnd";
import { LightningService, lightningJournalWritten, type LightningEvents } from "../src/engine/paymentAdapters/providers/lightningService";
import { FakeLightningProvider, fakeLightning } from "../src/engine/paymentAdapters/providers/testing";
import type { LightningProviderDescriptor } from "../src/engine/paymentAdapters/providers/lightning";
import { FakeLndNode, bakeMacaroon } from "./helpers/fakeLnd";
// covers: wallet.lightning.sources

/**
 * A Lightning card whose source stops answering after it connected was asked for its balance every 15 s for good: 240
 * failed requests an hour per card (LND), a signed request and a fresh relay dial each (NWC), with no backoff and no
 * reconnect. Now each failed read waits twice as long as the last, from 15 s up to 30 min; a read that answers, waking
 * up and Retry read at once and go back to every 15 s, the cadence of a source that answers (unchanged). The real LND
 * provider over an in-memory node, and the fake provider; nothing leaves the process.
 */

const HOUR = 3_600_000;
const MACAROON = bakeMacaroon(["info:read", "invoices:read", "invoices:write", "offchain:read", "offchain:write"]);
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

/** An in-memory LND node that can stop answering (`down`); `requests`: every request asked of it, by path. */
function lndNode() {
  const node = new FakeLndNode();
  const net = { down: false };
  const requests: string[] = [];
  const inner = node.transport();
  const transport: LndTransport = {
    request: async (request) => {
      requests.push(request.path);
      if (net.down) throw new TypeError("Failed to fetch");
      return inner.request(request);
    },
    close: () => {},
  };
  return { node, net, requests, transport };
}

const host = () => ({ platform: "web" as const, cashu: { balance: async () => 0 } as unknown as CashuWallet });
const events = (): LightningEvents => ({ changed: vi.fn(), received: vi.fn(), resolved: vi.fn() });

/** A Lightning card with nothing open on that node, connected. */
async function card(at: ReturnType<typeof lndNode>) {
  const descriptor = { ...lnd, create: async () => new LndLightning(at.transport, { receive: true, send: true, balance: true }) };
  const lightning = new LightningService("testnet", () => [cashuMint, descriptor], host, events(), CASHU_MINT_SOURCE);
  services.push(lightning);
  await lightning.start();
  await lightning.sources.set("lnd", { url: "https://127.0.0.1:1", macaroon: MACAROON });
  await lightning.recover();
  await advance(1000);
  expect(lightning.view).toMatchObject({ providerId: "lnd", status: "ready", read: true });
  return lightning;
}

/** Requests in each of `hours` hours. */
async function perHour(requests: string[], hours: number): Promise<number[]> {
  const counts: number[] = [];
  for (let h = 0; h < hours; h++) {
    const before = requests.length;
    await advance(HOUR);
    counts.push(requests.length - before);
  }
  return counts;
}

describe("the balance of a Lightning card whose node stops answering", () => {
  it("answering: read every 15 s, 480 requests an hour (unchanged)", async () => {
    const at = lndNode();
    await card(at);
    const before = at.requests.length;
    await advance(HOUR);
    const hour = at.requests.slice(before);
    if (process.env.BALANCE_PACE) console.log(`node answers, requests in an hour: ${hour.length}`);
    expect(hour.filter((p) => p === "/v1/getinfo")).toHaveLength(240);
    expect(hour.filter((p) => p === "/v1/balance/channels")).toHaveLength(240);
    expect(hour).toHaveLength(480);
  }, 120_000);

  it("down: read less and less often, up to every 30 min, and the card says why", async () => {
    const at = lndNode();
    const lightning = await card(at);
    at.net.down = true;
    const hours = await perHour(at.requests, 3);
    if (process.env.BALANCE_PACE) console.log(`node down, requests per hour: ${hours.join(", ")}`);
    // 15 s, then twice as late after each read with no answer: 8 the first hour, then 2 an hour. It was 240 an hour.
    expect(hours[0], "first hour").toBeLessThanOrEqual(10);
    expect(hours[1], "second hour").toBeLessThanOrEqual(2);
    expect(hours[2], "third hour").toBeLessThanOrEqual(2);
    expect(hours[0], "still read").toBeGreaterThanOrEqual(5);
    expect(hours[2], "still read").toBeGreaterThanOrEqual(1);
    // Still connected, saying the balance could not be read (the balance shown is the last one read).
    expect(lightning.view).toMatchObject({ status: "ready", error: "Could not read the balance: Failed to fetch" });
  }, 120_000);

  it("back: the next read answers within the wait earned, then every 15 s again", async () => {
    const at = lndNode();
    const lightning = await card(at);
    at.net.down = true;
    await advance(2 * HOUR);
    at.net.down = false;
    // The wait is 30 min at most.
    await advance(30 * 60_000 + 1_000);
    expect(lightning.view.error, "read again").toBeUndefined();
    const before = at.requests.length;
    await advance(10 * 60_000);
    expect(at.requests.length - before, "every 15 s again").toBe(80);
  }, 120_000);

  it("Retry reads at once whatever the wait, and so does waking up", async () => {
    const at = lndNode();
    const lightning = await card(at);
    at.net.down = true;
    await advance(HOUR);
    at.net.down = false;
    const retried = at.requests.length;
    await lightning.sources.retryNow();
    expect(at.requests.length - retried, "Retry: read now").toBe(2);
    expect(lightning.view.error).toBeUndefined();

    at.net.down = true;
    await advance(HOUR);
    at.net.down = false;
    const woke = at.requests.length;
    lightning.sources.wake();
    await advance(1_000);
    expect(at.requests.length - woke, "waking: read now").toBe(2);
    expect(lightning.view.error).toBeUndefined();
    const after = at.requests.length;
    await advance(60_000);
    expect(at.requests.length - after, "then every 15 s").toBe(8);
  }, 120_000);

  it("waking up while it is still down starts the wait again from 15 s", async () => {
    const at = lndNode();
    const lightning = await card(at);
    at.net.down = true;
    await advance(HOUR);
    const woke = at.requests.length;
    lightning.sources.wake();
    await advance(1_000);
    expect(at.requests.length - woke, "read now").toBe(1);
    await advance(15_000);
    expect(at.requests.length - woke, "and 15 s later").toBe(2);
    expect(lightning.view).toMatchObject({ status: "ready", error: "Could not read the balance: Failed to fetch" });
  }, 60_000);
});

describe("any Lightning source (NWC reads through the same path)", () => {
  it("a source whose balance read fails is read less and less often, and every 15 s again once it answers", async () => {
    const provider = new FakeLightningProvider({ settleMs: 600_000 });
    let down = false, reads = 0;
    const answer = provider.info.bind(provider);
    provider.info = async () => { reads++; if (down) throw new Error("No answer from the wallet's relay"); return answer(); };
    const descriptor: LightningProviderDescriptor = { ...fakeLightning, fields: [], validate: undefined, create: async () => provider };
    const lightning = new LightningService("testnet", () => [cashuMint, descriptor], host, events(), CASHU_MINT_SOURCE);
    services.push(lightning);
    await lightning.start();
    await lightning.sources.set(fakeLightning.id, {});
    await advance(1_000);
    expect(lightning.view).toMatchObject({ status: "ready", balance: 100_000 });
    down = true;
    let before = reads;
    await advance(HOUR);
    const first = reads - before;
    before = reads;
    await advance(HOUR);
    const second = reads - before;
    if (process.env.BALANCE_PACE) console.log(`fake source down, reads per hour: ${first}, ${second}`);
    expect(first).toBeLessThanOrEqual(10);
    expect(second).toBeLessThanOrEqual(2);
    expect(lightning.view.error).toBe("Could not read the balance: No answer from the wallet's relay");
    down = false;
    await advance(30 * 60_000 + 1_000);
    expect(lightning.view.error).toBeUndefined();
    before = reads;
    await advance(60_000);
    expect(reads - before, "every 15 s again").toBe(4);
  }, 120_000);
});
