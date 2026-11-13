import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_WATCH_PEER_IDLE_MS, createIdentity, isDiscoveryBudgetError, type SignedPacket } from "@ghostly/core";
import { GhostlyNode } from "@ghostly/browser/engine/node";
import { db } from "@ghostly/browser/engine/db";
import { STORES, transact } from "@ghostly/browser/shared/idb";
import type { StoredLink } from "@ghostly/browser/shared/types";
import { DhtBackgroundBudget, RelaysAndDht, type Mainline } from "../src/runtime/mainline";
// covers: headless.daemon, core.relay-client

/**
 * A daemon whose relays all fail reads its contacts on the Mainline DHT instead (`RelaysAndDht`). Its background reads
 * went there with no budget: every contact away was looked up four times a minute (the link's 30 s read and the DHT
 * mailbox's) for the whole outage, 200 lookups a minute at 50 contacts and 1,200 at 300, where the same daemon made
 * 26-54 relay reads a minute in all with the relays up. They keep the relays' background share now (20 a minute per
 * relay, 40 with the two here); reads someone waits on go at once.
 *
 * An engine set up as the CLI's (`singleDevice`, `staysOnline`, `watchPeerIdleMs`), its saved paired chats' contacts
 * all away, two relays at the default budget behind a `fetch` stub, and a fake DHT node that counts its lookups.
 */

const MIN = 60_000;
const RELAYS = ["https://relay-one.test", "https://relay-two.test"];
/** The relays' background share on these two relays (`BACKGROUND_REQUESTS_PER_MINUTE` x 2). */
const BOUND = 40;

const chat = (i: number) => ({ id: `chat-${i}`, profile: "paired-chat/1", createdAt: 1, label: `c${i}`, seedB64: createIdentity().seedB64,
  encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64,
  pairedPeerKey: createIdentity().pubKeyZ32, peerTrust: { version: 1 } }) as StoredLink;

/** A DHT node that has nothing for anyone, answering after 1.5 s; every lookup counted with its time and key. */
function fakeDht() {
  const gets: { at: number; key: string }[] = [];
  const dht = {
    get: async (key: string): Promise<SignedPacket | null> => { gets.push({ at: Date.now(), key }); await new Promise((r) => setTimeout(r, 1_500)); return null; },
    put: async () => { await new Promise((r) => setTimeout(r, 200)); return 8; },
    destroy: async () => {},
  };
  return { dht: dht as unknown as Mainline, gets };
}

/** Relays that have no packet for anyone (404), or answer 502 while `down`, or 429 (a minute's wait) while `limiting`. */
function relayStub(state: { down: boolean; limiting?: boolean; gets: number[] }): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") state.gets.push(Date.now());
    await new Promise((r) => setTimeout(r, 50));
    if (state.down) return new Response("bad gateway", { status: 502 });
    if (state.limiting) return new Response("slow down", { status: 429, headers: { "retry-after": "60" } });
    return init?.method === "PUT" ? new Response(null, { status: 204 }) : new Response(null, { status: 404 });
  }) as typeof fetch;
}

let node: GhostlyNode | undefined;
afterEach(async () => {
  // The engine stops on the fake clock: what it waits on to stop runs on it.
  const stopped = node?.shutdown(); node = undefined;
  if (stopped) { await vi.advanceTimersByTimeAsync(30_000); await stopped; }
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
}, 60_000);

/** Per minute since `t0`, from minute `from` to `to` (excluded). */
const perMinute = (times: number[], t0: number, from: number, to: number) => {
  const counts = Array.from({ length: to - from }, () => 0);
  for (const at of times) { const m = Math.floor((at - t0) / MIN); if (m >= from && m < to) counts[m - from]++; }
  return counts;
};

