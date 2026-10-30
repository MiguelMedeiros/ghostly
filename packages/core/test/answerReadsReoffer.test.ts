import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { createLink } from "../src/invite";
import { LinkSession, RELAY_POLL_INTERVALS } from "../src/link";
import { RelayTransport } from "../src/relay";

// covers: core.relay-client

/**
 * The matrix's extension chat leaving DHT only (E2E full, 2026-10-30): B, back from Offline, had spent its relay minute
 * catching up. It answered A's offer, A's attempt ended before it read that answer, and A offered again at once. B's
 * reads after its answer were plain chat reads the minute held back, so it never read the new offer: it answered the old
 * one again twice, and the chat stayed "On DHT · retrying live" for the test's 45 s.
 */

const NOW = 1_800_000_000_000;
const RELAYS = ["https://a.test"];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => void vi.useRealTimers());

describe("relay transport: an answerer whose minute is spent", () => {
  it("reads the offer that replaces the one it answered within seconds", async () => {
    const stored = new Map<string, Uint8Array>();
    const relayFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = new URL(String(input)).pathname.slice(1);
      if (init?.method === "PUT") { stored.set(key, new Uint8Array(init.body as ArrayBuffer)); return new Response(null, { status: 204 }); }
      const body = stored.get(key);
      return body ? new Response(body as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
    }) as typeof fetch;
    const { mine, invite } = createLink();
    const signals: string[] = [];
    const relay = new RelayTransport({ freshReadMs: 0, relays: RELAYS, log: () => {}, fetch: relayFetch });
    const b = new LinkSession({ params: mine, transport: relay, pollIntervals: RELAY_POLL_INTERVALS, getServices: () => [],
      events: { onRtcSignal: (signal) => signals.push(signal) } });
    const a = new LinkSession({ params: invite, transport: new RelayTransport({ requestsPerMinute: Infinity, relays: RELAYS, log: () => {}, fetch: relayFetch }),
      pollIntervals: RELAY_POLL_INTERVALS, getServices: () => [] });
    a.start();
    b.start();
    try {
      a.setFastPoll(true, true);
      await a.setRtcSignal("offer 1");
      b.setActive(true);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(signals).toEqual(["offer 1"]);
      // The rest of B's minute goes on what an app back online catches up with.
      const other = createIdentity();
      for (let i = 0; i < 40; i++) await relay.publish(other, [{ label: "_x", value: `${i}` }]).catch(() => {});
      b.setFastPoll(true);
      await b.setRtcSignal("answer 1");
      await vi.advanceTimersByTimeAsync(2_000);
      // A's attempt ended before it read the answer: it offers again at once.
      await a.setRtcSignal("offer 2");
      await vi.advanceTimersByTimeAsync(6_000);
      expect(signals).toEqual(["offer 1", "offer 2"]);
    } finally {
      await a.stop(false);
      await b.stop(false);
    }
  });
});
