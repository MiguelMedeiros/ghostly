import { describe, expect, it, vi } from "vitest";
import { publishFailure } from "../src/ghostlink";
import { BREAKER_ALL_DOWN_PROBE_MS, BREAKER_BASE_MS, BREAKER_MAX_MS, BREAKER_THRESHOLD, DEFAULT_RELAYS, PREVIOUS_DEFAULT_RELAYS, RELAY_REQUESTS_PER_MINUTE, REQUESTS_PER_MINUTE, RelayBreaker, RelayTransport, createIdentity, createRelayPayload, currentRelays } from "../src";
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

  it("with every relay left alone for failing, one is asked anyway every 15 s; not while one is fine or throttled", () => {
    const { breaker, advance } = clocked();
    const trip = (relay: string, kind: "error" | "throttled" = "error") => { for (let i = 0; i < BREAKER_THRESHOLD; i++) breaker.failure(relay, kind, "HTTP 500"); };
    trip("a");
    expect(breaker.allDownProbe(["a", "b"])).toBeNull();
    trip("b");
    advance(1_000);
    // Not the moment they failed…
    expect(breaker.allDownProbe(["a", "b"])).toBeNull();
    advance(BREAKER_ALL_DOWN_PROBE_MS - 1_000);
    // …but both out for a minute: "a" (tripped first, its wait ends first) is asked 15 s on, not a minute on.
    expect(breaker.allDownProbe(["a", "b"])).toBe("a");
    breaker.beginAllDown("a");
    expect(breaker.allDownProbe(["a", "b"])).toBeNull();
    breaker.failure("a", "error", "HTTP 500");
    advance(BREAKER_ALL_DOWN_PROBE_MS - 1);
    expect(breaker.allDownProbe(["a", "b"])).toBeNull();
    advance(1);
    // "a" failed its probe and waits two minutes now; "b" is next.
    expect(breaker.allDownProbe(["a", "b"])).toBe("b");
    breaker.beginAllDown("b");
    breaker.success("b");
    expect(breaker.blockedFor("b")).toBe(0);
    advance(BREAKER_ALL_DOWN_PROBE_MS);
    expect(breaker.allDownProbe(["a", "b"])).toBeNull();
    // A relay throttling us is a wait for its rate limit, not an outage: no probe ahead of it.
    trip("b", "throttled");
    expect(breaker.allDownProbe(["a", "b"])).toBeNull();
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
    const relay = new RelayTransport({ freshReadMs: 0, relays: Object.keys(handlers).map((h) => `https://${h}`), fetch: fetchFn, requestsPerMinute: Infinity, log: (line) => log.push(line) });
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
      // Its only relay out for 15 s: asked anyway (it fails, and trips again), then left alone for the next 15 s.
      calls.length = 0;
      await expect(relay.resolve(id.pubKeyZ32)).rejects.toThrow();
      expect(calls).toEqual(["GET flaky.test"]);
      calls.length = 0;
      await expect(relay.resolve(id.pubKeyZ32)).rejects.toThrow();
      expect(calls).toEqual([]);
      vi.advanceTimersByTime(15_000);
      up = true;
      expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(1000n);
      expect(calls).toEqual(["GET flaky.test"]);
      expect(relay.discovery()).toEqual({ path: { via: "relay", relay: "https://flaky.test" }, relays: [{ relay: "https://flaky.test", state: "ok" }] });
      expect(log.at(-1)).toBe("flaky.test answered again");
      expect(recovered.mock.calls.map(([change]) => change)).toEqual(["tripped", "tripped", "recovered"]);
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
  it("every relay answering 500: one probe every 15 s, and the links hear when one answers again", async () => {
    vi.useFakeTimers();
    try {
      let up = false;
      const changes: string[] = [];
      const answer = () => up ? new Response(packet(2000n) as BodyInit) : new Response("down", { status: 500 });
      const { relay, calls } = transport({ "a.test": answer, "b.test": answer });
      relay.subscribe((change) => changes.push(change ?? ""));
      for (let i = 0; i < 8; i++) { await relay.resolve(id.pubKeyZ32).catch(() => {}); vi.advanceTimersByTime(21_000); }
      expect(relay.discovery().relays.map((r) => r.state)).toEqual(["failing", "failing"]);
      // Two minutes of polls every 2 s while both are out: one request every 15 s, not one per poll, and not none for minutes.
      calls.length = 0;
      for (let i = 0; i < 60; i++) { await relay.resolve(id.pubKeyZ32).catch(() => {}); vi.advanceTimersByTime(2_000); }
      expect(calls.length).toBeGreaterThanOrEqual(7);
      expect(calls.length).toBeLessThanOrEqual(9);
      up = true;
      changes.length = 0;
      let seen = null;
      for (let i = 0; i < 8 && !seen; i++) { seen = await relay.resolve(id.pubKeyZ32).catch(() => null); if (!seen || seen.timestampMicros !== 2000n) seen = null; vi.advanceTimersByTime(2_000); }
      expect(seen).not.toBeNull();
      expect(changes).toContain("recovered");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the default relays", () => {
  it("a profile still on an old default list gets today's; one of its own keeps it", () => {
    PREVIOUS_DEFAULT_RELAYS.push(["https://pkarr.pubky.org"]);
    try {
      expect(currentRelays(["https://pkarr.pubky.org"])).toEqual(DEFAULT_RELAYS);
      expect(currentRelays(["https://pkarr.pubky.app"])).toEqual(["https://pkarr.pubky.app"]);
      expect(currentRelays(["https://relay.example.org", "https://pkarr.pubky.org"])).toEqual(["https://relay.example.org", "https://pkarr.pubky.org"]);
      expect(currentRelays(DEFAULT_RELAYS)).toEqual(DEFAULT_RELAYS);
    } finally {
      PREVIOUS_DEFAULT_RELAYS.pop();
    }
  });

  it("relay.pkarr.org, added by hand, allows 10 requests a minute and gets 5 of ours", async () => {
    const calls: string[] = [];
    const id = createIdentity();
    const relay = new RelayTransport({
      freshReadMs: 0,
      relays: ["https://relay.pkarr.org"],
      fetch: (async (input: RequestInfo | URL) => { calls.push(String(input)); return new Response("", { status: 404 }); }) as typeof fetch,
    });
    for (let i = 0; i < 5; i++) await relay.resolve(id.pubKeyZ32);
    await expect(relay.resolve(id.pubKeyZ32)).rejects.toMatchObject({ code: "discovery-budget" });
    expect(calls).toHaveLength(5);
  });

  it("pkarr.pubky.app, which allows 1000 requests a minute, gets 60 of ours, and pkarr.pubky.org the default 30", async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).host}`);
      return new Response(null, { status: init?.method === "PUT" ? 204 : 404 });
    }) as typeof fetch;
    const relay = new RelayTransport({ relays: DEFAULT_RELAYS, fetch: fetchFn });
    // Reads go to a relay with requests left: pkarr.pubky.org's 30, then the rest of pkarr.pubky.app's 60.
    for (let i = 0; i < REQUESTS_PER_MINUTE + RELAY_REQUESTS_PER_MINUTE["https://pkarr.pubky.app"] - 1; i++) await relay.resolve(createIdentity().pubKeyZ32);
    expect(calls.filter(c => c === "GET pkarr.pubky.org")).toHaveLength(REQUESTS_PER_MINUTE);
    expect(calls.filter(c => c === "GET pkarr.pubky.app")).toHaveLength(59);
    // A write with pkarr.pubky.org's minute spent goes out on pkarr.pubky.app: a pairing's answer does not wait.
    await relay.publish(createIdentity(), [{ label: "_ts", value: "1" }]);
    expect(calls.at(-1)).toBe("PUT pkarr.pubky.app");
    await expect(relay.resolve(createIdentity().pubKeyZ32)).rejects.toMatchObject({ code: "discovery-budget" });
    // A budget given by hand (a test's, a relay of one's own) still bounds a relay with its own share.
    const bounded = new RelayTransport({ relays: ["https://pkarr.pubky.app"], fetch: fetchFn, requestsPerMinute: 10 });
    calls.length = 0;
    for (let i = 0; i < 11; i++) await bounded.resolve(createIdentity().pubKeyZ32).catch(() => {});
    expect(calls).toHaveLength(10);
  });
});

describe("when publishing fails, and a new network", () => {
  it("says the transport's reason, a string included, and the soonest a relay is asked again", () => {
    expect(publishFailure(new Error("Publish failed on every relay: Error: https://a.test is left alone after failing; asked again in 12 s; Error: https://b.test is left alone after failing; asked again in 7 s")))
      .toBe("Could not publish connection details: Publish failed on every relay: Error: https://a.test is left alone after failing; Error: https://b.test is left alone after failing. Retrying in 7 s.");
    // The Desktop's Rust client rejects with a string.
    expect(publishFailure("Publish error: pkarr.pubky.org: left alone after failing; asked again in 9 s; dht: DHT query timed out"))
      .toBe("Could not publish connection details: Publish error: pkarr.pubky.org: left alone after failing; dht: DHT query timed out. Retrying in 9 s.");
    expect(publishFailure(undefined)).toBe("Could not publish connection details: discovery unavailable. Retrying.");
  });

  it("a publish while every relay is left alone says when one is asked again; a new network asks them all at once", async () => {
    vi.useFakeTimers();
    try {
      let up = false;
      const puts: string[] = [];
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") puts.push(new URL(String(input)).host);
        return up ? new Response(null, { status: 204 }) : new Response("down", { status: 500 });
      }) as typeof fetch;
      const relay = new RelayTransport({ relays: ["https://a.test", "https://b.test"], fetch: fetchFn, requestsPerMinute: Infinity, log: () => {} });
      const changes: string[] = [];
      relay.subscribe((change) => changes.push(change ?? ""));
      const id = createIdentity();
      for (let i = 0; i < 3; i++) await relay.publish(id, []).catch(() => {});
      const error = await relay.publish(id, []).then(() => null, (e: Error) => e.message);
      expect(error).toMatch(/left alone after failing; asked again in 15 s/);
      up = true;
      puts.length = 0;
      relay.networkChanged();
      expect(changes.at(-1)).toBe("recovered");
      await relay.publish(id, []);
      await vi.advanceTimersByTimeAsync(0);
      expect(new Set(puts)).toEqual(new Set(["a.test", "b.test"]));
    } finally {
      vi.useRealTimers();
    }
  });
});