async function daemon(contacts: number) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.stubGlobal("RTCPeerConnection", undefined);
  await transact([STORES.links, STORES.messages], (s) => { s[STORES.links].clear(); s[STORES.messages].clear(); });
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  const rows = Array.from({ length: contacts }, (_, i) => chat(i));
  for (const row of rows) await db.putLink(row);
  const relays = { down: false, limiting: false, gets: [] as number[] };
  const { dht, gets } = fakeDht();
  const transport = new RelaysAndDht(dht, { relays: RELAYS, fetch: relayStub(relays), log: () => {} }, true);
  node = new GhostlyNode({ onState: () => {}, onMessages: () => {}, onCallSignal: () => {} }, {
    transport, automaticWallets: false, nativeTransports: {}, singleDevice: true, staysOnline: true, watchPeerIdleMs: DAEMON_WATCH_PEER_IDLE_MS,
  });
  const t0 = Date.now();
  await node.start();
  return { rows, relays, gets, t0, node };
}

describe("background DHT reads while every relay fails", { timeout: 120_000 }, () => {
  it("50 contacts, relays failing for 60 minutes: at most the relays' background share a minute, flat; back to the relays after", async () => {
    const { rows, relays, gets, t0, node } = await daemon(50);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    relays.down = true;
    for (let m = 2; m < 62; m++) await vi.advanceTimersByTimeAsync(MIN);
    const lookups = perMinute(gets.map((g) => g.at), t0, 3, 62);
    // Before: 200 a minute, flat for the hour (about 11,700 in all).
    expect(Math.max(...lookups)).toBeLessThanOrEqual(BOUND);
    // Flat: the last ten minutes look up as much as the first ten (a budget, not a slow drift down or up).
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(lookups.slice(-10))).toBeGreaterThan(avg(lookups.slice(0, 10)) * 0.75);
    expect(avg(lookups.slice(-10))).toBeLessThan(avg(lookups.slice(0, 10)) * 1.25);
    // Every contact is still looked up within the outage's last ten minutes: in its turn, none left out.
    const late = new Set(gets.filter((g) => g.at - t0 >= 52 * MIN).map((g) => g.key));
    for (const row of rows) expect(late.has(row.peerPubKeyZ32)).toBe(true);

    // The relays still down, a chat is opened: its contact is read on the DHT within seconds, its turn there or not.
    const opened = Date.now();
    node.setActiveLink({ linkId: rows[7]!.id });
    await vi.advanceTimersByTimeAsync(5_000);
    const first = gets.find((g) => g.key === rows[7]!.peerPubKeyZ32 && g.at >= opened);
    expect(first && first.at - opened).toBeLessThan(5_000);

    // The relays are back: reads go to them again, the DHT is left alone.
    relays.down = false;
    node.setActiveLink({ linkId: null });
    await vi.advanceTimersByTimeAsync(MIN - 5_000);
    for (let m = 63; m < 70; m++) await vi.advanceTimersByTimeAsync(MIN);
    const after = perMinute(gets.map((g) => g.at), t0, 66, 70);
    expect(Math.max(...after)).toBe(0);
    expect(perMinute(relays.gets, t0, 66, 70).every((n) => n > 0)).toBe(true);
  });

  it("50 contacts, relays answering 429 for 10 minutes: read on the DHT at the relays' share; back to the relays after", async () => {
    const { rows, relays, gets, t0 } = await daemon(50);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    relays.limiting = true;
    for (let m = 2; m < 12; m++) await vi.advanceTimersByTimeAsync(MIN);
    // Before: no lookup at all, and no contact read anywhere for the 10 minutes (3 relay GETs, each one a 429).
    const lookups = perMinute(gets.map((g) => g.at), t0, 3, 12);
    expect(Math.max(...lookups)).toBeLessThanOrEqual(BOUND);
    const read = new Set(gets.filter((g) => g.at - t0 >= 3 * MIN).map((g) => g.key));
    for (const row of rows) expect(read.has(row.peerPubKeyZ32)).toBe(true);
    // The relays still asked only as often as their 429s let them be.
    expect(perMinute(relays.gets, t0, 3, 12).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(9);

    relays.limiting = false;
    for (let m = 12; m < 18; m++) await vi.advanceTimersByTimeAsync(MIN);
    expect(Math.max(...perMinute(gets.map((g) => g.at), t0, 15, 18))).toBe(0);
    expect(perMinute(relays.gets, t0, 15, 18).every((n) => n > 0)).toBe(true);
  });

  it("300 contacts, relays failing for 30 minutes: bounded the same", async () => {
    const { relays, gets, t0 } = await daemon(300);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    relays.down = true;
    for (let m = 2; m < 32; m++) await vi.advanceTimersByTimeAsync(MIN);
    const lookups = perMinute(gets.map((g) => g.at), t0, 3, 32);
    // Before: 1,200 a minute.
    expect(Math.max(...lookups)).toBeLessThanOrEqual(BOUND);
  });
});

