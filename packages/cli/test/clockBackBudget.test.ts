import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_WATCH_PEER_IDLE_MS, createIdentity } from "@ghostly/core";
import { GhostlyNode } from "@ghostly/browser/engine/node";
import { db } from "@ghostly/browser/engine/db";
import { STORES, transact } from "@ghostly/browser/shared/idb";
import type { StoredLink } from "@ghostly/browser/shared/types";
import { DhtBackgroundBudget, RelaysAndDht, type Mainline } from "../src/runtime/mainline";
// covers: headless.daemon, core.relay-client

/**
 * The relays' request budget and the DHT's background one count each request by when it went, on the device's clock.
 * After that clock was set back (an NTP step, a clock that ran ahead fixed by hand), the requests dated before the step
 * were "in the last minute" until the clock passed them again: a daemon with 50 contacts away read 4 of them in the 15
 * minutes after an hour's step back. A request dated after now counts as just made, at most.
 *
 * An engine set up as the CLI's, its saved paired chats' contacts all away, two relays at the default budget behind a
 * `fetch` stub (no packet for anyone), and a DHT node with nothing either.
 */

const MIN = 60_000;
const RELAYS = ["https://relay-one.test", "https://relay-two.test"];

const chat = (i: number) => ({ id: `chat-${i}`, profile: "paired-chat/1", createdAt: 1, label: `c${i}`, seedB64: createIdentity().seedB64,
  encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64,
  pairedPeerKey: createIdentity().pubKeyZ32, peerTrust: { version: 1 } }) as StoredLink;

const dht = {
  get: async () => { await new Promise((r) => setTimeout(r, 1_500)); return null; },
  put: async () => { await new Promise((r) => setTimeout(r, 200)); return 8; },
  destroy: async () => {},
} as unknown as Mainline;

let node: GhostlyNode | undefined;
afterEach(async () => {
  const stopped = node?.shutdown(); node = undefined;
  if (stopped) { await vi.advanceTimersByTimeAsync(30_000); await stopped; }
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
}, 60_000);

async function daemon(contacts: number) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.stubGlobal("RTCPeerConnection", undefined);
  await transact([STORES.links, STORES.messages], (s) => { s[STORES.links].clear(); s[STORES.messages].clear(); });
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  const rows = Array.from({ length: contacts }, (_, i) => chat(i));
  for (const row of rows) await db.putLink(row);
  /** Every relay read: the key read. */
  const gets: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") gets.push(new URL(String(input)).pathname.slice(1));
    await new Promise((r) => setTimeout(r, 50));
    return init?.method === "PUT" ? new Response(null, { status: 204 }) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const transport = new RelaysAndDht(dht, { relays: RELAYS, fetch: fetchFn, log: () => {} }, true);
  node = new GhostlyNode({ onState: () => {}, onMessages: () => {}, onCallSignal: () => {} }, {
    transport, automaticWallets: false, nativeTransports: {}, singleDevice: true, staysOnline: true, watchPeerIdleMs: DAEMON_WATCH_PEER_IDLE_MS,
  });
  await node.start();
  return { rows, gets, node };
}

describe("a daemon after the device clock is set back", { timeout: 120_000 }, () => {
  it.each([["not set back", 0], ["set back an hour", 60 * MIN]])("50 contacts away, clock %s at minute 5: every contact is read in the next 15 minutes", async (_, back) => {
    const { rows, gets } = await daemon(50);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    vi.setSystemTime(Date.now() - back);
    const from = gets.length, perMinute: number[] = [];
    for (let m = 0; m < 15; m++) {
      const before = gets.length;
      await vi.advanceTimersByTimeAsync(MIN);
      perMinute.push(gets.length - before);
    }
    const read = new Set(gets.slice(from));
    // Before: 3-4 of the 50 after an hour back, 0-8 relay reads a minute (47-60 with no step). The minute of the step
    // counts as just spent, at most.
    expect(rows.filter((row) => read.has(row.peerPubKeyZ32)).length).toBeGreaterThanOrEqual(48);
    // The rate, and no minute stalled. Not more than 30 in every single minute: the minutes are fake but the reads wait on
    // real work, so on a loaded runner one minute's reads spill into the next (26-29 then 58-60 under a 40% CPU quota).
    const later = perMinute.slice(2);
    expect(later.reduce((sum, n) => sum + n, 0) / later.length).toBeGreaterThan(30);
    expect(Math.min(...later)).toBeGreaterThan(10);
  });

  it("set back an hour: a chat opened reads its contact at once", async () => {
    const { rows, gets, node } = await daemon(50);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    vi.setSystemTime(Date.now() - 60 * MIN);
    await vi.advanceTimersByTimeAsync(15 * MIN);
    const from = gets.length;
    node.setActiveLink({ linkId: rows[7]!.id });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gets.slice(from)).toContain(rows[7]!.peerPubKeyZ32);
  });
});

describe("DhtBackgroundBudget after the device clock is set back", () => {
  it.each([["not set back", 0], ["set back an hour", 60 * MIN]])("the minute's lookups spent, clock %s: five minutes later every key looks up in its turn", (_, back) => {
    const budget = new DhtBackgroundBudget(() => 40);
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 40; i++) expect(budget.take(`old${i}`, t0)).toBe(0);
    expect(budget.take("full", t0)).toBeGreaterThan(0);
    // The 41 keys and a new one ask every 15 s from five minutes after the step, for three minutes.
    const keys = ["new", "full", ...Array.from({ length: 40 }, (_, i) => `old${i}`)];
    const looked = new Set<string>();
    for (let t = t0 - back + 5 * MIN; t < t0 - back + 8 * MIN; t += 15_000) for (const key of keys) if (budget.take(key, t) === 0) looked.add(key);
    // Before: none of them after an hour back, a new key waiting 56 minutes and an old one as long.
    expect(looked.size).toBe(keys.length);
  });

  it("set back an hour just after the minute was spent: a new key waits at most the minute", () => {
    const budget = new DhtBackgroundBudget(() => 40);
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 40; i++) budget.take(`old${i}`, t0);
    const wait = budget.take("new", t0 - 60 * MIN);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(2 * MIN);
  });
});
