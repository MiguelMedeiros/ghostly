import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { RelayTransport } from "../src/relay";
import { DiscoveryBudgetError, isDiscoveryBudgetError } from "../src/transport";
// covers: core.relay-client

/**
 * What a request the relays' budget holds back costs. A daemon whose contacts are away asks thousands of times a
 * minute and is held nearly every time: each hold copied the minute's request lists twice each (`within`, about eight
 * lists per check) and captured a stack for its `DiscoveryBudgetError`, about a fifth of an idle 200-chat daemon's CPU.
 */
const NOW = 1_800_000_000_000;
const RELAY = "https://a.test";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

function transport() {
  const fetchFn = (async () => new Response(null, { status: 404 })) as typeof fetch;
  return new RelayTransport({ relays: [RELAY], fetch: fetchFn, log: () => {} });
}

const read = (relays: RelayTransport, key: string) =>
  relays.resolve(key, { background: true }, false).then(() => null, (e: unknown) => {
    if (isDiscoveryBudgetError(e)) return e;
    throw e;
  });

/** The relay's lists of the minute's requests, as the budget keeps them. */
const lists = (relays: RelayTransport) => {
  const own = relays as unknown as Record<string, Map<string, number[]>>;
  return ["spent", "spentBackground", "spentBackgroundWrites"].map((name) => own[name]!.get(RELAY));
};

describe("a request the relays' budget holds back", () => {
  it("keeps the minute's lists as they are when nothing in them aged out: no copy of each per check", async () => {
    const relays = transport();
    // The background share of the minute, spent.
    for (let i = 0; i < 20; i++) expect(await read(relays, createIdentity().pubKeyZ32)).toBeNull();
    expect(await read(relays, createIdentity().pubKeyZ32)).toBeInstanceOf(DiscoveryBudgetError);
    const before = lists(relays);
    expect(before[0]).toHaveLength(20);
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await read(relays, createIdentity().pubKeyZ32)).toBeInstanceOf(DiscoveryBudgetError);
    }
    // Before: a new copy of every list at each of the ten checks.
    lists(relays).forEach((list, i) => expect(list).toBe(before[i]));
    expect(lists(relays)[0]).toHaveLength(20);
  });

  it("still drops the requests that aged out, and counts one dated after now as just made", async () => {
    const relays = transport();
    for (let i = 0; i < 20; i++) await read(relays, createIdentity().pubKeyZ32);
    const before = lists(relays)[0];
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await read(relays, createIdentity().pubKeyZ32)).toBeNull();
    expect(lists(relays)[0]).not.toBe(before);
    expect(lists(relays)[0]).toHaveLength(1);
    // The clock set back an hour: the request just made counts as of now, and the share is not spent.
    vi.setSystemTime(Date.now() - 3_600_000);
    expect(await read(relays, createIdentity().pubKeyZ32)).toBeNull();
    expect(lists(relays)[0]).toEqual([Date.now(), Date.now()]);
  });

  it("is said by an error without a stack, and leaves the next errors theirs", async () => {
    const relays = transport();
    for (let i = 0; i < 20; i++) await read(relays, createIdentity().pubKeyZ32);
    const limit = Error.stackTraceLimit;
    const held = await read(relays, createIdentity().pubKeyZ32);
    expect(held).toBeInstanceOf(DiscoveryBudgetError);
    // Before: the frames of the read that was held, captured thousands of times a minute.
    expect(held!.stack).not.toMatch(/\n\s+at /);
    expect(held!.stack).toMatch(/^DiscoveryBudgetError: /);
    expect(held!.retryInMs).toBeGreaterThan(0);
    expect(held!.code).toBe("discovery-budget");
    expect(Error.stackTraceLimit).toBe(limit);
    expect(new Error("other").stack).toMatch(/\n\s+at /);
  });
});
