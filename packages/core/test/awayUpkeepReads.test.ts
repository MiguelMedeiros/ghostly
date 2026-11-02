import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { createLink } from "../src/invite";
import { DhtDelivery } from "../src/dhtDelivery";
import { LinkSession, RELAY_POLL_INTERVALS } from "../src/link";
import { DEFAULT_RELAYS, RelayTransport } from "../src/relay";

// covers: core.relay-client, chat.dht.delivery

/**
 * A profile with many saved chats whose contacts are away, left idle (bug hunt, 2026-11-01): per chat, the link's
 * heartbeat and the DHT floor's keep-alive every 4 minutes. The keep-alive of a chat that is not live was a chat's
 * write, which goes first once refused (`WRITE_FIRST_MS`), and the heartbeats spent the background share: on one relay
 * at 200 chats the app read 0 to 5 contacts a minute and most were not read once in minutes 5 to 30; on the default
 * relays a contact went unread for 22 minutes.
 */

const NOW = 1_800_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => void vi.useRealTimers());

/**
 * The longest time each contact's link key went unread from minute 5 to 30 of an idle run with `chats` chats whose
 * contacts are away, and the PUTs a minute.
 */
async function idle(chats: number, relays: string[]): Promise<{ gaps: number[]; putsPerMinute: number }> {
  const minutes = 30;
  const reads = new Map<string, number[]>(), stored = new Map<string, Uint8Array>();
  let puts = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = new URL(String(input)).pathname.slice(1);
    if (init?.method === "PUT") { puts++; stored.set(key, new Uint8Array(init.body as ArrayBuffer)); return new Response(null, { status: 204 }); }
    reads.set(key, [...(reads.get(key) ?? []), Date.now()]);
    const body = stored.get(key);
    return body ? new Response(body as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const relay = new RelayTransport({ freshReadMs: 0, relays, log: () => {}, fetch: fetchFn });
  const links: LinkSession[] = [], floors: DhtDelivery[] = [], contacts: string[] = [];
  for (let i = 0; i < chats; i++) {
    const { mine, invite } = createLink();
    // Each contact was there once and went away: its last packet stays on the relays, long past its presence window.
    const contact = new LinkSession({ params: invite, transport: new RelayTransport({ relays, requestsPerMinute: Infinity, log: () => {}, fetch: fetchFn }), pollIntervals: RELAY_POLL_INTERVALS, getServices: () => [] });
    contact.start();
    await vi.advanceTimersByTimeAsync(0);
    await contact.stop(true);
    contacts.push(mine.peerPubKeyZ32);
    // A saved chat as the engine runs it: its link, and its DHT floor (the contact's mailbox, empty).
    links.push(new LinkSession({ params: mine, transport: relay, pollIntervals: RELAY_POLL_INTERVALS, getServices: () => [{ id: "chat", type: "chat" }] }));
    floors.push(new DhtDelivery({ params: mine, mode: "stream", credentials: { seedB64: createIdentity().seedB64, peerKey: createIdentity().pubKeyZ32 }, transport: relay,
      save: async () => {}, pin: async () => {}, message: async () => {}, receipt: async () => {}, changed: () => {} }));
  }
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  try {
    for (const link of links) link.start();
    for (const floor of floors) void floor.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    reads.clear(); puts = 0;
    const from = Date.now();
    await vi.advanceTimersByTimeAsync((minutes - 5) * 60_000);
    const gaps = contacts.map((key) => {
      const at = [from, ...(reads.get(key) ?? []), Date.now()];
      return Math.max(...at.slice(1).map((t, i) => t - at[i]));
    });
    return { gaps, putsPerMinute: puts / (minutes - 5) };
  } finally {
    for (const link of links) await link.stop();
    for (const floor of floors) await floor.stop();
  }
}

const minutes = (ms: number) => Math.round(ms / 6_000) / 10;
const summary = ({ gaps, putsPerMinute }: { gaps: number[]; putsPerMinute: number }) => {
  const sorted = [...gaps].sort((a, b) => a - b);
  return `longest gap median ${minutes(sorted[sorted.length >> 1])} min, max ${minutes(sorted[sorted.length - 1])} min, ${putsPerMinute} PUTs/min`;
};

describe("relay transport: the upkeep of chats whose contacts are away leaves room for reads", () => {
  it("reads each of 200 away contacts every few minutes on the default relays, the upkeep still going out", async () => {
    const run = await idle(200, DEFAULT_RELAYS);
    // Before: median 15 min, max 17 min, 73 PUTs a minute (every relay together). After: 5 min for every contact.
    expect(minutes(Math.max(...run.gaps)), summary(run)).toBeLessThanOrEqual(6);
    expect(run.putsPerMinute, "the upkeep still goes").toBeGreaterThan(10);
  }, 600_000);

  it("reads every one of 200 away contacts on one relay", async () => {
    const run = await idle(200, ["https://a.test"]);
    // Before: median 21 min, and contacts not read once in the 25 minutes. One relay's share reads the 400 keys (each
    // chat's link and its DHT floor) in turn, about 20 a minute: 20 min for every contact.
    expect(minutes(Math.max(...run.gaps)), summary(run)).toBeLessThanOrEqual(21);
    expect(run.putsPerMinute, "the upkeep still goes").toBeGreaterThan(5);
  }, 600_000);
});