describe("DhtBackgroundBudget and the reads someone waits on", () => {
  it("a read someone waits on goes to the DHT at once while the background ones wait their turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const relays = { down: true, gets: [] as number[] };
    const { dht, gets } = fakeDht();
    const transport = new RelaysAndDht(dht, { relays: RELAYS, fetch: relayStub(relays), log: () => {}, breaker: { threshold: 1 } }, true);
    // The relays fail until the breaker leaves them alone.
    const probe = createIdentity().pubKeyZ32;
    for (let i = 0; i < 6 && !transport.relays.discovery().relays.every((r) => r.state === "failing"); i++) {
      const read = transport.resolve(probe, {}).catch(() => null);
      await vi.advanceTimersByTimeAsync(2_000); await read;
    }
    expect(transport.relays.discovery().relays.every((r) => r.state === "failing")).toBe(true);
    // 60 contacts read in the background at once: the share goes, the rest are held back with a wait.
    const keys = Array.from({ length: 60 }, () => createIdentity().pubKeyZ32);
    const before = gets.length;
    const outcomes = keys.map((key) => transport.resolve(key, { background: true }, false).then(() => "read", (e: unknown) => (isDiscoveryBudgetError(e) && e.retryInMs > 0 ? "held" : String(e))));
    await vi.advanceTimersByTimeAsync(2_000);
    const settled = await Promise.all(outcomes);
    expect(gets.length - before).toBe(BOUND);
    expect(settled.filter((o) => o === "held")).toHaveLength(60 - BOUND);
    // One read again soon after its own: held, its turn not come.
    await expect(transport.resolve(keys[0]!, { background: true }, false)).rejects.toSatisfy(isDiscoveryBudgetError);
    // Reads someone waits on go now: a chat's (not background), a signal due, an urgent one.
    for (const options of [{}, { background: true, signal: true }, { background: true, urgent: true }]) {
      const n = gets.length;
      const read = transport.resolve(keys[1]!, options, false);
      await vi.advanceTimersByTimeAsync(1_600);
      await expect(read).resolves.toBeNull();
      expect(gets.length).toBe(n + 1);
    }
  });

  it("each key in its turn: n keys share the minute's lookups", () => {
    const budget = new DhtBackgroundBudget(() => 40);
    const keys = Array.from({ length: 300 }, (_, i) => `k${i}`);
    const looked = new Map<string, number>();
    let lookups = 0;
    // Every key asks every 15 s for 20 minutes.
    for (let t = 0; t < 20 * MIN; t += 15_000) for (const key of keys) if (budget.take(key, t) === 0) { lookups++; looked.set(key, (looked.get(key) ?? 0) + 1); }
    expect(lookups).toBeLessThanOrEqual(40 * 20);
    expect(lookups).toBeGreaterThan(40 * 20 * 0.8);
    // Each of the 300 was looked up, about as often as the others.
    expect(looked.size).toBe(300);
    expect(Math.max(...looked.values()) - Math.min(...looked.values())).toBeLessThanOrEqual(2);
  });
});
