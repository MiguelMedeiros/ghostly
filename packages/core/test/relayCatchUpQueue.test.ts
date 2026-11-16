import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, type Identity } from "../src/identity";
import { openRelayPayload } from "../src/pkarr";
import { RelayTransport } from "../src/relay";
import { isDiscoveryBudgetError } from "../src/transport";

// covers: core.relay-client

/**
 * The packets a relay's budget held back while another path took them (`catchUpLater`): each relay gets the newest of a
 * key once it frees a request, and other background writes wait behind them.
 */

const NOW = 1_800_000_000_000;
const A = "https://a.test";
/** A relay with a share of its own: 5 requests a minute (`RELAY_REQUESTS_PER_MINUTE`). */
const SMALL = "https://relay.pkarr.org";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => void vi.useRealTimers());

/** Relays that take every packet and log each PUT; `slow` holds the answer to a key's next PUT on a relay. */
function relays() {
  const puts: { relay: string; key: string; body: Uint8Array }[] = [];
  const slow = new Map<string, number>();
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), key = url.pathname.slice(1), slot = `${url.origin} ${key}`;
    if (init?.method !== "PUT") return new Response(null, { status: 404 });
    const delay = slow.get(slot);
    slow.delete(slot);
    if (delay) await new Promise((r) => setTimeout(r, delay));
    puts.push({ relay: url.origin, key, body: new Uint8Array(init.body as ArrayBuffer) });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const last = (relay: string, key: string) => puts.filter((p) => p.relay === relay && p.key === key).pop();
  const seq = (relay: string, key: string) => openRelayPayload(key, last(relay, key)!.body).seq;
  return { puts, slow, fetch: fetchFn, last, seq };
}

const publish = (relay: RelayTransport, id: Identity, value: string, background = false) =>
  relay.publish(id, [{ label: "_x", value }], { background }).catch((error: unknown) => error);

describe("relay transport: packets queued for a relay", () => {
  it("a newer packet queued while the relay was slow to take an older one still goes there", async () => {
    const r = relays();
    const relay = new RelayTransport({ relays: [A, SMALL], fetch: r.fetch, log: () => {} });
    // Four of the small relay's five requests this minute.
    for (let i = 0; i < 4; i++) await publish(relay, createIdentity(), "other");
    const k = createIdentity();
    // P2: the small relay takes its last request, and answers 5 s late; the publish is out on a.test.
    r.slow.set(`${SMALL} ${k.pubKeyZ32}`, 5_000);
    await publish(relay, k, "p2");
    // P3: a.test takes it, the small relay's budget holds it: queued for it.
    await publish(relay, k, "p3");
    await vi.advanceTimersByTimeAsync(180_000);
    // Before: P2's late answer dropped the queued P3, and the small relay kept P2.
    expect(r.seq(SMALL, k.pubKeyZ32)).toBe(r.seq(A, k.pubKeyZ32));
  });

  it("a newer background packet the budget held on every relay takes the older one's place in the queue", async () => {
    const r = relays();
    const relay = new RelayTransport({ relays: [A, SMALL], fetch: r.fetch, log: () => {} });
    // The small relay's minute spent.
    for (let i = 0; i < 5; i++) await publish(relay, createIdentity(), "other");
    const k = createIdentity();
    // P1: a.test takes it, the small relay queues it.
    await publish(relay, k, "p1", true);
    // a.test's share of background writes spent (10 a minute): P2 is held there too.
    for (let i = 0; i < 9; i++) await publish(relay, createIdentity(), "upkeep", true);
    // P2, signed a second later elsewhere (the CLI's DHT took it), put on the relays in the background.
    await vi.advanceTimersByTimeAsync(1_000);
    const signed = relays();
    await publish(new RelayTransport({ relays: ["https://signer.test"], fetch: signed.fetch, log: () => {}, requestsPerMinute: Infinity }), k, "p2");
    const p2 = signed.puts[0]!.body;
    const held = await relay.publishPayload(k.pubKeyZ32, p2, { background: true }).catch((error: unknown) => error);
    expect(isDiscoveryBudgetError(held)).toBe(true);
    await vi.advanceTimersByTimeAsync(180_000);
    // The small relay got P2. Before: P1 (or nothing, when the newer packet dropped the queued one).
    expect(r.seq(SMALL, k.pubKeyZ32)).toBe(openRelayPayload(k.pubKeyZ32, p2).seq);
    expect(r.seq(SMALL, k.pubKeyZ32)).toBeGreaterThan(r.seq(A, k.pubKeyZ32));
  });

  it("another background write waits behind the queue, told a minute at most, and goes once it drained", async () => {
    const r = relays();
    // Payloads signed elsewhere (the CLI's DHT took them): queued for a.test (`putLater`).
    const signed = relays();
    const signer = new RelayTransport({ relays: ["https://signer.test"], fetch: signed.fetch, log: () => {}, requestsPerMinute: Infinity });
    const queued = Array.from({ length: 20 }, () => createIdentity());
    for (const id of queued) await publish(signer, id, "upkeep");
    const relay = new RelayTransport({ relays: [A], fetch: r.fetch, log: () => {} });
    for (const p of signed.puts) relay.putLater(p.key, p.body, undefined, { background: true });
    const y = createIdentity();
    const held = await publish(relay, y, "upkeep", true);
    // Before: it went at once, ahead of the 20 packets waiting.
    expect(isDiscoveryBudgetError(held)).toBe(true);
    expect((held as { retryInMs: number }).retryInMs).toBeLessThanOrEqual(60_000);
    expect(r.puts).toEqual([]);
    // The queue drains at the background writes' share (10 a minute), then the write goes.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(new Set(r.puts.map((p) => p.key))).toEqual(new Set(queued.map((id) => id.pubKeyZ32)));
    expect(await publish(relay, y, "upkeep", true)).toBeUndefined();
    expect(r.last(A, y.pubKeyZ32)).toBeDefined();
  });
});
