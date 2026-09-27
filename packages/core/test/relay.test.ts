import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_REQUESTS_PER_MINUTE, CHAT_RESERVE, DiscoveryBudgetError, REQUESTS_PER_MINUTE, RelayTransport, WRITE_FIRST_MS, createIdentity, createRelayPayload, isDiscoveryBudgetError, withRequestOptions } from "../src";
// covers: core.relay-client

describe("relay transport", () => {
  const id = createIdentity();
  const packet = (micros: bigint) => createRelayPayload(id, [{ label: "_ts", value: String(micros) }], micros);

  function transport(handlers: Record<string, () => Response>) {
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const host = new URL(String(input)).host;
      calls.push(host);
      return handlers[host]();
    }) as typeof fetch;
    return { calls, relay: new RelayTransport({ relays: Object.keys(handlers).map((h) => `https://${h}`), fetch: fetchFn }) };
  }

  it("spends one request per poll, taking relays in turn, and keeps the newest packet", async () => {
    const { relay, calls } = transport({
      "a.test": () => new Response(packet(2000n) as BodyInit),
      "b.test": () => new Response(packet(1000n) as BodyInit),
    });
    expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(2000n);
    // b still serves an older cached copy; the newer one already seen wins
    expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(2000n);
    expect(calls).toEqual(["a.test", "b.test"]);
  });

  it("backs off from a relay that rate limits and uses the other one", async () => {
    const { relay, calls } = transport({
      "a.test": () => new Response(null, { status: 429, headers: { "retry-after": "30" } }),
      "b.test": () => new Response(packet(5n) as BodyInit),
    });
    expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(5n);
    await relay.resolve(id.pubKeyZ32);
    await relay.resolve(id.pubKeyZ32);
    expect(calls).toEqual(["a.test", "b.test", "b.test", "b.test"]);
  });

  it("reports nothing published, and fails only when no relay answers", async () => {
    const missing = transport({ "a.test": () => new Response(null, { status: 404 }) });
    expect(await missing.relay.resolve(id.pubKeyZ32)).toBeNull();

    const down = transport({ "a.test": () => new Response(null, { status: 502 }) });
    await expect(down.relay.resolve(id.pubKeyZ32)).rejects.toThrow("No Pkarr relay reachable");
  });

  it("ignores a packet with a bad signature", async () => {
    const forged = createRelayPayload(createIdentity(), [{ label: "_ts", value: "1" }]);
    const { relay } = transport({ "a.test": () => new Response(forged as BodyInit) });
    await expect(relay.resolve(id.pubKeyZ32)).rejects.toThrow();
  });
});

