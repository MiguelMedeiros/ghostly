import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { createLink } from "../src/invite";
import { LinkSession, RELAY_POLL_INTERVALS } from "../src/link";
import { RelayTransport } from "../src/relay";
import { withRequestOptions } from "../src/transport";

// covers: core.relay-client

/**
 * A daemon with 30 chats and 5 groups, back after a restart (CLI bug hunt, 2026-10-12): its chats were not live yet and
 * read their contacts in the background, every 30 s, while its groups' edges signaled and held background requests to
 * a few a minute on each relay. A read the budget refused waited for the chat's next poll, and a request freed when the
 * one that took it aged out, at the poll after next of the chat that took it: the same chats took every request, and
 * a quarter of them read their contact once in 10 minutes.
 */

const NOW = 1_800_000_000_000;
const CHATS = 30, EDGES = 10;
const RELAYS = ["https://a.test", "https://b.test"];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => void vi.useRealTimers());

describe("relay transport: background reads take turns per key", () => {
  it("reads every one of 30 chats' contacts every few minutes while groups signal, none starved", async () => {
    const reads = new Map<string, number[]>(), stored = new Map<string, Uint8Array>();
    const relay = new RelayTransport({ freshReadMs: 0, relays: RELAYS, log: () => {}, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = new URL(String(input)).pathname.slice(1);
      if (init?.method === "PUT") { stored.set(key, new Uint8Array(init.body as ArrayBuffer)); return new Response(null, { status: 204 }); }
      reads.set(key, [...(reads.get(key) ?? []), Date.now()]);
      const body = stored.get(key);
      return body ? new Response(body as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
    }) as typeof fetch });
    const links: LinkSession[] = [], contacts: string[] = [];
    const group = withRequestOptions(relay, { group: true });
    for (let i = 0; i < CHATS + EDGES; i++) {
      const { mine, invite } = createLink();
      // Each contact was there once, and went away: its chat reads it in the background.
      const contact = new LinkSession({ params: invite, transport: new RelayTransport({ relays: RELAYS, log: () => {}, fetch: relay["fetchFn"] }), pollIntervals: RELAY_POLL_INTERVALS, getServices: () => [] });
      contact.start();
      await vi.advanceTimersByTimeAsync(0);
      await contact.stop(true);
      // The groups' edges to members that went away read them in the background too, in the groups' lane.
      if (i < CHATS) contacts.push(mine.peerPubKeyZ32);
      links.push(new LinkSession({ params: mine, transport: i < CHATS ? relay : group, pollIntervals: RELAY_POLL_INTERVALS }));
    }
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    reads.clear();
    // Links signal for the whole run, a fast read every 4 s, which keeps background requests at their floor: the groups'
    // edges re-offering, and a chat, for which groups leave the chats their reserve (`CHAT_RESERVE`).
    const member = createIdentity().pubKeyZ32, contact = createIdentity().pubKeyZ32;
    let turn = 0;
    const signaling = setInterval(() => void (turn++ % 2 ? group.resolve(member, { urgent: true }) : relay.resolve(contact, { urgent: true })).catch(() => {}), 2_000);
    try {
      const start = Date.now(), minutes = 10;
      for (const link of links) link.start();
      await vi.advanceTimersByTimeAsync(minutes * 60_000);
      // Background requests while a link signals: `BACKGROUND_WHILE_SIGNALING` a minute on each relay, 10 in all, so each
      // of the 40 keys read in the background is read about every 4 minutes. Before, 20 of the chats' contacts were read
      // once, as the chats started, and not again.
      const gaps = contacts.map((key) => {
        const at = [start, ...(reads.get(key) ?? []), start + minutes * 60_000];
        return Math.max(...at.slice(1).map((t, i) => t - at[i]));
      });
      expect(Math.max(...gaps)).toBeLessThan(5 * 60_000);
    } finally {
      clearInterval(signaling);
      for (const link of links) await link.stop();
    }
  });
});
