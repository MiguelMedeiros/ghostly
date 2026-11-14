import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BREAKER_THRESHOLD, DiscoveryBudgetError, HEDGE_MISSING_MS, HEDGE_MS, RelayTransport, SLOW_DEMOTE_MS, SLOW_MS, createIdentity, createRelayPayload } from "../src";
// covers: core.relay-client, core.relay-breaker

/**
 * Hedged reads: a read asks the next relay too once the first has not answered within `HEDGE_MS`, takes the first good
 * answer, drops the other request, and starts later reads with the faster relay. A relay slow `BREAKER_THRESHOLD`
 * times in a row trips its breaker. The relays here are fakes on fake timers: one answers at once, one after 8 s.
 */
interface Behaviour { delayMs: number; status?: 200 | 404; refused?: boolean }

describe("hedged relay reads", () => {
  const ids = new Map<string, ReturnType<typeof createIdentity>>();
  /** A key a relay holds a packet of. */
  const newKey = () => { const who = createIdentity(); ids.set(who.pubKeyZ32, who); return who.pubKeyZ32; };
  const id = { pubKeyZ32: newKey() };
  const packetOf = (key: string) => createRelayPayload(ids.get(key)!, [{ label: "_ts", value: "1" }], 1_000n);

  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); });
  afterEach(() => { vi.useRealTimers(); });

  function relays(behaviour: Record<string, Behaviour>, options: { requestsPerMinute?: number } = {}) {
    const calls: string[] = [], dropped: string[] = [], logs: string[] = [];
    const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const url = new URL(String(input)), host = url.host, key = url.pathname.slice(1);
      calls.push(host);
      const b = behaviour[host];
      if (b.refused) { reject(new TypeError("fetch failed: connection refused")); return; }
      // A PUT is always taken; `status` is what a GET finds.
      const timer = setTimeout(() => resolve(init?.method === "PUT" || (b.status ?? 200) === 200 ? new Response(packetOf(key) as BodyInit) : new Response(null, { status: 404 })), b.delayMs);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); dropped.push(host); reject(new DOMException("The operation was aborted", "AbortError")); });
    })) as typeof fetch;
    const transport = new RelayTransport({
      freshReadMs: 0, relays: Object.keys(behaviour).map((h) => `https://${h}`), fetch: fetchFn, log: (line) => logs.push(line), ...options,
    });
    return { transport, calls, dropped, logs, behaviour };
  }

  /** Resolves `read`, advancing fake time in small steps; how long it took, in fake ms. */
  async function timed<T>(read: () => Promise<T>): Promise<{ ms: number; value: T }> {
    const start = Date.now();
    let settled = false;
    const pending = read().finally(() => { settled = true; });
    pending.catch(() => {});
    while (!settled) await vi.advanceTimersByTimeAsync(10);
    return { ms: Date.now() - start, value: await pending };
  }

  it("a read takes the fast relay's answer about the hedge delay after asking a slow one, not 8 s later", async () => {
    const { transport, calls, dropped } = relays({ "slow.test": { delayMs: 8_000 }, "fast.test": { delayMs: 50 } });
    const { ms, value } = await timed(() => transport.resolve(id.pubKeyZ32));
    expect(value?.timestampMicros).toBe(1_000n);
    expect(calls).toEqual(["slow.test", "fast.test"]);
    expect(ms).toBeGreaterThanOrEqual(HEDGE_MS);
    expect(ms).toBeLessThan(HEDGE_MS + 200);
    // The slow relay's request is dropped, not left to run to its end.
    expect(dropped).toEqual(["slow.test"]);
  });

  it("a relay that lost the hedge goes to the back: the next reads start with the fast relay", async () => {
    const { transport, calls } = relays({ "slow.test": { delayMs: 8_000 }, "fast.test": { delayMs: 50 } });
    await timed(() => transport.resolve(id.pubKeyZ32));
    calls.length = 0;
    // The key's turn and the next keys' turns would start at slow.test half of the time.
    for (const key of [id.pubKeyZ32, newKey(), newKey(), newKey()]) {
      const { ms } = await timed(() => transport.resolve(key));
      expect(ms).toBeLessThan(200);
    }
    expect(calls).toEqual(["fast.test", "fast.test", "fast.test", "fast.test"]);
    expect(transport.discovery().relays.map((r) => r.state)).toEqual(["ok", "ok"]);
  });

  it("is back in turn once its slow mark lapses, or once it answers fast", async () => {
    const r = relays({ "slow.test": { delayMs: 8_000 }, "fast.test": { delayMs: 50 } });
    await timed(() => r.transport.resolve(id.pubKeyZ32));
    r.behaviour["slow.test"].delayMs = 50;
    await vi.advanceTimersByTimeAsync(SLOW_DEMOTE_MS);
    r.calls.length = 0;
    // The key's last read was answered by fast.test: its next one starts at slow.test again.
    await timed(() => r.transport.resolve(id.pubKeyZ32));
    expect(r.calls).toEqual(["slow.test"]);
  });

  it(`a relay slow ${BREAKER_THRESHOLD} times in a row trips its breaker, and the log says slow`, async () => {
    const { transport, calls, logs } = relays({ "slow.test": { delayMs: 8_000 }, "fast.test": { delayMs: 50 } });
    for (let i = 0; i < BREAKER_THRESHOLD; i++) {
      // Each read of the key starts at the relay after the one that answered the last one: slow.test, once its slow mark lapsed.
      if (i > 0) await vi.advanceTimersByTimeAsync(SLOW_DEMOTE_MS);
      calls.length = 0;
      await timed(() => transport.resolve(id.pubKeyZ32));
      expect(calls).toEqual(["slow.test", "fast.test"]);
    }
    expect(logs).toEqual([expect.stringMatching(/^relay slow\.test answered too slowly; asked again in 60 s$/)]);
    const health = transport.discovery().relays.find((h) => h.relay === "https://slow.test");
    expect(health).toMatchObject({ state: "failing", reason: "slow" });
    // Left alone: a read asks the fast relay alone, with no hedge delay.
    calls.length = 0;
    const { ms } = await timed(() => transport.resolve(id.pubKeyZ32));
    expect(calls).toEqual(["fast.test"]);
    expect(ms).toBeLessThan(200);
  });

  it("a packet slower than SLOW_MS is slow, yet one relay alone never trips for it: a slow answer beats none", async () => {
    const alone = relays({ "slow.test": { delayMs: SLOW_MS + 1_000 } });
    for (let i = 0; i < BREAKER_THRESHOLD + 1; i++) expect((await timed(() => alone.transport.resolve(id.pubKeyZ32))).value?.timestampMicros).toBe(1_000n);
    expect(alone.logs).toEqual([]);
    expect(alone.transport.discovery().relays[0].state).toBe("ok");
  });

  it("a relay that refuses the connection is replaced at once, with no hedge delay", async () => {
    const { transport, calls } = relays({ "down.test": { delayMs: 0, refused: true }, "fast.test": { delayMs: 50 } });
    const { ms, value } = await timed(() => transport.resolve(id.pubKeyZ32));
    expect(value?.timestampMicros).toBe(1_000n);
    expect(calls).toEqual(["down.test", "fast.test"]);
    expect(ms).toBeLessThan(200);
  });

  it("a key nobody published hedges late: a relay takes seconds to say 404, and polls of it cost one request", async () => {
    const { transport, calls, logs } = relays({ "a.test": { delayMs: 3_500, status: 404 }, "b.test": { delayMs: 3_500, status: 404 } });
    // The first read does not know the key is missing: it hedges at HEDGE_MS, and the first 404 is the answer.
    expect((await timed(() => transport.resolve(id.pubKeyZ32))).value).toBeNull();
    expect(calls).toEqual(["a.test", "b.test"]);
    calls.length = 0;
    // The next reads know: a relay has HEDGE_MISSING_MS to say so alone.
    for (let i = 0; i < 4; i++) {
      const { ms, value } = await timed(() => transport.resolve(id.pubKeyZ32));
      expect(value).toBeNull();
      expect(ms).toBeLessThan(HEDGE_MISSING_MS);
    }
    expect(calls).toEqual(["b.test", "a.test", "b.test", "a.test"]);
    // A slow 404 is no sign of a slow relay.
    expect(logs).toEqual([]);
  });

  it("a relay still silent when the other said 404 past the missing-key hedge is slow: later reads of the key do not wait for it", async () => {
    // A blackholed relay (it takes the connection, never answers) and one that says 404 at once: a key nobody published yet.
    const { transport, calls, logs } = relays({ "dead.test": { delayMs: 1e9 }, "up.test": { delayMs: 50, status: 404 } });
    const times: number[] = [];
    for (let i = 0; i < 8; i++) {
      times.push((await timed(() => transport.resolve(id.pubKeyZ32))).ms);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    // The first read hedges at HEDGE_MS, the second (the key known missing) at HEDGE_MISSING_MS; then the silent relay
    // goes after the other one, not first in every read of the key for good, 6 s each.
    expect(times.slice(2).every((ms) => ms < 200)).toBe(true);
    expect(calls.filter((host) => host === "dead.test")).toHaveLength(2);
    expect(logs).toEqual([]);
  });

  it("a relay that has not answered a request of this client for HEDGE_MS goes after the others: a missing key's next read does not wait HEDGE_MISSING_MS on it", async () => {
    // silent.test takes connections and never answers (each request runs to the 10 s timeout).
    const r = relays({ "fast.test": { delayMs: 50, status: 404 }, "silent.test": { delayMs: 60_000 } });
    const key = newKey();
    // A fresh client's first read of a key nobody published yet: fast.test's turn, a 404.
    expect((await timed(() => r.transport.resolve(key))).value).toBeNull();
    // Its own packet goes out: fast.test takes it, silent.test's PUT hangs.
    const own = createIdentity();
    ids.set(own.pubKeyZ32, own);
    await timed(() => r.transport.publish(own, [{ label: "_ts", value: "1" }]));
    await vi.advanceTimersByTimeAsync(2_000);
    // The key is published meanwhile. Its next read's turn is silent.test's, and the key was missing last time.
    r.behaviour["fast.test"].status = 200;
    r.calls.length = 0;
    const { ms, value } = await timed(() => r.transport.resolve(key));
    expect(value?.timestampMicros).toBe(1_000n);
    expect(ms).toBeLessThan(200);
    expect(r.calls).toEqual(["fast.test"]);
  });

  it("a relay that has a request waiting is in turn again once it answers one", async () => {
    const r = relays({ "fast.test": { delayMs: 50 }, "late.test": { delayMs: 3_000 } });
    const own = createIdentity();
    ids.set(own.pubKeyZ32, own);
    await timed(() => r.transport.publish(own, [{ label: "_ts", value: "1" }]));
    // late.test's PUT is answered at 3 s: from then on it is a relay that answers, and takes its turns.
    await vi.advanceTimersByTimeAsync(3_000);
    r.behaviour["late.test"].delayMs = 50;
    r.calls.length = 0;
    for (const k of [newKey(), newKey()]) await timed(() => r.transport.resolve(k));
    expect([...r.calls].sort()).toEqual(["fast.test", "late.test"]);
  });

  it("a background read never hedges: nobody waits on it", async () => {
    const { transport, calls } = relays({ "slow.test": { delayMs: 8_000 }, "fast.test": { delayMs: 50 } });
    const { ms } = await timed(() => transport.resolve(id.pubKeyZ32, { background: true }));
    expect(calls).toEqual(["slow.test"]);
    expect(ms).toBeGreaterThanOrEqual(8_000);
  });

  it("a hedge is counted in the relay's budget, the dropped request too, and is not sent once the relay has only its reserve left", async () => {
    // A minute of 3 on each relay: groups leave a chat 1 of them (`reserveOf`), so a hedge goes while 2 are left.
    const r = relays({ "a.test": { delayMs: 50 }, "b.test": { delayMs: 50 } }, { requestsPerMinute: 3 });
    const spent = (host: string) => ((r.transport as unknown as { spent: Map<string, number[]> }).spent.get(`https://${host}`) ?? []).length;
    // a.test slow, the first read hedges to b.test: one request on each, the dropped one counted as well.
    r.behaviour["a.test"].delayMs = 8_000;
    await timed(() => r.transport.resolve(id.pubKeyZ32));
    expect(r.calls).toEqual(["a.test", "b.test"]);
    expect([spent("a.test"), spent("b.test")]).toEqual([1, 1]);
    // Both slow now. The next read starts at b.test (a.test is marked slow), and a.test, with 1 of its 3 spent, has room
    // for a hedge: it goes, and is counted.
    r.behaviour["b.test"].delayMs = 8_000;
    r.calls.length = 0;
    await timed(() => r.transport.resolve(newKey()));
    expect(r.calls).toEqual(["b.test", "a.test"]);
    expect([spent("a.test"), spent("b.test")]).toEqual([2, 2]);
    // Now each has 2 of 3: the last one is kept for a pairing, so a read asks one relay and waits for it.
    r.calls.length = 0;
    const { ms } = await timed(() => r.transport.resolve(newKey()));
    expect(r.calls).toHaveLength(1);
    expect(ms).toBeGreaterThanOrEqual(8_000);
    expect([spent("a.test"), spent("b.test")].sort()).toEqual([2, 3]);
  });

  it("a read the budget holds back on every relay is still a wait (DiscoveryBudgetError), hedges or not", async () => {
    const r = relays({ "a.test": { delayMs: 50 }, "b.test": { delayMs: 50 } }, { requestsPerMinute: 2 });
    for (let i = 0; i < 4; i++) await timed(() => r.transport.resolve(newKey()));
    await expect(timed(() => r.transport.resolve(newKey()))).rejects.toBeInstanceOf(DiscoveryBudgetError);
  });
});