describe("relay transport under pressure", () => {
  const id = createIdentity();

  it("treats a network error like a rate limit and leaves that relay alone", async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const host = new URL(String(input)).host;
      calls.push(host);
      if (host === "a.test") throw new TypeError("Failed to fetch"); // a 429 without CORS headers looks like this
      return new Response(createRelayPayload(id, [{ label: "_ts", value: "1" }], 9n) as BodyInit);
    }) as typeof fetch;
    const relay = new RelayTransport({ relays: ["https://a.test", "https://b.test"], fetch: fetchFn });
    for (let i = 0; i < 4; i++) expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(9n);
    expect(calls.filter((h) => h === "a.test")).toHaveLength(1);
  });

  it("never spends more than its budget on a relay, and keeps answering from what it knows", async () => {
    let requests = 0;
    const fetchFn = (async () => {
      requests++;
      return new Response(createRelayPayload(id, [{ label: "_ts", value: "1" }], 3n) as BodyInit);
    }) as typeof fetch;
    const relay = new RelayTransport({ relays: ["https://a.test"], fetch: fetchFn });
    for (let i = 0; i < 100; i++) expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(3n);
    expect(requests).toBe(30);
  });

  it("spends only part of the budget on background requests, keeping the rest for the links", async () => {
    let requests = 0;
    const fetchFn = (async (_: RequestInfo | URL, init?: RequestInit) => {
      requests++;
      return init?.method === "PUT" ? new Response(null, { status: 204 }) : new Response(createRelayPayload(id, [{ label: "_ts", value: "1" }], 3n) as BodyInit);
    }) as typeof fetch;
    const relay = new RelayTransport({ relays: ["https://a.test"], fetch: fetchFn });
    // A hub's periodic looks run out at the background share, reads and writes alike…
    for (let i = 0; i < BACKGROUND_REQUESTS_PER_MINUTE; i++) await relay.resolve(id.pubKeyZ32, { background: true });
    await expect(relay.publish(id, [{ label: "_ts", value: "2" }], { background: true })).rejects.toThrow("budget");
    // …and a background read with nothing known yet says it waits for the budget, rather than answering from nothing.
    await expect(relay.resolve(createIdentity().pubKeyZ32, { background: true })).rejects.toBeInstanceOf(DiscoveryBudgetError);
    expect(requests).toBe(BACKGROUND_REQUESTS_PER_MINUTE);
    // …while a link's signaling still has the rest.
    for (let i = BACKGROUND_REQUESTS_PER_MINUTE; i < REQUESTS_PER_MINUTE; i++) await relay.resolve(id.pubKeyZ32);
    expect(requests).toBe(REQUESTS_PER_MINUTE);
    await relay.resolve(id.pubKeyZ32);
    expect(requests).toBe(REQUESTS_PER_MINUTE);
  });

  it("lets a link's refused write go before any read once the minute frees a request", async () => {
    // A link polling fast for its peer while its offer waits for the budget: the offer is what the peer
    // waits for, so the request the minute frees goes to it, not to one more poll (the e2e community
    // join waited half a minute so: every freed request went to a poll, the offer out once polls slowed).
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const writes: number[] = [], reads: number[] = [];
      const relay = new RelayTransport({ relays: ["https://a.test"], fetch: (async (_: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") { writes.push(Date.now()); return new Response(null, { status: 204 }); }
        reads.push(Date.now()); return new Response(createRelayPayload(id, [{ label: "_ts", value: "1" }], 3n) as BodyInit);
      }) as typeof fetch });
      const start = Date.now();
      for (let i = 0; i < REQUESTS_PER_MINUTE; i++) { await relay.resolve(id.pubKeyZ32); vi.setSystemTime(Date.now() + 1_000); }
      const offer = createIdentity();
      await expect(relay.publish(offer, [{ label: "_ts", value: "1" }])).rejects.toThrow("budget");
      // The link tries again every few seconds (`PUBLISH_RETRY_MS`), refused while the minute is full…
      vi.setSystemTime(start + 57_000);
      await expect(relay.publish(offer, [{ label: "_ts", value: "1" }])).rejects.toThrow("budget");
      // …then the first request of the minute frees up: a poll comes first, and waits; the offer's retry goes.
      vi.setSystemTime(start + 60_000);
      expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(3n);
      expect(reads).toHaveLength(REQUESTS_PER_MINUTE);
      await relay.publish(offer, [{ label: "_ts", value: "2" }]);
      expect(writes).toHaveLength(1);
      // Out: polls take what frees up again.
      vi.setSystemTime(start + 61_000);
      await relay.resolve(id.pubKeyZ32);
      expect(reads).toHaveLength(REQUESTS_PER_MINUTE + 1);
    } finally { vi.useRealTimers(); }
  });

  it("gives up the reads' wait for a write that never comes back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let reads = 0;
      const relay = new RelayTransport({ relays: ["https://a.test"], fetch: (async (_: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") return new Response(null, { status: 204 });
        reads++; return new Response(createRelayPayload(id, [{ label: "_ts", value: "1" }], 3n) as BodyInit);
      }) as typeof fetch });
      const start = Date.now();
      for (let i = 0; i < REQUESTS_PER_MINUTE; i++) await relay.resolve(id.pubKeyZ32);
      await expect(relay.publish(createIdentity(), [{ label: "_ts", value: "1" }])).rejects.toThrow("budget");
      // The link that wanted to write stopped: after a while, polls go on.
      vi.setSystemTime(start + 60_000 + WRITE_FIRST_MS);
      await relay.resolve(id.pubKeyZ32);
      expect(reads).toBe(REQUESTS_PER_MINUTE + 1);
    } finally { vi.useRealTimers(); }
  });

  it("does not hold reads back on a relay that refused a write another relay took", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const gets: string[] = [];
      const relay = new RelayTransport({ relays: ["https://a.test", "https://b.test"], fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") return new Response(null, { status: 204 });
        gets.push(new URL(String(input)).host); return new Response(createRelayPayload(id, [{ label: "_ts", value: "1" }], 3n) as BodyInit);
      }) as typeof fetch });
      const start = Date.now();
      // Writes go to both relays: 29 on each, then one read fills a's minute.
      for (let i = 0; i < REQUESTS_PER_MINUTE - 1; i++) await relay.publish(createIdentity(), [{ label: "_ts", value: "1" }]);
      vi.setSystemTime(start + 1_000);
      await relay.resolve(id.pubKeyZ32);
      expect(gets).toEqual(["a.test"]);
      // a refuses a link's packet, b takes it: it is out, and the link will not try again…
      vi.setSystemTime(start + 57_000);
      await relay.publish(createIdentity(), [{ label: "_ts", value: "2" }]);
      // …so when a's minute frees up, its reads go on: there is no write to wait for.
      vi.setSystemTime(start + 60_500);
      await relay.resolve(id.pubKeyZ32);
      await relay.resolve(id.pubKeyZ32);
      expect(gets.slice(1).sort()).toEqual(["a.test", "b.test"]);
    } finally { vi.useRealTimers(); }
  });

  it("does not hold reads back for a background write the budget refused", async () => {
    let reads = 0;
    const relay = new RelayTransport({ relays: ["https://a.test"], fetch: (async (_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response(null, { status: 204 });
      reads++; return new Response(createRelayPayload(id, [{ label: "_ts", value: "1" }], 3n) as BodyInit);
    }) as typeof fetch });
    for (let i = 0; i < BACKGROUND_REQUESTS_PER_MINUTE; i++) await relay.resolve(id.pubKeyZ32, { background: true });
    await expect(relay.publish(createIdentity(), [{ label: "_ts", value: "1" }], { background: true })).rejects.toThrow("budget");
    await relay.resolve(id.pubKeyZ32);
    expect(reads).toBe(BACKGROUND_REQUESTS_PER_MINUTE + 1);
  });

  it("counts background requests on their own: a burst of signaling does not hold them back afterwards", async () => {
    let requests = 0;
    const relay = new RelayTransport({ relays: ["https://a.test"], fetch: (async () => {
      requests++; return new Response(createRelayPayload(id, [{ label: "_ts", value: "1" }], 3n) as BodyInit);
    }) as typeof fetch });
    // A link's signaling spent most of the minute…
    for (let i = 0; i < REQUESTS_PER_MINUTE - 5; i++) await relay.resolve(id.pubKeyZ32);
    // …the background still has what is left of the whole, not nothing.
    for (let i = 0; i < 10; i++) await relay.resolve(id.pubKeyZ32, { background: true });
    expect(requests).toBe(REQUESTS_PER_MINUTE);
  });
});

