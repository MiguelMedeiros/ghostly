import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { createLink } from "../src/invite";
import { LinkSession, RELAY_POLL_INTERVALS } from "../src/link";
import { RelayTransport } from "../src/relay";

// covers: core.relay-client

/**
 * A CLI daemon back after a restart, its 30 contacts online (CLI bug hunt, 2026-10-13): its chats' and groups' writes,
 * which go first, filled the relays' minute, and the few reads left went to the chats in an attempt, which read for the
 * answer to their offer. The others' reads, at the fast pace as at the background one, were answered from the packet
 * read before for 10 minutes: a quarter of the chats stayed down with their contacts online and offering.
 */

const NOW = 1_800_000_000_000;
const RELAYS = ["https://a.test", "https://b.test"];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => void vi.useRealTimers());

describe("relay transport: chats read their contacts in turn at every pace", () => {
  it("reads every chat's contact about once a minute while writes fill the minute and some chats signal", async () => {
    const reads = new Map<string, number[]>(), stored = new Map<string, Uint8Array>();
    const fetchFor = (counted: boolean) => (async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = new URL(String(input)).pathname.slice(1);
      if (init?.method === "PUT") { stored.set(key, new Uint8Array(init.body as ArrayBuffer)); return new Response(null, { status: 204 }); }
      if (counted) reads.set(key, [...(reads.get(key) ?? []), Date.now()]);
      const body = stored.get(key);
      return body ? new Response(body as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
    }) as typeof fetch;
    const relay = new RelayTransport({ freshReadMs: 0, relays: RELAYS, log: () => {}, fetch: fetchFor(true) });
    const links: LinkSession[] = [], contacts: LinkSession[] = [], keys: string[] = [];
    const CHATS = 12, SIGNALING = 4;
    for (let i = 0; i < CHATS; i++) {
      const { mine, invite } = createLink();
      contacts.push(new LinkSession({ params: invite, transport: new RelayTransport({ requestsPerMinute: Infinity, relays: RELAYS, log: () => {}, fetch: fetchFor(false) }), pollIntervals: RELAY_POLL_INTERVALS, getServices: () => [] }));
      keys.push(mine.peerPubKeyZ32);
      links.push(new LinkSession({ params: mine, transport: relay, pollIntervals: RELAY_POLL_INTERVALS, getServices: () => [] }));
    }
    for (const contact of contacts) contact.start();
    await vi.advanceTimersByTimeAsync(5_000);
    // Every chat is in an attempt now and then (an offer out, its answer looked for fast); the first ones all the time.
    let round = 0;
    const attempt = () => {
      round++;
      links.forEach((link, i) => {
        if (i >= SIGNALING && (round + i) % 4) return;
        link.setFastPoll(true, true);
        void link.setRtcSignal(`offer ${round} ${i}`);
      });
    };
    // Other chats' writes, which go first, keep the minute nearly full.
    const writers = Array.from({ length: 4 }, () => createIdentity());
    let w = 0;
    const writes = setInterval(() => void relay.publish(writers[w++ % writers.length], [{ label: "_x", value: `${w}` }]).catch(() => {}), 2_000);
    for (const link of links) link.start();
    attempt();
    const attempts = setInterval(attempt, 30_000);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      reads.clear();
      const start = Date.now(), minutes = 6;
      await vi.advanceTimersByTimeAsync(minutes * 60_000);
      const gaps = keys.map((key) => {
        const at = [start, ...(reads.get(key) ?? []), start + minutes * 60_000];
        return Math.max(...at.slice(1).map((t, i) => t - at[i]));
      });
      // About a minute at most between two reads of a contact. Before, the chats in an attempt took the reads that freed,
      // and the others waited up to 2 minutes.
      expect(Math.max(...gaps)).toBeLessThan(90_000);
    } finally {
      clearInterval(attempts);
      clearInterval(writes);
      for (const link of [...links, ...contacts]) await link.stop(false);
    }
  }, 120_000);
});
