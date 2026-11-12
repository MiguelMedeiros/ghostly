import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { RelayTransport } from "../src/relay";
import { isDiscoveryBudgetError } from "../src/transport";
// covers: core.relay-client

/**
 * The request budget counts each request by when it went, on the device's clock. After that clock was set back (an NTP
 * step, a clock that ran ahead fixed by hand), every request dated before the step was "in the last minute" until the
 * clock passed it again: the budget stayed spent for as long as the clock went back, and an hour back held every
 * background read for 59 minutes. A request dated after now counts as just made, at most.
 */
const NOW = 1_800_000_000_000;
const MIN = 60_000;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

/** One relay that has no packet for anyone; its reads counted. */
function transport() {
  const gets: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") gets.push(new URL(String(input)).pathname.slice(1));
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { relays: new RelayTransport({ relays: ["https://a.test"], fetch: fetchFn, log: () => {} }), gets };
}

const read = (relays: RelayTransport, key: string) =>
  relays.resolve(key, { background: true }, false).then(() => ({ held: 0 }), (e: unknown) => {
    if (isDiscoveryBudgetError(e)) return { held: e.retryInMs };
    throw e;
  });

describe("the relay budget after the device clock is set back", () => {
  it.each([["not set back", 0], ["set back a minute", MIN], ["set back an hour", 60 * MIN]])("background share spent, clock %s: a background read two minutes later goes", async (_, back) => {
    const { relays, gets } = transport();
    // The background share of the minute, spent.
    for (let i = 0; i < 20; i++) await read(relays, createIdentity().pubKeyZ32);
    expect(gets).toHaveLength(20);
    expect((await read(relays, createIdentity().pubKeyZ32)).held).toBeGreaterThan(0);
    vi.setSystemTime(Date.now() - back);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    // Before: held 59 minutes after an hour back. The minute's requests count as made when the step is first seen, at
    // most: here two minutes after it, with no request in between.
    const key = createIdentity().pubKeyZ32;
    const { held } = await read(relays, key);
    expect(held).toBeLessThanOrEqual(back ? MIN : 0);
    await vi.advanceTimersByTimeAsync(held);
    expect(await read(relays, key)).toEqual({ held: 0 });
    expect(gets.at(-1)).toBe(key);
  });

  it("set back an hour, a request seen in between: a background read two minutes later goes at once", async () => {
    const { relays, gets } = transport();
    for (let i = 0; i < 20; i++) await read(relays, createIdentity().pubKeyZ32);
    vi.setSystemTime(Date.now() - 60 * MIN);
    // A daemon asks all the time: a read held just after the step.
    expect((await read(relays, createIdentity().pubKeyZ32)).held).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    const key = createIdentity().pubKeyZ32;
    // Before: held 59 minutes.
    expect(await read(relays, key)).toEqual({ held: 0 });
    expect(gets.at(-1)).toBe(key);
  });

  it("set back an hour just after the share was spent: held at most the minute, not the hour", async () => {
    const { relays } = transport();
    for (let i = 0; i < 20; i++) await read(relays, createIdentity().pubKeyZ32);
    vi.setSystemTime(Date.now() - 60 * MIN);
    const { held } = await read(relays, createIdentity().pubKeyZ32);
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThanOrEqual(MIN);
  });

  it("a key read just before the step is read again, not taken from the copy for the hour", async () => {
    const { relays, gets } = transport();
    const key = createIdentity().pubKeyZ32;
    await read(relays, key);
    vi.setSystemTime(Date.now() - 60 * MIN);
    await vi.advanceTimersByTimeAsync(5_000);
    await read(relays, key);
    expect(gets.filter((k) => k === key)).toHaveLength(2);
  });
});