describe("relay transport publishing in bursts", () => {
  it("does not hammer a relay with publish retries after a CORS/network failure", async () => {
    let requests = 0;
    const relay = new RelayTransport({ relays: ["https://a.test"], fetch: (async () => {
      requests++; throw new TypeError("Failed to fetch");
    }) as typeof fetch });
    const id = createIdentity();
    for (let i = 0; i < 10; i++) await expect(relay.publish(id, [{ label: "_ts", value: "1" }])).rejects.toThrow();
    expect(requests).toBe(1);
  });
  it("budgets writes as well as polls", async () => {
    let requests = 0;
    const relay = new RelayTransport({ relays: ["https://a.test"], fetch: (async () => {
      requests++; return new Response(null, { status: 204 });
    }) as typeof fetch });
    const id = createIdentity();
    for (let i = 0; i < 30; i++) await relay.publish(id, [{ label: "_ts", value: "1" }]);
    await expect(relay.publish(id, [{ label: "_ts", value: "1" }])).rejects.toThrow("budget");
    expect(requests).toBe(30);
  });
  it("tells the relay which packet it replaces, and insists when the relay never saw it", async () => {
    const id = createIdentity();
    const seen: (string | null)[] = [];
    let stored: string | null = null;
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const ifMatch = new Headers(init?.headers).get("if-match");
      seen.push(ifMatch);
      // Like a relay with a put in flight: replacing needs the right If-Match.
      if (stored !== null && ifMatch === null) return new Response(null, { status: 428 });
      if (ifMatch !== null && ifMatch !== stored) return new Response(null, { status: 412 });
      const body = new Uint8Array(init!.body as Uint8Array);
      stored = new DataView(body.buffer, body.byteOffset + 64, 8).getBigUint64(0).toString();
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const relay = new RelayTransport({ relays: ["https://a.test"], fetch: fetchFn });
    await relay.publish(id, [{ label: "_ts", value: "1" }]);
    await relay.publish(id, [{ label: "_ts", value: "2" }]);
    await relay.publish(id, [{ label: "_ts", value: "3" }]);
    expect(seen[0]).toBeNull();
    expect(seen[1]).not.toBeNull();
    expect(seen).toHaveLength(3);

    // The relay forgot everything: the stale If-Match gets 412 and the publish goes through without it.
    stored = null;
    await relay.publish(id, [{ label: "_ts", value: "4" }]);
    expect(seen.slice(3)).toEqual([seen[2] === null ? null : expect.any(String), null]);
  });
});

