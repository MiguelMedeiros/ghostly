import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CarriedTransport, HEDGE_MS, RelayTransport, createIdentity, createRelayPayload, withRequestOptions, type PkarrRequestOptions } from "../src";
// covers: core.relay-client, groups.protocol.signals

/**
 * A group edge's first read of its member after it started (again), which its offer waits on (`resume`), asks every
 * relay with a request to spare at once, and takes the newest packet any of them holds. One that stopped at the first
 * relay to answer took the older packet a relay still served (it refused the member's newest put with a 409, or its
 * budget held the put back for later), or its 404, and the edge waited a whole poll for the next read to land on the
 * other relay. The relays here are fakes on fake timers.
 */
interface Behaviour { delayMs: number; at?: bigint }

const RESUME: PkarrRequestOptions = { group: true, resume: true };

describe("a group edge started again reads its member's newest packet from every relay", () => {
  const ids = new Map<string, ReturnType<typeof createIdentity>>();
  const newKey = () => { const who = createIdentity(); ids.set(who.pubKeyZ32, who); return who.pubKeyZ32; };

  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); });
  afterEach(() => { vi.useRealTimers(); });

  function relays(behaviour: Record<string, Behaviour>, options: { requestsPerMinute?: number } = {}) {
    const calls: string[] = [];
    const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const url = new URL(String(input)), host = url.host, key = url.pathname.slice(1);
      calls.push(host);
      const { delayMs, at } = behaviour[host];
      const timer = setTimeout(() => resolve(at === undefined ? new Response(null, { status: 404 })
        : new Response(createRelayPayload(ids.get(key)!, [{ label: "_ts", value: String(at) }], at) as BodyInit)), delayMs);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("The operation was aborted", "AbortError")); });
    })) as typeof fetch;
    const transport = new RelayTransport({ freshReadMs: 0, relays: Object.keys(behaviour).map((h) => `https://${h}`), fetch: fetchFn, log: () => {}, ...options });
    return { transport, calls, behaviour };
  }

  async function timed<T>(read: () => Promise<T>): Promise<{ ms: number; value: T }> {
    const start = Date.now();
    let settled = false;
    const pending = read().finally(() => { settled = true; });
    pending.catch(() => {});
    while (!settled) await vi.advanceTimersByTimeAsync(10);
    return { ms: Date.now() - start, value: await pending };
  }

  it("two relays, one holding an older packet: every read takes the newer one, whichever relay its turn starts at", async () => {
    const { transport, calls } = relays({ "old.test": { delayMs: 50, at: 1_000n }, "new.test": { delayMs: 80, at: 2_000n } });
    // Several keys: the relays' turn starts at each relay in turn.
    for (const key of [newKey(), newKey(), newKey(), newKey()]) {
      calls.length = 0;
      const { ms, value } = await timed(() => transport.resolve(key, RESUME));
      expect(value?.timestampMicros).toBe(2_000n);
      expect(calls.sort()).toEqual(["new.test", "old.test"]);
      expect(ms).toBeLessThan(200);
    }
  });

  it("a relay that never got the packet (404) does not hide the one another relay holds", async () => {
    const { transport } = relays({ "none.test": { delayMs: 50 }, "has.test": { delayMs: 80, at: 2_000n } });
    for (const key of [newKey(), newKey()]) {
      expect((await timed(() => transport.resolve(key, RESUME))).value?.timestampMicros).toBe(2_000n);
    }
  });

  it("does not wait on a slow relay past the hedge delay once another one answered", async () => {
    const { transport } = relays({ "fast.test": { delayMs: 50, at: 1_000n }, "slow.test": { delayMs: 8_000, at: 2_000n } });
    const { ms, value } = await timed(() => transport.resolve(newKey(), RESUME));
    expect(value?.timestampMicros).toBe(1_000n);
    expect(ms).toBeLessThan(HEDGE_MS + 200);
  });

  it("a relay seconds slow to say 404, dropped once another answered with the packet, is not taken for a slow one", async () => {
    const { transport } = relays({ "none.test": { delayMs: 3_500 }, "has.test": { delayMs: 50, at: 2_000n } });
    for (let i = 0; i < 4; i++) expect((await timed(() => transport.resolve(newKey(), RESUME))).value?.timestampMicros).toBe(2_000n);
    expect(transport.discovery().relays.map((r) => r.state)).toEqual(["ok", "ok"]);
  });

  it("an edge's other reads (its reads for an answer too), and a 1:1 chat's first read back, still cost one request", async () => {
    const { transport, calls } = relays({ "a.test": { delayMs: 50, at: 1_000n }, "b.test": { delayMs: 50, at: 2_000n } });
    const others: PkarrRequestOptions[] = [{ group: true }, { group: true, urgent: true, signal: true }, { group: true, urgent: true, watch: true }, { group: true, background: true, resume: true }, { resume: true }];
    for (const options of others) {
      await timed(() => transport.resolve(newKey(), options));
    }
    expect(calls).toHaveLength(others.length);
  });

  it("an edge started again (its WebRTC gave up on a VPN: no `resume`) reads its member's newest offer first, then one relay in turn", async () => {
    const { transport, calls } = relays({ "old.test": { delayMs: 50, at: 1_000n }, "new.test": { delayMs: 80, at: 2_000n } });
    const group = withRequestOptions(transport, { group: true });
    const me = createIdentity(), member = newKey();
    const start = () => new CarriedTransport(group, me.pubKeyZ32, member, { carry: () => ({ taken: 0, sure: true }), open: () => false, look: () => {} });
    const edge = start();
    for (let run = 0; run < 2; run++) {
      const restarted = run === 0 ? edge : start();
      calls.length = 0;
      expect((await timed(() => restarted.resolve(member, { urgent: true }))).value?.timestampMicros).toBe(2_000n);
      expect(calls.sort()).toEqual(["new.test", "old.test"]);
      calls.length = 0;
      await timed(() => restarted.resolve(member, { urgent: true }));
      expect(calls).toHaveLength(1);
    }
  });

  it("the other relays are asked only with a request to spare: a relay left with the reserve kept for chats is not", async () => {
    // A minute of 3 on each relay: groups leave a chat 1 of them (`reserveOf`).
    const { transport, calls } = relays({ "a.test": { delayMs: 50, at: 1_000n }, "b.test": { delayMs: 50, at: 2_000n } }, { requestsPerMinute: 3 });
    await timed(() => transport.resolve(newKey(), RESUME));
    await timed(() => transport.resolve(newKey(), RESUME));
    expect(calls).toHaveLength(4);
    calls.length = 0;
    // Two of three spent on each: one relay is asked, as before.
    await timed(() => transport.resolve(newKey(), RESUME));
    expect(calls).toHaveLength(1);
  });
});
