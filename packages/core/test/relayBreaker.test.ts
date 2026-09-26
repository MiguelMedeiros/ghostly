import { describe, expect, it, vi } from "vitest";
import { BREAKER_BASE_MS, BREAKER_MAX_MS, BREAKER_THRESHOLD, DEFAULT_RELAYS, RelayBreaker, RelayTransport, createIdentity, createRelayPayload, currentRelays } from "../src";
// covers: core.relay-breaker

describe("relay breaker", () => {
  function clocked() {
    let now = 1_000_000;
    const trips: string[] = [], recoveries: string[] = [];
    const breaker = new RelayBreaker({ now: () => now, onTrip: (relay, reason, forMs) => trips.push(`${relay} ${reason} ${forMs}`), onRecover: (relay) => recoveries.push(relay) });
    return { breaker, trips, recoveries, advance: (ms: number) => { now += ms; }, now: () => now };
  }

  it("trips after the threshold of failures in a row, and not before", () => {
    const { breaker, trips } = clocked();
    for (let i = 1; i < BREAKER_THRESHOLD; i++) breaker.failure("a", "error", "no answer");
    expect(breaker.blockedFor("a")).toBe(0);
    breaker.failure("a", "error", "no answer");
    expect(breaker.blockedFor("a")).toBe(BREAKER_BASE_MS);
    expect(trips).toEqual([`a no answer ${BREAKER_BASE_MS}`]);
  });

  it("an answer between failures starts the count again", () => {
    const { breaker } = clocked();
    breaker.failure("a", "error", "HTTP 502");
    breaker.failure("a", "error", "HTTP 502");
    breaker.success("a");
    breaker.failure("a", "error", "HTTP 502");
    breaker.failure("a", "error", "HTTP 502");
    expect(breaker.blockedFor("a")).toBe(0);
  });

  it("lets one probe through once the wait is over; an answer closes it", () => {
    const { breaker, advance, recoveries } = clocked();
    for (let i = 0; i < BREAKER_THRESHOLD; i++) breaker.failure("a", "throttled", "rate limited (429)");
    advance(BREAKER_BASE_MS - 1);
    expect(breaker.blockedFor("a")).toBe(1);
    advance(1);
    expect(breaker.blockedFor("a")).toBe(0);
    breaker.begin("a");
    // The probe is out: nothing else goes to the relay until it answers.
    expect(breaker.blockedFor("a")).toBeGreaterThan(0);
    breaker.success("a");
    expect(breaker.blockedFor("a")).toBe(0);
    expect(recoveries).toEqual(["a"]);
    expect(breaker.health(["a"])).toEqual([{ relay: "a", state: "ok" }]);
  });

  it("a failed probe trips it again at once, for twice as long, up to the cap", () => {
    const { breaker, advance, trips } = clocked();
    for (let i = 0; i < BREAKER_THRESHOLD; i++) breaker.failure("a", "error", "no answer");
    const waits = [BREAKER_BASE_MS];
    for (let i = 0; i < 5; i++) {
      advance(breaker.blockedFor("a"));
      breaker.begin("a");
      breaker.failure("a", "error", "no answer");
      waits.push(breaker.blockedFor("a"));
    }
    expect(waits).toEqual([BREAKER_BASE_MS, BREAKER_BASE_MS * 2, BREAKER_BASE_MS * 4, BREAKER_MAX_MS, BREAKER_MAX_MS, BREAKER_MAX_MS]);
    expect(trips).toHaveLength(6);
  });

  it("an answer after recovering resets the backoff", () => {
    const { breaker, advance } = clocked();
    for (let i = 0; i < BREAKER_THRESHOLD; i++) breaker.failure("a", "error", "no answer");
    advance(BREAKER_BASE_MS);
    breaker.begin("a");
    breaker.success("a");
    for (let i = 0; i < BREAKER_THRESHOLD; i++) breaker.failure("a", "error", "no answer");
    expect(breaker.blockedFor("a")).toBe(BREAKER_BASE_MS);
  });

  it("says each relay's health: throttled or failing, until when, and why", () => {
    const { breaker, now } = clocked();
    for (let i = 0; i < BREAKER_THRESHOLD; i++) breaker.failure("a", "throttled", "rate limited (429)");
    for (let i = 0; i < BREAKER_THRESHOLD; i++) breaker.failure("b", "error", "HTTP 503");
    breaker.failure("c", "error", "no answer");
    expect(breaker.health(["a", "b", "c"])).toEqual([
      { relay: "a", state: "throttled", until: now() + BREAKER_BASE_MS, reason: "rate limited (429)" },
      { relay: "b", state: "failing", until: now() + BREAKER_BASE_MS, reason: "HTTP 503" },
      { relay: "c", state: "ok" },
    ]);
  });
});