describe("relay operation backoff", () => {
  it("keeps healthy reads available while backing off failed publications", async () => {
    const calls: string[] = [];
    const relay = new RelayTransport({ relays: ["https://a.test"], fetch: (async (_url, init) => {
      calls.push(init?.method ?? "GET");
      if (init?.method === "PUT") throw new TypeError("Failed to fetch");
      return new Response(null, {status:404});
    }) as typeof fetch });
    const id = createIdentity();
    for (let i = 0; i < 3; i++) {
      await expect(relay.publish(id, [])).rejects.toThrow();
      expect(await relay.resolve(id.pubKeyZ32)).toBeNull();
    }
    expect(calls).toEqual(["PUT", "GET", "GET", "GET"]);
  });

  it.each(["GET", "PUT"])("keeps observed %s rate limits global across operations", async method => {
    let requests = 0;
    const relay = new RelayTransport({ relays: ["https://a.test"], fetch: (async () => {
      requests++;
      return new Response(null, {status:429, headers:{"retry-after":"30"}});
    }) as typeof fetch });
    const id = createIdentity();
    if (method === "GET") await expect(relay.resolve(id.pubKeyZ32)).rejects.toThrow();
    else await expect(relay.publish(id, [])).rejects.toThrow();
    await expect(relay.publish(id, [])).rejects.toThrow();
    await expect(relay.resolve(id.pubKeyZ32)).rejects.toThrow();
    expect(requests).toBe(1);
  });
});

describe("relay transport: the budget holds requests back as a wait", () => {
  const id = createIdentity();
  const ok = (async (_: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "PUT" ? new Response(null, { status: 204 }) : new Response(createRelayPayload(id, [{ label: "_ts", value: "1" }], 3n) as BodyInit)) as typeof fetch;

  it("says a publish waits, and for how long: until the oldest request of the minute ages out on the relay that frees first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const relay = new RelayTransport({ relays: ["https://a.test", "https://b.test"], fetch: ok });
      const start = Date.now();
      // 30 reads a second apart, alternating: each relay's minute is full, a.test's oldest request the older one.
      for (let i = 0; i < 2 * REQUESTS_PER_MINUTE; i++) { await relay.resolve(id.pubKeyZ32); vi.setSystemTime(Date.now() + 500); }
      const refused = await relay.publish(createIdentity(), [{ label: "_ts", value: "1" }]).then(() => null, (error: unknown) => error);
      expect(isDiscoveryBudgetError(refused)).toBe(true);
      // a.test's first read was at `start`: it frees at start + 60 s.
      expect((refused as DiscoveryBudgetError).retryInMs).toBe(start + 60_000 - Date.now());
      expect((refused as Error).message).toContain("Publish held back on every relay");
      // Nothing went out, and the refusal cost nothing: at the time it named, the publish goes.
      vi.setSystemTime(start + 60_000);
      await relay.publish(createIdentity(), [{ label: "_ts", value: "1" }]);
    } finally { vi.useRealTimers(); }
  });

  it("types a relay's own 429 as a wait for its Retry-After", async () => {
    const relay = new RelayTransport({ relays: ["https://a.test"], fetch: (async () => new Response(null, { status: 429, headers: { "retry-after": "20" } })) as typeof fetch });
    const first = await relay.publish(id, []).then(() => null, (error: unknown) => error);
    expect(isDiscoveryBudgetError(first) && first.retryInMs).toBe(20_000);
    const again = await relay.resolve(createIdentity().pubKeyZ32).then(() => null, (error: unknown) => error);
    expect(isDiscoveryBudgetError(again) && again.retryInMs).toBeGreaterThan(19_000);
  });

  it("is a failure, not a wait, when a relay failed at the network level", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let spent = 0;
      const relay = new RelayTransport({ relays: ["https://a.test", "https://b.test"], fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("b.test")) throw new TypeError("Failed to fetch");
        spent++;
        return ok(input, init);
      }) as typeof fetch });
      while (spent < REQUESTS_PER_MINUTE) await relay.resolve(id.pubKeyZ32).catch(() => {});
      const refused = await relay.publish(createIdentity(), []).then(() => null, (error: unknown) => error);
      expect(refused).toBeInstanceOf(Error);
      expect(isDiscoveryBudgetError(refused)).toBe(false);
      expect((refused as Error).message).toContain("Publish failed on every relay");
    } finally { vi.useRealTimers(); }
  });

  it("recognises a budget error from another copy of the module by its code", () => {
    const foreign = Object.assign(new Error("Discovery request budget reached; retry shortly"), { code: "discovery-budget", retryInMs: 1_000 });
    expect(isDiscoveryBudgetError(foreign)).toBe(true);
    expect(isDiscoveryBudgetError(new Error("Discovery request budget reached; retry shortly"))).toBe(false);
  });
});

