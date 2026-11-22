import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { RelayTransport } from "../src/relay";
// covers: core.relay-client

/**
 * `RelayTransport.forget`: a key nothing will put or read any more (a spare invite replaced unused) leaves every map
 * the transport keeps per key, on every relay. Kept, an idle CLI daemon's maps grew by the spare invite's two keys
 * every 15 minutes, for as long as it ran.
 */
const RELAYS = ["https://a.test", "https://b.test"];

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.useRealTimers(); });

/** Relays that keep the last packet put under each key and answer reads with it; every PUT seen with its `If-Match`. */
function world() {
  const held = new Map<string, Uint8Array>();
  const puts: { relay: string; key: string; ifMatch: string | null }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), key = url.pathname.slice(1), slot = `${url.origin} ${key}`;
    if (init?.method === "PUT") {
      puts.push({ relay: url.origin, key, ifMatch: new Headers(init.headers).get("If-Match") });
      held.set(slot, new Uint8Array(init.body as Uint8Array));
      return new Response(null, { status: 204 });
    }
    const body = held.get(slot);
    return body ? new Response(body as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
  }) as typeof fetch;
  return { relays: new RelayTransport({ relays: RELAYS, fetch: fetchFn, log: () => {} }), puts };
}

/** The transport's per-key maps that never bound themselves, by name; `lastPut` is per relay and key (`${relay} ${key}`). */
const maps = (relays: RelayTransport) => relays as unknown as Record<"written" | "lastTimestamp" | "seenTimestamp" | "newest" | "lastPut", Map<string, unknown>>;
const perKey = ["written", "lastTimestamp", "seenTimestamp", "newest"] as const;
const slotsOf = (map: Map<string, unknown>, key: string) => [...map.keys()].filter((slot) => slot.endsWith(` ${key}`));

describe("RelayTransport.forget", () => {
  it("drops a key from every per-key map, on every relay, and leaves the other keys as they were", async () => {
    const { relays } = world();
    const gone = createIdentity(), kept = createIdentity();
    for (const identity of [gone, kept]) {
      await relays.publish(identity, [{ label: "_ts", value: "1" }]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await relays.resolve(identity.pubKeyZ32)).not.toBeNull();
    }
    await vi.advanceTimersByTimeAsync(1_000);
    const m = maps(relays);
    for (const name of perKey) expect([name, m[name].has(gone.pubKeyZ32)]).toEqual([name, true]);
    expect(slotsOf(m.lastPut, gone.pubKeyZ32)).toHaveLength(RELAYS.length);

    relays.forget([gone.pubKeyZ32]);

    for (const name of perKey) expect([name, m[name].has(gone.pubKeyZ32)]).toEqual([name, false]);
    expect(slotsOf(m.lastPut, gone.pubKeyZ32)).toEqual([]);
    // The other key keeps everything.
    for (const name of perKey) expect([name, m[name].has(kept.pubKeyZ32)]).toEqual([name, true]);
    expect(slotsOf(m.lastPut, kept.pubKeyZ32)).toHaveLength(RELAYS.length);
  });

  it("a key forgotten takes a later put as a key's first, and is read again", async () => {
    const { relays, puts } = world();
    const identity = createIdentity(), key = identity.pubKeyZ32;
    await relays.publish(identity, [{ label: "_ts", value: "1" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    await relays.publish(identity, [{ label: "_ts", value: "2" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    // The second put says which packet it replaces, on each relay.
    expect(puts.filter((p) => p.key === key).map((p) => p.ifMatch !== null)).toEqual([false, false, true, true]);

    relays.forget([key]);
    await vi.advanceTimersByTimeAsync(60_000);
    puts.length = 0;
    await relays.publish(identity, [{ label: "_ts", value: "3" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(puts.map((p) => [p.relay, p.ifMatch]).sort()).toEqual(RELAYS.map((relay) => [relay, null]));
    expect(maps(relays).written.has(key)).toBe(true);
    const packet = await relays.resolve(key);
    expect(packet?.records.find((r) => r.label === "_ts")?.value).toBe("3");
  });

  it("forgetting nothing, or a key never seen, changes nothing", async () => {
    const { relays } = world();
    const identity = createIdentity();
    await relays.publish(identity, [{ label: "_ts", value: "1" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    const sizes = () => Object.fromEntries((["written", "lastTimestamp", "lastPut"] as const).map((n) => [n, maps(relays)[n].size]));
    const before = sizes();
    relays.forget([]);
    relays.forget([createIdentity().pubKeyZ32]);
    expect(sizes()).toEqual(before);
  });
});