describe("relay transport with a breaker", () => {
  const id = createIdentity();
  const packet = (micros: bigint) => createRelayPayload(id, [{ label: "_ts", value: String(micros) }], micros);

  function transport(handlers: Record<string, () => Response | Promise<Response>>) {
    const calls: string[] = [], log: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const host = new URL(String(input)).host;
      calls.push(`${init?.method ?? "GET"} ${host}`);
      return handlers[host]();
    }) as typeof fetch;
    const relay = new RelayTransport({ relays: Object.keys(handlers).map((h) => `https://${h}`), fetch: fetchFn, requestsPerMinute: Infinity, log: (line) => log.push(line) });
    return { calls, log, relay };
  }

  it("a relay that keeps failing trips, the reads rotate among the others, and the trip is logged without keys", async () => {
    vi.useFakeTimers();
    try {
      const { relay, calls, log } = transport({
        "down.test": () => { throw new TypeError("Failed to fetch"); },
        "a.test": () => new Response(packet(1000n) as BodyInit),
        "b.test": () => new Response(packet(1000n) as BodyInit),
      });
      // The network cool-down of a relay that failed is short (20 s); the breaker keeps it out for a minute once it tripped.
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 3; i++) await relay.resolve(id.pubKeyZ32);
        vi.advanceTimersByTime(21_000);
      }
      expect(relay.discovery().relays[0]).toMatchObject({ relay: "https://down.test", state: "failing", reason: "no answer" });
      expect(log).toEqual(["down.test tripped (no answer); left alone for 60 s"]);
      expect(log.join()).not.toContain(id.pubKeyZ32);
      calls.length = 0;
      for (let i = 0; i < 6; i++) await relay.resolve(id.pubKeyZ32);
      expect(calls.filter((c) => c.includes("down.test"))).toEqual([]);
      expect(new Set(calls)).toEqual(new Set(["GET a.test", "GET b.test"]));
      expect(relay.discovery().path).toMatchObject({ via: "relay" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("probes a tripped relay once its wait is over and takes it back when it answers", async () => {
    vi.useFakeTimers();
    try {
      let up = false;
      const recovered = vi.fn();
      const { relay, calls, log } = transport({
        "flaky.test": () => up ? new Response(packet(1000n) as BodyInit) : new Response("", { status: 503 }),
      });
      relay.subscribe(recovered);
      for (let i = 0; i < 3; i++) {
        await expect(relay.resolve(id.pubKeyZ32)).rejects.toThrow("No Pkarr relay reachable");
        vi.advanceTimersByTime(21_000);
      }
      expect(recovered).toHaveBeenCalledTimes(1);
      calls.length = 0;
      await expect(relay.resolve(id.pubKeyZ32)).rejects.toThrow();
      expect(calls).toEqual([]);
      vi.advanceTimersByTime(60_000);
      up = true;
      expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(1000n);
      expect(calls).toEqual(["GET flaky.test"]);
      expect(relay.discovery()).toEqual({ path: { via: "relay", relay: "https://flaky.test" }, relays: [{ relay: "https://flaky.test", state: "ok" }] });
      expect(log.at(-1)).toBe("flaky.test answered again");
      expect(recovered).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a relay that throttles us trips as throttled: a wait for the budget, not an outage", async () => {
    vi.useFakeTimers();
    try {
      const { relay } = transport({ "busy.test": () => new Response("", { status: 429, headers: { "retry-after": "1" } }) });
      for (let i = 0; i < 3; i++) {
        await relay.resolve(id.pubKeyZ32).catch(() => {});
        vi.advanceTimersByTime(1_100);
      }
      expect(relay.discovery().relays[0]).toMatchObject({ state: "throttled", reason: "rate limited (429)" });
      await expect(relay.resolve(id.pubKeyZ32)).rejects.toMatchObject({ code: "discovery-budget" });
      await expect(relay.publish(id, [{ label: "_x", value: "1" }])).rejects.toMatchObject({ code: "discovery-budget" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a write still goes out on the healthy relays while one is tripped", async () => {
    vi.useFakeTimers();
    try {
      const { relay, calls } = transport({
        "down.test": () => new Response("", { status: 502 }),
        "a.test": () => new Response(null, { status: 204 }),
      });
      for (let i = 0; i < 3; i++) {
        await relay.publish(id, [{ label: "_x", value: String(i) }]);
        vi.advanceTimersByTime(1_000);
      }
      calls.length = 0;
      await relay.publish(id, [{ label: "_x", value: "last" }]);
      expect(calls).toEqual(["PUT a.test"]);
      expect(relay.discovery().relays.map((r) => r.state)).toEqual(["failing", "ok"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers the protocol expects (404, 409) keep a relay healthy", async () => {
    const { relay } = transport({ "a.test": () => new Response("", { status: 404 }) });
    for (let i = 0; i < 5; i++) expect(await relay.resolve(id.pubKeyZ32)).toBeNull();
    expect(relay.discovery().relays).toEqual([{ relay: "https://a.test", state: "ok" }]);
  });
});

describe("the default relays", () => {
  it("a profile still on an old default list gets today's; one of its own keeps it", () => {
    expect(currentRelays(["https://pkarr.pubky.org", "https://pkarr.pubky.app"])).toEqual(DEFAULT_RELAYS);
    expect(currentRelays(["https://pkarr.pubky.app"])).toEqual(["https://pkarr.pubky.app"]);
    expect(currentRelays(["https://relay.example.org", "https://pkarr.pubky.org"])).toEqual(["https://relay.example.org", "https://pkarr.pubky.org"]);
  });

  it("relay.pkarr.org, which allows 10 requests a minute, gets 5 of ours", async () => {
    const calls: string[] = [];
    const id = createIdentity();
    const relay = new RelayTransport({
      relays: ["https://relay.pkarr.org"],
      fetch: (async (input: RequestInfo | URL) => { calls.push(String(input)); return new Response("", { status: 404 }); }) as typeof fetch,
    });
    for (let i = 0; i < 5; i++) await relay.resolve(id.pubKeyZ32);
    await expect(relay.resolve(id.pubKeyZ32)).rejects.toMatchObject({ code: "discovery-budget" });
    expect(calls).toHaveLength(5);
  });
});