describe("relay transport: a chat before its groups", () => {
  // A profile in several groups: an edge per member polls and signals. A 1:1 chat that is using the relay keeps the
  // last CHAT_RESERVE requests of each minute; with no chat about, the groups have them all.
  const id = createIdentity();
  function counting() {
    const log: { method: string; at: number }[] = [];
    const relay = new RelayTransport({ relays: ["https://a.test"], fetch: (async (_: RequestInfo | URL, init?: RequestInit) => {
      log.push({ method: init?.method ?? "GET", at: Date.now() });
      return init?.method === "PUT" ? new Response(null, { status: 204 }) : new Response(createRelayPayload(id, [{ label: "_ts", value: "1" }], 3n) as BodyInit);
    }) as typeof fetch });
    return { relay, log, group: withRequestOptions(relay, { group: true }) };
  }

  it("leaves a chat that is using the relay the end of the minute, whatever the groups ask", async () => {
    const { relay, log, group } = counting();
    await relay.resolve(id.pubKeyZ32);
    // The groups' edges poll and signal: they stop short of the chat's share…
    for (let i = 0; i < REQUESTS_PER_MINUTE; i++) await group.resolve(id.pubKeyZ32).catch(() => {});
    expect(log).toHaveLength(REQUESTS_PER_MINUTE - CHAT_RESERVE);
    const refused = await group.publish(createIdentity(), [{ label: "_ts", value: "1" }]).catch((e: unknown) => e);
    expect(isDiscoveryBudgetError(refused)).toBe(true);
    await expect(group.resolve(createIdentity().pubKeyZ32)).rejects.toBeInstanceOf(DiscoveryBudgetError);
    // …and the chat's message goes out at once, as do its looks for the receipt.
    await relay.publish(createIdentity(), [{ label: "_ts", value: "1" }]);
    for (let i = 0; i < CHAT_RESERVE - 1; i++) await relay.resolve(id.pubKeyZ32);
    expect(log).toHaveLength(REQUESTS_PER_MINUTE);
  });

  it("counts a group's background looks (a community hub's) toward the groups' share too", async () => {
    const { relay, log, group } = counting();
    await relay.resolve(id.pubKeyZ32);
    for (let i = 0; i < REQUESTS_PER_MINUTE; i++) await group.resolve(id.pubKeyZ32, { background: true }).catch(() => {});
    expect(log).toHaveLength(Math.min(1 + BACKGROUND_REQUESTS_PER_MINUTE, REQUESTS_PER_MINUTE - CHAT_RESERVE));
  });

  it("gives the groups the whole minute when no chat is about, and again a minute after the chat's last request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { relay, log, group } = counting();
      for (let i = 0; i < REQUESTS_PER_MINUTE; i++) await group.resolve(id.pubKeyZ32);
      expect(log).toHaveLength(REQUESTS_PER_MINUTE);

      const start = Date.now() + 60_000;
      vi.setSystemTime(start);
      await relay.resolve(id.pubKeyZ32);
      for (let i = 0; i < REQUESTS_PER_MINUTE; i++) await group.resolve(id.pubKeyZ32);
      expect(log).toHaveLength(REQUESTS_PER_MINUTE + REQUESTS_PER_MINUTE - CHAT_RESERVE);
      // The chat went quiet: once its minute is over, the groups take what is free.
      vi.setSystemTime(start + 60_000);
      for (let i = 0; i < REQUESTS_PER_MINUTE; i++) await group.resolve(id.pubKeyZ32);
      expect(log.filter((r) => r.at >= start + 60_000)).toHaveLength(REQUESTS_PER_MINUTE);
    } finally { vi.useRealTimers(); }
  });

  it("says how long a group's request waits: until the chat's reserve lapses or the minute frees one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { relay, group } = counting();
      const start = Date.now();
      await relay.resolve(id.pubKeyZ32);
      vi.setSystemTime(start + 5_000);
      for (let i = 0; i < REQUESTS_PER_MINUTE - CHAT_RESERVE - 1; i++) await group.resolve(id.pubKeyZ32);
      vi.setSystemTime(start + 10_000);
      const refused = await group.publish(createIdentity(), [{ label: "_ts", value: "1" }]).catch((e: unknown) => e) as DiscoveryBudgetError;
      expect(isDiscoveryBudgetError(refused)).toBe(true);
      // The chat's request at `start` frees a request of the groups' share, and ends its reserve, at start + 60 s.
      expect(refused.retryInMs).toBe(50_000);
    } finally { vi.useRealTimers(); }
  });

  it("lets a chat's refused write go before a group's requests, and a group's refused write never holds a chat back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { relay, log, group } = counting();
      const start = Date.now();
      for (let i = 0; i < REQUESTS_PER_MINUTE; i++) await relay.resolve(id.pubKeyZ32);
      const message = createIdentity();
      await expect(relay.publish(message, [{ label: "_ts", value: "1" }])).rejects.toThrow("budget");
      // The chat tries again every few seconds, refused while the minute is full…
      vi.setSystemTime(start + 57_000);
      await expect(relay.publish(message, [{ label: "_ts", value: "1" }])).rejects.toThrow("budget");
      // …then the minute frees a request: the group's poll and even its write wait, the chat's write goes.
      vi.setSystemTime(start + 60_000);
      await expect(group.resolve(createIdentity().pubKeyZ32)).rejects.toBeInstanceOf(DiscoveryBudgetError);
      await expect(group.publish(createIdentity(), [{ label: "_ts", value: "1" }])).rejects.toThrow("budget");
      await relay.publish(message, [{ label: "_ts", value: "2" }]);
      expect(log.filter((r) => r.method === "PUT")).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("does not hold a chat's reads back for a group's refused write", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { relay, log, group } = counting();
      const start = Date.now(), offer = createIdentity();
      // No chat about: the groups spend the minute, and an edge's offer is refused, and again at its next try.
      for (let i = 0; i < REQUESTS_PER_MINUTE; i++) await group.resolve(id.pubKeyZ32);
      await expect(group.publish(offer, [{ label: "_ts", value: "1" }])).rejects.toThrow("budget");
      vi.setSystemTime(start + 57_000);
      await expect(group.publish(offer, [{ label: "_ts", value: "1" }])).rejects.toThrow("budget");
      // The first request frees: a chat's read takes it, the offer does not hold it back…
      vi.setSystemTime(start + 60_000);
      await relay.resolve(id.pubKeyZ32);
      expect(log).toHaveLength(REQUESTS_PER_MINUTE + 1);
      // …while a group's own read still lets the offer go first.
      await expect(group.resolve(createIdentity().pubKeyZ32)).rejects.toBeInstanceOf(DiscoveryBudgetError);
    } finally { vi.useRealTimers(); }
  });
});
