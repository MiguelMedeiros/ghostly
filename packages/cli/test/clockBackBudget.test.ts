import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_REQUESTS_PER_MINUTE, BACKGROUND_WRITES_SHARE, DAEMON_WATCH_PEER_IDLE_MS, FRESH_READ_MS, REQUESTS_PER_MINUTE, createIdentity } from "@ghostly/core";
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
/**
 * What the budget leaves the background on each relay in a minute (`heldFor` in core's relay.ts, at the default budget):
 * its background share, and of it what the background writes leave to reads. The away contacts' reads and their chats'
 * upkeep are all background requests here.
 */
const BACKGROUND_SHARE = Math.min(BACKGROUND_REQUESTS_PER_MINUTE, Math.ceil(REQUESTS_PER_MINUTE * 2 / 3));
const READS_SHARE = BACKGROUND_SHARE - Math.max(1, Math.floor(BACKGROUND_SHARE * BACKGROUND_WRITES_SHARE));
const mean = (list: number[]) => list.reduce((sum, n) => sum + n, 0) / list.length;

const chat = (i: number) => ({ id: `chat-${i}`, profile: "paired-chat/1", createdAt: 1, label: `c${i}`, seedB64: createIdentity().seedB64,
  encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64,
  pairedPeerKey: createIdentity().pubKeyZ32, peerTrust: { version: 1 } }) as StoredLink;

/** A DHT node with nothing on it. `gets`: every key read there. */
const dhtNode = (gets: string[]) => ({
  get: async (key: string) => { gets.push(key); await new Promise((r) => setTimeout(r, 1_500)); return null; },
  put: async () => { await new Promise((r) => setTimeout(r, 200)); return 8; },
  destroy: async () => {},
}) as unknown as Mainline;

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
  /** Every relay read: the key read, and when it went and was answered. Every relay write: when. Every DHT read: the key read. */
  const gets: string[] = [], reads: { key: string; at: number; answeredAt: number }[] = [], puts: number[] = [], dhtGets: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const read = (init?.method ?? "GET") === "GET" ? { key: new URL(String(input)).pathname.slice(1), at: Date.now(), answeredAt: Infinity } : undefined;
    if (read) { gets.push(read.key); reads.push(read); } else puts.push(Date.now());
    await new Promise((r) => setTimeout(r, 50));
    if (read) read.answeredAt = Date.now();
    return init?.method === "PUT" ? new Response(null, { status: 204 }) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const transport = new RelaysAndDht(dhtNode(dhtGets), { relays: RELAYS, fetch: fetchFn, log: () => {} }, true);
  node = new GhostlyNode({ onState: () => {}, onMessages: () => {}, onCallSignal: () => {} }, {
    transport, automaticWallets: false, nativeTransports: {}, singleDevice: true, staysOnline: true, watchPeerIdleMs: DAEMON_WATCH_PEER_IDLE_MS,
  });
  await node.start();
  return { rows, gets, reads, puts, dhtGets, node };
}

describe("a daemon after the device clock is set back", { timeout: 120_000 }, () => {
  it.each([["not set back", 0], ["set back an hour", 60 * MIN]])("50 contacts away, clock %s at minute 5: every contact is read in the next 15 minutes", async (_, back) => {
    const { rows, gets, puts } = await daemon(50);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    vi.setSystemTime(Date.now() - back);
    const from = gets.length, perMinute: number[] = [], writesPerMinute: number[] = [];
    for (let m = 0; m < 15; m++) {
      const before = gets.length, writesBefore = puts.length;
      await vi.advanceTimersByTimeAsync(MIN);
      perMinute.push(gets.length - before);
      writesPerMinute.push(puts.length - writesBefore);
    }
    const read = new Set(gets.slice(from));
    // Before: 3-4 of the 50 after an hour back, 0-8 relay reads a minute. The minute of the step
    // counts as just spent, at most.
    expect(rows.filter((row) => read.has(row.peerPubKeyZ32)).length).toBeGreaterThanOrEqual(48);
    // The rate, from the budget's shares, and no minute stalled. The reads get at least what the background writes leave
    // them (10 a relay), and with the writes they spend the background's whole share (20 a relay). Not a fixed 30 reads:
    // since the chats' upkeep held back has its share again (#7760) the reads go at 29-33 a minute, steady
    // clock or not, and a run of 29.9 failed. Not every single minute either: the minutes are fake but the reads wait on
    // real work, so on a loaded runner one minute's reads spill into the next (26-29 then 58-60 under a 40% CPU quota).
    const later = perMinute.slice(2), writes = writesPerMinute.slice(2);
    const seen = `reads ${perMinute.join(",")}, writes ${writesPerMinute.join(",")}`;
    expect(mean(later), seen).toBeGreaterThan(RELAYS.length * READS_SHARE);
    expect(mean(later.map((n, i) => n + writes[i]!)), seen).toBeGreaterThanOrEqual(RELAYS.length * BACKGROUND_SHARE);
    expect(Math.min(...later), seen).toBeGreaterThan(10);
  });

  it("set back an hour: a chat opened reads its contact at once", async () => {
    const { rows, gets, reads, dhtGets, node } = await daemon(50);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    vi.setSystemTime(Date.now() - 60 * MIN);
    await vi.advanceTimersByTimeAsync(15 * MIN);
    const key = rows[7]!.peerPubKeyZ32, from = gets.length, fromDht = dhtGets.length, opened = Date.now();
    node.setActiveLink({ linkId: rows[7]!.id });
    // At once, clock set back or not: on the relays, or on the DHT in their place when their minute is full of the away
    // contacts' requests (`RelaysAndDht.heldBack`). A relay read of the contact under way when the chat opened, or answered
    // just before (`FRESH_READ_MS`), is that read: the chat's own read waits for it, or the relays answer it with that.
    await vi.advanceTimersByTimeAsync(1_000);
    const relayRead = reads.some((read) => read.key === key && read.answeredAt >= opened - FRESH_READ_MS);
    const seen = `relay reads of it (ms from the opening): ${reads.filter((read) => read.key === key).slice(-3).map((read) => read.at - opened).join(", ")}`;
    expect(relayRead || dhtGets.slice(fromDht).includes(key), seen).toBe(true);
    // And on the relays soon after; before the fix they held it for as long as the clock went back. Not within a fixed
    // 10 s: the relays take the keys' reads in turn, the away contacts' reads held back over a minute first
    // (`READ_STARVED_MS`). Since the relay copies wait for every relay (#7760) there are more of those: the relay read came
    // 10-12.5 s after in 4 of 50 runs under load (3.5 s at most before #7760), past 10 s once on CI. Waited for in steps.
    let waited = 1_000;
    while (!gets.slice(from).includes(key) && waited < 2 * MIN) { await vi.advanceTimersByTimeAsync(1_000); waited += 1_000; }
    expect(gets.slice(from), `relay reads in the ${waited / 1_000} s after it was opened`).toContain(key);
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
