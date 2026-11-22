import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEDGE_MS, REQUESTS_PER_MINUTE, RelayTransport, SLOW_MS, createIdentity, createRelayPayload, withRequestOptions } from "../src";

// covers: core.relay-client

/**
 * A relay taken off the list (`setRelays`) while a read or a publish that started before is still out: it is asked
 * nothing more, neither a read's hedge or failover, a chat's copy waiting for the first relay's answer, a 412's retry,
 * nor a 409's read of what it holds. A request already sent finishes: the relay has it already.
 */

const A = "https://a.test", B = "https://b.test";

/** Fake relays: `delay` holds an answer, `status` gives a PUT's (by host), `fail` makes a host's requests fail. */
function fakeRelays() {
  const log: { host: string; method: string; key: string; at: number; ifMatch?: string }[] = [];
  const delay = new Map<string, number>(), status = new Map<string, number[]>(), fail = new Set<string>();
  const owner = new Map<string, ReturnType<typeof createIdentity>>();
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), host = url.host, key = url.pathname.slice(1), method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    log.push({ host, method, key, at: Date.now(), ifMatch: headers.get("If-Match") ?? undefined });
    const ms = delay.get(`${method} ${host}`) ?? 0;
    if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
    if (fail.has(host)) throw new TypeError("fetch failed");
    if (method === "PUT") return new Response(null, { status: status.get(host)?.shift() ?? 204 });
    const who = owner.get(key);
    return who ? new Response(createRelayPayload(who, [{ label: "_ts", value: "1" }], 1_000n) as BodyInit) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const after = (host: string, at: number) => log.filter((r) => r.host === host && r.at >= at);
  return { log, delay, status, fail, owner, fetch: fetchFn, after };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); });
afterEach(() => { vi.useRealTimers(); });

describe("relay transport: a relay taken off the list gets nothing more of a request that started before", () => {
  it("a read's hedge does not go to a relay removed since the read began", async () => {
    const r = fakeRelays();
    const who = createIdentity();
    r.owner.set(who.pubKeyZ32, who);
    r.delay.set("GET a.test", 8_000);
    const relay = new RelayTransport({ freshReadMs: 0, relays: [A, B], fetch: r.fetch, log: () => {} });
    const read = relay.resolve(who.pubKeyZ32);
    read.catch(() => {});
    await vi.advanceTimersByTimeAsync(500);
    expect(r.log.map((x) => x.host)).toEqual(["a.test"]);
    relay.setRelays([A]);
    await vi.advanceTimersByTimeAsync(HEDGE_MS + 500);
    // Before: the hedge sent `GET b.test/<key>` at 1.5 s.
    expect(r.after("b.test", 0)).toEqual([]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect((await read)?.timestampMicros).toBe(1_000n);
  });

  it("a failed read is not replaced by a relay removed since the read began", async () => {
    const r = fakeRelays();
    const who = createIdentity();
    r.owner.set(who.pubKeyZ32, who);
    r.delay.set("GET a.test", 1_000);
    r.fail.add("a.test");
    const relay = new RelayTransport({ freshReadMs: 0, hedgeMs: Infinity, relays: [A, B], fetch: r.fetch, log: () => {} });
    const read = relay.resolve(who.pubKeyZ32).then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    relay.setRelays([A]);
    await vi.advanceTimersByTimeAsync(2_000);
    // Before: a.test's failure at 1 s sent `GET b.test/<key>` in its place.
    expect(r.after("b.test", 0)).toEqual([]);
    expect(await read).toBeInstanceOf(Error);
  });

  it("a chat's copy waiting for the first relay's answer does not go to a relay removed meanwhile", async () => {
    const r = fakeRelays();
    const me = createIdentity();
    const relay = new RelayTransport({ freshReadMs: 0, relays: [A, B], fetch: r.fetch, log: () => {} });
    // Four chats look fast for their contacts; the groups' writes spend both relays up to what the chats keep.
    for (let i = 0; i < 4; i++) await relay.resolve(createIdentity().pubKeyZ32, { urgent: true });
    const group = withRequestOptions(relay, { group: true });
    for (let i = 0; i < REQUESTS_PER_MINUTE; i++) await group.publish(createIdentity(), [{ label: "_ts", value: "1" }]).catch(() => {});
    // a.test takes the chat's packet and says so late: the copy for b.test waits up to SLOW_MS.
    r.delay.set("PUT a.test", 9_000);
    const published = relay.publish(me, [{ label: "_ts", value: "1" }], { signal: true });
    await vi.advanceTimersByTimeAsync(1_000);
    relay.setRelays([A]);
    await vi.advanceTimersByTimeAsync(SLOW_MS + 9_000);
    await published;
    // Before: `PUT b.test/<key>` at SLOW_MS, a packet that relay never had.
    expect(r.log.filter((x) => x.host === "b.test" && x.key === me.pubKeyZ32)).toEqual([]);
  });

  it("a 412 answered after the relay was removed is not put there again", async () => {
    const r = fakeRelays();
    const me = createIdentity();
    const relay = new RelayTransport({ freshReadMs: 0, relays: [A, B], fetch: r.fetch, log: () => {} });
    await relay.publish(me, [{ label: "_ts", value: "1" }]);
    // The next put names the packet it replaces; a.test never got it, and says so 2 s on.
    r.status.set("a.test", [412]);
    r.delay.set("PUT a.test", 2_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const at = Date.now();
    const published = relay.publish(me, [{ label: "_ts", value: "2" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    relay.setRelays([B]);
    await vi.advanceTimersByTimeAsync(5_000);
    await published;
    // Only the put sent before the removal. Before: the 412 was put there again, with no `If-Match`.
    expect(r.after("a.test", at).map((x) => x.method)).toEqual(["PUT"]);
  });

  it("a 409 answered after the relay was removed does not read that relay", async () => {
    const r = fakeRelays();
    const me = createIdentity();
    const relay = new RelayTransport({ freshReadMs: 0, relays: [A, B], fetch: r.fetch, log: () => {} });
    r.status.set("a.test", [409]);
    r.delay.set("PUT a.test", 2_000);
    const published = relay.publish(me, [{ label: "_ts", value: "1" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    relay.setRelays([B]);
    await vi.advanceTimersByTimeAsync(5_000);
    await published;
    // Before: `GET a.test/<key>`, to date past what it holds.
    expect(r.after("a.test", 0).map((x) => x.method)).toEqual(["PUT"]);
  });
});
