import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_WATCH_PEER_IDLE_MS, createIdentity, type SignedPacket } from "@ghostly/core";
import { GhostlyNode } from "@ghostly/browser/engine/node";
import { db } from "@ghostly/browser/engine/db";
import { STORES, transact } from "@ghostly/browser/shared/idb";
import type { StoredLink } from "@ghostly/browser/shared/types";
import { RelaysAndDht, type Mainline } from "../src/runtime/mainline";
// covers: headless.daemon, chat.dht.delivery

/**
 * A daemon whose chats are on DHT only (this side's choice), every contact away, the relays up. Each such chat read its
 * contact's mailbox every 4 s whether or not the contact was there, as reads nobody marks background: the relays'
 * budget held most of them, and a held read that is not background goes to the Mainline DHT at once, with no budget.
 * 50 such chats made 1,081 DHT lookups a minute, flat for 24 h, where the same daemon with stream chats made 44 in the
 * whole day. A contact away is read at the background pace now, as background reads, which wait for the relays' share.
 *
 * An engine set up as the CLI's (`singleDevice`, `staysOnline`, `watchPeerIdleMs`), saved paired chats, two relays at
 * the default budget behind a `fetch` stub that has nothing for anyone, and a fake DHT node that counts its lookups.
 */

const MIN = 60_000;
const RELAYS = ["https://relay-one.test", "https://relay-two.test"];
/** The relays' background share on these two relays (`BACKGROUND_REQUESTS_PER_MINUTE` x 2). */
const BOUND = 40;

const chat = (i: number, deliveryMode: "dht" | "stream") => ({ id: `chat-${i}`, profile: "paired-chat/1", createdAt: 1, label: `c${i}`, seedB64: createIdentity().seedB64,
  encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64,
  pairedPeerKey: createIdentity().pubKeyZ32, peerTrust: { version: 1 }, ...(deliveryMode === "dht" && { deliveryMode }) }) as StoredLink;

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

/** Relays that have no packet for anyone (404); every read counted with its time and key. */
function relayStub(reads: { at: number; key: string }[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") reads.push({ at: Date.now(), key: String(input).split("/").pop()! });
    await new Promise((r) => setTimeout(r, 50));
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

/** A daemon with `contacts` chats on `deliveryMode`, every contact away, run for `minutes` simulated minutes. */
async function daemon(contacts: number, deliveryMode: "dht" | "stream", minutes: number) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.stubGlobal("RTCPeerConnection", undefined);
  await transact([STORES.links, STORES.messages], (s) => { s[STORES.links].clear(); s[STORES.messages].clear(); });
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  for (let i = 0; i < contacts; i++) await db.putLink(chat(i, deliveryMode));
  const reads: { at: number; key: string }[] = [];
  const { dht, gets } = fakeDht();
  const transport = new RelaysAndDht(dht, { relays: RELAYS, fetch: relayStub(reads), log: () => {} }, true);
  node = new GhostlyNode({ onState: () => {}, onMessages: () => {}, onCallSignal: () => {} }, {
    transport, automaticWallets: false, nativeTransports: {}, singleDevice: true, staysOnline: true, watchPeerIdleMs: DAEMON_WATCH_PEER_IDLE_MS,
  });
  const t0 = Date.now();
  await node.start();
  for (let m = 0; m < minutes; m++) await vi.advanceTimersByTimeAsync(MIN);
  return { reads, gets, t0 };
}

/**
 * The longest wait, past minute `from`, between two reads of a key read in that time (relays or DHT): how long a
 * contact's new envelope can sit in its mailbox before this side reads it.
 */
function longestGap(reads: { at: number; key: string }[], t0: number, from: number, to: number): number {
  const byKey = new Map<string, number[]>();
  for (const r of reads) if (r.at - t0 >= from * MIN && r.at - t0 < to * MIN) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r.at]);
  let longest = 0;
  for (const times of byKey.values()) {
    const all = [t0 + from * MIN, ...times.sort((a, b) => a - b), t0 + to * MIN];
    for (let i = 1; i < all.length; i++) longest = Math.max(longest, all[i]! - all[i - 1]!);
  }
  return longest;
}

describe("a daemon's DHT-only chats whose contacts are away, the relays up", { timeout: 240_000 }, () => {
  it("50 chats: DHT lookups within the relays' background share a minute, not ~1,081; each mailbox still read every minute or two", async () => {
    // Minutes 0-11: the contacts' last envelopes are older than `PRESENCE_WINDOW` from the start (nothing new read).
    const { reads, gets, t0 } = await daemon(50, "dht", 42);
    const lookups = perMinute(gets.map((g) => g.at), t0, 12, 42);
    const relayReads = perMinute(reads.map((r) => r.at), t0, 12, 42);
    const gap = longestGap([...reads, ...gets], t0, 12, 42);
    console.log(`dht-only x50: DHT lookups/min max ${Math.max(...lookups)} total ${lookups.reduce((a, b) => a + b, 0)} over 30 min; relay GET/min max ${Math.max(...relayReads)}; longest gap between reads of a key ${gap} ms`);
    // Before: 1,081 a minute, flat.
    expect(Math.max(...lookups)).toBeLessThanOrEqual(BOUND);
    // Every mailbox is still read, at the relays' background share: a contact coming back is read within this.
    expect(gap).toBeLessThanOrEqual(3 * MIN);
  });

  it("50 stream chats: as before, within the same share", async () => {
    const { gets, t0 } = await daemon(50, "stream", 42);
    const lookups = perMinute(gets.map((g) => g.at), t0, 12, 42);
    console.log(`stream x50: DHT lookups/min max ${Math.max(...lookups)} total ${lookups.reduce((a, b) => a + b, 0)} over 30 min`);
    expect(Math.max(...lookups)).toBeLessThanOrEqual(BOUND);
  });
});
