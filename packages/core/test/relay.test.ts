import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_REQUESTS_PER_MINUTE, BACKGROUND_WHILE_SIGNALING, CHAT_RESERVE, SIGNALING_ALLOWANCE_SHARE, DiscoveryBudgetError, GROUP_BURST_MS, GROUP_BURST_ONE_LINK, FRESH_READ_MS, REQUESTS_PER_MINUTE, PKARR_FUTURE_SKEW_MS, RelayTransport, newerPacket, parseRelayPayload, SIGNALING_WINDOW_MS, WRITE_FIRST_MS, createIdentity, createRelayPayload, isDiscoveryBudgetError, withRequestOptions } from "../src";
import type { PkarrTransport } from "../src/transport";
// covers: core.relay-client

describe("relay transport", () => {
  const id = createIdentity();
  const packet = (micros: bigint) => createRelayPayload(id, [{ label: "_ts", value: String(micros) }], micros);
  const parse = async (micros: bigint) => parseRelayPayload(id.pubKeyZ32, packet(micros));

  function transport(handlers: Record<string, () => Response>) {
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const host = new URL(String(input)).host;
      calls.push(host);
      return handlers[host]();
    }) as typeof fetch;
    return { calls, relay: new RelayTransport({ freshReadMs: 0, relays: Object.keys(handlers).map((h) => `https://${h}`), fetch: fetchFn }) };
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

  it("takes the relays in turn for each key: one that lacks a key's newest packet answers its reads at most once in a row", async () => {
    // Bug hunt r5a: a member's offer reached only b.test (a.test had rate limited the publish). The other member read
    // the offerer's key between reads of its other links, and with one turn for all keys, every read of that key went to
    // a.test, which kept serving the packet from before the offer: the offer was read 12 to 60 s late.
    const peer = createIdentity(), other = createIdentity();
    const reads: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.slice(1) !== peer.pubKeyZ32) return new Response(null, { status: 404 });
      reads.push(url.host);
      const offer = url.host === "b.test";
      return new Response(createRelayPayload(peer, [{ label: "_ts", value: "1" }], offer ? 2000n : 1000n) as BodyInit);
    }) as typeof fetch;
    const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test", "https://b.test"], fetch: fetchFn });
    const seen: bigint[] = [];
    for (let i = 0; i < 6; i++) {
      seen.push((await relay.resolve(peer.pubKeyZ32))!.timestampMicros);
      // The link's neighbours read their own peers in between.
      await relay.resolve(other.pubKeyZ32);
    }
    expect(reads).toEqual(["a.test", "b.test", "a.test", "b.test", "a.test", "b.test"]);
    // The offer is read on the second look, not never.
    expect(seen[1]).toBe(2000n);
  });

  it("keeps each relay's share of the reads when every key takes them in turn", async () => {
    const { relay, calls } = transport({ "a.test": () => new Response(null, { status: 404 }), "b.test": () => new Response(null, { status: 404 }) });
    const keys = Array.from({ length: 5 }, () => createIdentity().pubKeyZ32);
    for (let round = 0; round < 6; round++) for (const key of keys) await relay.resolve(key);
    // 30 reads of five keys: as many on each relay as one turn for all keys gave.
    expect(calls.filter((h) => h === "a.test")).toHaveLength(15);
    expect(calls.filter((h) => h === "b.test")).toHaveLength(15);
  });

  it("a packet dated far ahead never hides one dated now: the next read of a present packet is taken", async () => {
    const now = BigInt(Date.now()) * 1000n;
    const ahead = now + BigInt(PKARR_FUTURE_SKEW_MS + 3_600_000) * 1000n;
    const { relay } = transport({
      "a.test": () => new Response(packet(ahead) as BodyInit),
      "b.test": () => new Response(packet(now) as BodyInit),
    });
    expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(ahead);
    expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(now);
    // Within the skew, a later time still wins as before.
    const soon = now + 60_000_000n;
    expect(newerPacket(await parse(now), await parse(soon))?.timestampMicros).toBe(soon);
    expect(newerPacket(await parse(ahead), await parse(ahead + 1n))?.timestampMicros).toBe(ahead + 1n);
  });

  it("answers a read of a key it just read from that answer, until the key is published or the answer ages", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let next = 1000n;
      const calls: string[] = [];
      const other = createIdentity();
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const key = new URL(String(input)).pathname.slice(1);
        calls.push(`${init?.method ?? "GET"} ${key.slice(0, 6)}`);
        if (init?.method === "PUT") return new Response(null, { status: 204 });
        return key === id.pubKeyZ32 ? new Response(packet(next) as BodyInit) : new Response(null, { status: 404 });
      }) as typeof fetch;
      const relay = new RelayTransport({ relays: ["https://a.test", "https://b.test"], fetch: fetchFn });
      const get = `GET ${id.pubKeyZ32.slice(0, 6)}`;
      expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(1000n);
      // A link's poll right after its capabilities read the same key: the answer of a moment ago, no request.
      next = 2000n;
      vi.setSystemTime(Date.now() + FRESH_READ_MS - 1);
      expect((await relay.resolve(id.pubKeyZ32, { urgent: true }))?.timestampMicros).toBe(1000n);
      expect(calls).toEqual([get]);
      // Another key is its own read.
      await relay.resolve(other.pubKeyZ32);
      expect(calls).toHaveLength(2);
      // Once the answer is older, the relays are asked again.
      vi.setSystemTime(Date.now() + 1);
      expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(2000n);
      expect(calls).toHaveLength(3);
      // A record read, changed and written back is read from the relays the next time, however soon.
      await relay.publish(id, [{ label: "_ts", value: "3" }]);
      next = 3000n;
      expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(3000n);
      expect(calls.slice(3)).toEqual([`PUT ${id.pubKeyZ32.slice(0, 6)}`, `PUT ${id.pubKeyZ32.slice(0, 6)}`, get]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a read the budget holds back answers what this client published since its last read, not the older packet read", async () => {
    // A community hub reads its beacon, writes its own entry into it, and reads it again while the budget is spent
    // (another link signaling): its own entry must not look as old as the one it replaced, or the hub stops
    // counting itself at the door (doorHubs) until its next write, and a knock waits that long.
    const stored = new Map<string, Uint8Array>();
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = new URL(String(input)).pathname.slice(1);
      calls.push(init?.method ?? "GET");
      if (init?.method === "PUT") { stored.set(key, new Uint8Array(await new Response(init.body).arrayBuffer())); return new Response(null, { status: 204 }); }
      const bytes = stored.get(key);
      return bytes ? new Response(bytes as BodyInit) : new Response(null, { status: 404 });
    }) as typeof fetch;
    stored.set(id.pubKeyZ32, packet(1000n));
    const relay = new RelayTransport({ freshReadMs: 0, requestsPerMinute: 2, relays: ["https://a.test"], fetch: fetchFn });
    expect((await relay.resolve(id.pubKeyZ32, { background: true, group: true }))?.timestampMicros).toBe(1000n);
    await relay.publish(id, [{ label: "_ts", value: "mine" }], { background: true, group: true });
    const mine = parseRelayPayload(id.pubKeyZ32, stored.get(id.pubKeyZ32)!);
    // The minute's two requests are spent: no request, and the answer is the packet just published.
    const held = await relay.resolve(id.pubKeyZ32, { background: true, group: true });
    expect(calls).toEqual(["GET", "PUT"]);
    expect(held?.timestampMicros).toBe(mine.timestampMicros);
    expect(held?.records.find((r) => r.label === "_ts")?.value).toBe("mine");
  });

  it("a read the relays fail is an outage, even under a key this client published", async () => {
    // An inviter puts a placeholder under its contact's key before they join: a relay that errs on the read must
    // surface as "Could not read discovery", not be answered by that placeholder.
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(null, { status: init?.method === "PUT" ? 204 : 503 })) as typeof fetch;
    const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: fetchFn });
    await relay.publish(id, [{ label: "_ts", value: "mine" }]);
    await expect(relay.resolve(id.pubKeyZ32)).rejects.toThrow("No Pkarr relay reachable");
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
    const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test", "https://b.test"], fetch: fetchFn });
    for (let i = 0; i < 4; i++) expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(9n);
    expect(calls.filter((h) => h === "a.test")).toHaveLength(1);
  });

  it("never spends more than its budget on a relay, and keeps answering from what it knows", async () => {
    let requests = 0;
    const fetchFn = (async () => {
      requests++;
      return new Response(createRelayPayload(id, [{ label: "_ts", value: "1" }], 3n) as BodyInit);
    }) as typeof fetch;
    const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: fetchFn });
    for (let i = 0; i < 100; i++) expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(3n);
    expect(requests).toBe(30);
  });

  it("spends only part of the budget on background requests, keeping the rest for the links", async () => {
    let requests = 0;
    const fetchFn = (async (_: RequestInfo | URL, init?: RequestInit) => {
      requests++;
      return init?.method === "PUT" ? new Response(null, { status: 204 }) : new Response(createRelayPayload(id, [{ label: "_ts", value: "1" }], 3n) as BodyInit);
    }) as typeof fetch;
    const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: fetchFn });
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
      const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: (async (_: RequestInfo | URL, init?: RequestInit) => {
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
      const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: (async (_: RequestInfo | URL, init?: RequestInit) => {
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
      const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test", "https://b.test"], fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
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
    const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: (async (_: RequestInfo | URL, init?: RequestInit) => {
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
    const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: (async () => {
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
    const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: (async () => {
      requests++; throw new TypeError("Failed to fetch");
    }) as typeof fetch });
    const id = createIdentity();
    for (let i = 0; i < 10; i++) await expect(relay.publish(id, [{ label: "_ts", value: "1" }])).rejects.toThrow();
    expect(requests).toBe(1);
  });
  it("budgets writes as well as polls", async () => {
    let requests = 0;
    const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: (async () => {
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

    const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: fetchFn });
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
    const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: (async (_url, init) => {
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
    const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: (async () => {
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
      const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test", "https://b.test"], fetch: ok });
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
    const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: (async () => new Response(null, { status: 429, headers: { "retry-after": "20" } })) as typeof fetch });
    const first = await relay.publish(id, []).then(() => null, (error: unknown) => error);
    expect(isDiscoveryBudgetError(first) && first.retryInMs).toBe(20_000);
    const again = await relay.resolve(createIdentity().pubKeyZ32).then(() => null, (error: unknown) => error);
    expect(isDiscoveryBudgetError(again) && again.retryInMs).toBeGreaterThan(19_000);
  });

  it("is a failure, not a wait, when a relay failed at the network level", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let spent = 0;
      const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test", "https://b.test"], fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
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
  // A profile in several groups: an edge per member polls and signals. Once the budget holds a 1:1 chat back, the
  // groups leave it the last CHAT_RESERVE requests of each minute, for a minute; until then they have them all.
  const id = createIdentity();
  function counting() {
    const log: { method: string; at: number }[] = [];
    const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: (async (_: RequestInfo | URL, init?: RequestInit) => {
      log.push({ method: init?.method ?? "GET", at: Date.now() });
      return init?.method === "PUT" ? new Response(null, { status: 204 }) : new Response(createRelayPayload(id, [{ label: "_ts", value: "1" }], 3n) as BodyInit);
    }) as typeof fetch });
    return { relay, log, group: withRequestOptions(relay, { group: true }) };
  }
  /** The groups spend the minute one request a second from `start`, as a busy community door and its edges do. */
  async function groupsSpendTheMinute(group: ReturnType<typeof counting>["group"], start: number) {
    for (let i = 0; i < REQUESTS_PER_MINUTE; i++) { vi.setSystemTime(start + i * 1_000); await group.resolve(id.pubKeyZ32); }
  }

  it("gives the groups the whole minute while no chat is held back, a chat's own traffic included", async () => {
    const { relay, log, group } = counting();
    await relay.resolve(id.pubKeyZ32);
    for (let i = 0; i < REQUESTS_PER_MINUTE; i++) await group.resolve(id.pubKeyZ32, { background: i % 2 === 0 }).catch(() => {});
    expect(log).toHaveLength(REQUESTS_PER_MINUTE);
  });

  it("gives a chat the budget held back the next requests that free, before any group's, and room for what follows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { relay, log, group } = counting();
      const start = Date.now(), message = createIdentity();
      await groupsSpendTheMinute(group, start);
      vi.setSystemTime(start + 30_000);
      await expect(relay.publish(message, [{ label: "_ts", value: "1" }])).rejects.toThrow("budget");
      // The groups' first request ages out: an edge's poll (and even its write) waits, the message goes…
      vi.setSystemTime(start + 60_000);
      await expect(group.resolve(createIdentity().pubKeyZ32)).rejects.toBeInstanceOf(DiscoveryBudgetError);
      await expect(group.publish(createIdentity(), [{ label: "_ts", value: "1" }])).rejects.toThrow("budget");
      await relay.publish(message, [{ label: "_ts", value: "2" }]);
      expect(log.filter((r) => r.method === "PUT")).toHaveLength(1);
      // …and as the groups' requests age out, their share refills only to what leaves the chat its reserve.
      for (let t = 61_000; t < 80_000; t += 1_000) {
        vi.setSystemTime(start + t);
        await group.resolve(id.pubKeyZ32).catch(() => {});
      }
      const inMinute = (at: number) => log.filter((r) => r.at > at - 60_000 && r.at <= at).length;
      expect(inMinute(start + 79_000)).toBe(REQUESTS_PER_MINUTE - CHAT_RESERVE);
      // The chat's looks for its receipt go at once.
      for (let i = 0; i < CHAT_RESERVE; i++) await relay.resolve(id.pubKeyZ32);
      expect(inMinute(start + 79_000)).toBe(REQUESTS_PER_MINUTE);
    } finally { vi.useRealTimers(); }
  });

  it("counts a group's background looks (a community hub's) toward the groups' share too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { relay, log, group } = counting();
      const start = Date.now();
      await groupsSpendTheMinute(group, start);
      vi.setSystemTime(start + 40_000);
      await expect(relay.publish(createIdentity(), [{ label: "_ts", value: "1" }])).rejects.toThrow("budget");
      // A minute on, the chat reads a few times; a hub's background looks stop at the groups' share, short of their own.
      const at = start + 99_000;
      vi.setSystemTime(at);
      for (let i = 0; i < 5; i++) await relay.resolve(id.pubKeyZ32);
      for (let i = 0; i < REQUESTS_PER_MINUTE; i++) await group.resolve(id.pubKeyZ32, { background: true }).catch(() => {});
      expect(log.filter((r) => r.at === at)).toHaveLength(REQUESTS_PER_MINUTE - CHAT_RESERVE);
      expect(REQUESTS_PER_MINUTE - CHAT_RESERVE - 5).toBeLessThan(BACKGROUND_REQUESTS_PER_MINUTE);
    } finally { vi.useRealTimers(); }
  });

  it("lifts the reserve a minute after the chat was last held back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { relay, log, group } = counting();
      const start = Date.now();
      await groupsSpendTheMinute(group, start);
      const refusedAt = start + 40_000;
      vi.setSystemTime(refusedAt);
      await expect(relay.publish(createIdentity(), [{ label: "_ts", value: "1" }])).rejects.toThrow("budget");
      // Everything of that minute aged out, but the chat was held back less than a minute ago.
      vi.setSystemTime(refusedAt + 59_000);
      for (let i = 0; i < REQUESTS_PER_MINUTE; i++) await group.resolve(id.pubKeyZ32).catch(() => {});
      expect(log.filter((r) => r.at === refusedAt + 59_000)).toHaveLength(REQUESTS_PER_MINUTE - CHAT_RESERVE);
      // A group's request says how long it waits: until the reserve lifts, not until the minute's requests age out.
      const offer = createIdentity();
      const refused = await group.publish(offer, [{ label: "_ts", value: "1" }]).catch((e: unknown) => e) as DiscoveryBudgetError;
      expect(refused.retryInMs).toBe(1_000);
      // Lifted: the edge's offer goes first, then its polls.
      vi.setSystemTime(refusedAt + 60_000);
      await group.publish(offer, [{ label: "_ts", value: "2" }]);
      for (let i = 1; i < CHAT_RESERVE; i++) await group.resolve(id.pubKeyZ32);
      expect(log.filter((r) => r.at >= refusedAt + 59_000)).toHaveLength(REQUESTS_PER_MINUTE);
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

  it("leaves a chat that polls fast its reserve on every relay before anything is refused, for a minute after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const log: { host: string; at: number }[] = [];
      const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test", "https://b.test"], fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        log.push({ host: new URL(String(input)).host, at: Date.now() });
        return init?.method === "PUT" ? new Response(null, { status: 204 }) : new Response(createRelayPayload(id, [{ label: "_ts", value: "1" }], 3n) as BodyInit);
      }) as typeof fetch });
      const group = withRequestOptions(relay, { group: true });
      const start = Date.now();
      // A contact went away from a chat and from two groups: the chat and the edges all watch fast for it (the two edges
      // read every 2 s each, a read a second).
      await relay.resolve(id.pubKeyZ32, { urgent: true });
      for (let i = 0; i < 2 * REQUESTS_PER_MINUTE; i++) { vi.setSystemTime(start + i * 1_000); await group.resolve(id.pubKeyZ32, { urgent: true }).catch(() => {}); }
      // The edges stop short of the reserve on both relays, the one the chat read from (its read counted) and the other.
      const on = (host: string) => log.filter((r) => r.host === host).length;
      expect(on("a.test") + on("b.test")).toBe(2 * (REQUESTS_PER_MINUTE - CHAT_RESERVE));
      // The contact's offer is read at once, on either relay, and what follows too.
      for (let i = 0; i < 2 * CHAT_RESERVE; i++) await relay.resolve(id.pubKeyZ32, { urgent: true });
      expect(log).toHaveLength(2 * REQUESTS_PER_MINUTE);
      // The reserve holds a minute after the chat's last fast read (a watch goes on at the active pace): the edges'
      // requests aged out, the chat's did not, and the edges fill only up to the reserve…
      const lastUrgent = Date.now();
      vi.setSystemTime(lastUrgent + 59_000);
      for (let i = 0; i < 2 * REQUESTS_PER_MINUTE; i++) await group.resolve(id.pubKeyZ32).catch(() => {});
      expect(log.filter((r) => r.at === lastUrgent + 59_000)).toHaveLength(2 * (REQUESTS_PER_MINUTE - 2 * CHAT_RESERVE));
      // …and say how long they wait: until the reserve lifts.
      const offer = createIdentity();
      const refused = await group.publish(offer, [{ label: "_ts", value: "1" }]).catch((e: unknown) => e) as DiscoveryBudgetError;
      expect(refused.retryInMs).toBe(1_000);
      vi.setSystemTime(lastUrgent + 60_000);
      await group.publish(offer, [{ label: "_ts", value: "2" }]);
    } finally { vi.useRealTimers(); }
  });

  it("gives a chat's reserve back once the chat reads its contact at a slow pace again (it is live)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const log: { at: number }[] = [];
      // The contacts have published nothing yet (404); the edge's member has.
      const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: (async (input: RequestInfo | URL) => {
        log.push({ at: Date.now() });
        return String(input).endsWith(id.pubKeyZ32) ? new Response(createRelayPayload(id, [{ label: "_ts", value: "1" }], 3n) as BodyInit) : new Response(null, { status: 404 });
      }) as typeof fetch });
      const group = withRequestOptions(relay, { group: true });
      const start = Date.now(), contact = createIdentity().pubKeyZ32, other = createIdentity().pubKeyZ32;
      // Two chats watch fast for their contacts; the edges' reads stop short of the reserve.
      await relay.resolve(contact, { urgent: true });
      await relay.resolve(other, { urgent: true });
      for (let i = 0; i < REQUESTS_PER_MINUTE; i++) { vi.setSystemTime(start + i * 100); await group.resolve(id.pubKeyZ32).catch(() => {}); }
      expect(log).toHaveLength(REQUESTS_PER_MINUTE - CHAT_RESERVE);
      // One chat is live (it reads at the connected pace, a background read): the other still waits, the reserve holds.
      vi.setSystemTime(start + 20_000);
      await relay.resolve(contact, { background: true });
      vi.setSystemTime(start + 30_000);
      await group.resolve(id.pubKeyZ32);
      // A group's own background read of a key is no chat going live.
      await group.resolve(other, { background: true }).catch(() => {});
      await group.resolve(id.pubKeyZ32);
      expect(log).toHaveLength(REQUESTS_PER_MINUTE - CHAT_RESERVE + 1);
      // Both live: the edges take the rest of the minute at once. Dev: nothing until a minute after the chats' last fast
      // read.
      await relay.resolve(other, { background: true });
      for (let i = 0; i < REQUESTS_PER_MINUTE; i++) await group.resolve(id.pubKeyZ32).catch(() => {});
      expect(log).toHaveLength(REQUESTS_PER_MINUTE);
    } finally { vi.useRealTimers(); }
  });

  it("does not keep a reserve for a chat that is not waiting for anything", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { relay, log, group } = counting();
      const start = Date.now();
      // Its looks at the active pace and its background ones leave the groups the whole minute (an edge polling fast).
      await relay.resolve(id.pubKeyZ32);
      await relay.resolve(id.pubKeyZ32, { background: true });
      for (let i = 0; i < REQUESTS_PER_MINUTE; i++) { vi.setSystemTime(start + i * 1_900); await group.resolve(id.pubKeyZ32, { urgent: true }).catch(() => {}); }
      expect(log).toHaveLength(REQUESTS_PER_MINUTE);
    } finally { vi.useRealTimers(); }
  });

  it("spreads the groups' fast reads over the minute: a burst of edges does not spend it in seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { log, group } = counting();
      const start = Date.now();
      // An app back after a restart: four edges offer at once and look fast for their answers, a read every 2 s each.
      for (let t = 0; t < 60_000; t += 500) { vi.setSystemTime(start + t); await group.resolve(id.pubKeyZ32, { urgent: true }).catch(() => {}); }
      const inWindow = (from: number) => log.filter((r) => r.at >= start + from && r.at < start + from + GROUP_BURST_MS).length;
      // A quarter of the relay's minute in any 15 s, and never fewer than one edge alone reads (8): the answers that
      // come 20 or 45 s on (the members noticing the old sessions went) are read then, not a minute later.
      for (const from of [0, 15_000, 30_000]) expect(inWindow(from)).toBe(Math.max(GROUP_BURST_ONE_LINK, REQUESTS_PER_MINUTE / 4));
      // What the minute has left goes in its last quarter. On dev they took the whole minute in its first 15 s, and read
      // nothing for the other 45.
      expect(inWindow(45_000)).toBe(REQUESTS_PER_MINUTE - 3 * GROUP_BURST_ONE_LINK);
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

describe("relay transport: background requests yield to a link that signals", () => {
  const id = createIdentity();
  function counting() {
    const log: { background: boolean; at: number }[] = [];
    let background = false;
    const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: (async () => {
      log.push({ background, at: Date.now() });
      return new Response(createRelayPayload(id, [{ label: "_ts", value: "1" }], 3n) as BodyInit);
    }) as typeof fetch });
    const look = (at: number) => { vi.setSystemTime(at); background = true; return relay.resolve(id.pubKeyZ32, { background: true, group: true }); };
    return { relay, log, look, edge: withRequestOptions(relay, { group: true }), setBackground: (b: boolean) => { background = b; } };
  }

  it("holds a community's looks to a small share while a new edge polls fast, and lets them go on once it stops", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { log, look, edge, setBackground } = counting();
      const start = Date.now();
      // A hub looks at its records all the time, a look every 3 s: its whole share of the minute.
      for (let i = 0; i < BACKGROUND_REQUESTS_PER_MINUTE; i++) await look(start + i * 3_000);
      // A new edge starts signaling: it polls fast, and the looks wait until their minute is down to the small share.
      const signalFrom = start + 60_000;
      for (let t = 0; t < 30_000; t += 1_000) {
        vi.setSystemTime(signalFrom + t);
        if (t % 2_000 === 0) { setBackground(false); await edge.resolve(id.pubKeyZ32, { urgent: true }); }
        await look(signalFrom + t).catch(() => {});
      }
      const inMinute = (at: number, background: boolean) => log.filter((r) => r.background === background && r.at > at - 60_000 && r.at <= at).length;
      // The hub's minute still holds more looks than the small share: none went while the edge signaled.
      expect(inMinute(signalFrom + 29_000, true)).toBeGreaterThan(BACKGROUND_WHILE_SIGNALING);
      expect(log.filter((r) => r.background && r.at >= signalFrom)).toHaveLength(0);
      // The edge had every poll it asked for: 15 in 30 s, on one relay, next to the hub.
      expect(inMinute(signalFrom + 29_000, false)).toBe(15);
      // A look held back says how long: until the edge stops signaling, if that comes before its own minute frees one.
      vi.setSystemTime(signalFrom + 29_000);
      const held = await edge.resolve(createIdentity().pubKeyZ32, { background: true }).catch((e: unknown) => e) as DiscoveryBudgetError;
      expect(held.retryInMs).toBe(SIGNALING_WINDOW_MS - 1_000);
      // Once the edge is live (no fast polls), the hub's looks take what the minute has left again.
      const after = signalFrom + 28_000 + SIGNALING_WINDOW_MS;
      for (let i = 0; i < BACKGROUND_REQUESTS_PER_MINUTE; i++) await look(after).catch(() => {});
      expect(log.filter((r) => r.background && r.at === after).length).toBeGreaterThan(BACKGROUND_WHILE_SIGNALING);
      expect(inMinute(after, true) + inMinute(after, false)).toBe(REQUESTS_PER_MINUTE);
    } finally { vi.useRealTimers(); }
  });

  it("lets a community door read its knock bell while a link signals, within the background share", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { log, edge, relay, setBackground } = counting();
      const start = Date.now();
      // The door has just let someone in: that person's edges signal, polling fast.
      const bells: number[] = [];
      for (let t = 0; t < 30_000; t += 1_000) {
        vi.setSystemTime(start + t);
        if (t % 2_000 === 0) { setBackground(false); await edge.resolve(id.pubKeyZ32, { urgent: true }); }
        // The door reads its bell every 4 s (knockPollMs), the next person's knock due any moment.
        if (t % 4_000 === 0) {
          setBackground(true);
          await relay.resolve(id.pubKeyZ32, { background: true, group: true, door: true }).then(() => bells.push(t), () => {});
        }
      }
      // Every look at the bell went: more than the small share a minute's background has while a link signals.
      expect(bells).toHaveLength(8);
      expect(log.filter((r) => r.background)).toHaveLength(8);
      // Other background looks still wait for the signaling to end.
      vi.setSystemTime(start + 30_000);
      await expect(relay.resolve(createIdentity().pubKeyZ32, { background: true, group: true })).rejects.toBeInstanceOf(DiscoveryBudgetError);
    } finally { vi.useRealTimers(); }
  });

  it("keeps a community door's bell within the background share of the minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { log, relay, setBackground } = counting();
      setBackground(true);
      for (let i = 0; i < BACKGROUND_REQUESTS_PER_MINUTE + 5; i++) await relay.resolve(id.pubKeyZ32, { background: true, group: true, door: true }).catch(() => {});
      expect(log).toHaveLength(BACKGROUND_REQUESTS_PER_MINUTE);
    } finally { vi.useRealTimers(); }
  });
});

describe("relay transport: a relay that held a packet back gets it later", () => {
  // Bug hunt r7a: a packet one relay took and the other's budget refused was never put there, so that relay kept the
  // key's older packet; an app that restarted and read it first answered a contact's offer long answered.
  const id = createIdentity(), other = createIdentity();
  function twoRelays() {
    const log: { host: string; method: string; key: string; body?: Uint8Array }[] = [];
    const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test", "https://relay.pkarr.org"], fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      log.push({ host: url.host, method: init?.method ?? "GET", key: url.pathname.slice(1), body: init?.body as Uint8Array | undefined });
      return init?.method === "PUT" ? new Response(null, { status: 204 }) : new Response(null, { status: 404 });
    }) as typeof fetch });
    return { relay, log };
  }
  const putsOf = (log: ReturnType<typeof twoRelays>["log"], host: string) => log.filter(r => r.method === "PUT" && r.host === host && r.key === id.pubKeyZ32);
  /** relay.pkarr.org takes 5 requests a minute: spent on reads of another key. */
  async function spendSmallRelay(relay: RelayTransport) {
    for (let i = 0; i < 12; i++) await relay.resolve(other.pubKeyZ32).catch(() => {});
  }

  it("puts the newest packet there once its budget frees, once", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const { relay, log } = twoRelays();
      await spendSmallRelay(relay);
      await relay.publish(id, [{ label: "_ts", value: "1" }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(putsOf(log, "a.test")).toHaveLength(1);
      expect(putsOf(log, "relay.pkarr.org"), "held back there").toHaveLength(0);
      await vi.advanceTimersByTimeAsync(65_000);
      const late = putsOf(log, "relay.pkarr.org");
      expect(late, "put there once the minute freed a request").toHaveLength(1);
      expect(late[0].body).toEqual(putsOf(log, "a.test")[0].body);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(putsOf(log, "relay.pkarr.org"), "and only once").toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("drops it when a newer packet of the key goes out meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const { relay, log } = twoRelays();
      await spendSmallRelay(relay);
      await relay.publish(id, [{ label: "_ts", value: "1" }]);
      await vi.advanceTimersByTimeAsync(5_000);
      // Still held back there: the newer packet replaces the one waiting, and only it goes there once the minute frees.
      await relay.publish(id, [{ label: "_ts", value: "2" }]);
      await vi.advanceTimersByTimeAsync(120_000);
      const there = putsOf(log, "relay.pkarr.org");
      expect(there).toHaveLength(1);
      expect(there[0].body).toEqual(putsOf(log, "a.test")[1].body);
    } finally { vi.useRealTimers(); }
  });
});

describe("relay transport: a chat's offer or answer goes over a spent minute", () => {
  // mx-d707d8d5 (2026-09-30): the pairing and the texts over the DHT spent the extension's minute on the one relay, and
  // leaving DHT only then held the chat's offer or answer (or its reads for the answer) 40 s, while the contact's
  // attempt gave up: "On DHT · retrying live" 46 times in 120. Its signaling now has a small allowance past the limit.
  const id = createIdentity();
  const allowance = Math.floor(REQUESTS_PER_MINUTE * SIGNALING_ALLOWANCE_SHARE);
  function counting(relays = ["https://a.test"]) {
    const log: string[] = [];
    const relay = new RelayTransport({ freshReadMs: 0, relays, fetch: (async (_: RequestInfo | URL, init?: RequestInit) => {
      log.push(init?.method ?? "GET");
      return init?.method === "PUT" ? new Response(null, { status: 204 }) : new Response(createRelayPayload(id, [{ label: "_ts", value: "1" }], 3n) as BodyInit);
    }) as typeof fetch });
    /** Whether the request reached the relay (a read the budget holds back answers from memory, with no request). */
    const went = async (request: () => Promise<unknown>) => { const before = log.length; await request().catch(() => {}); return log.length > before; };
    return { relay, log, went };
  }
  async function spendTheMinute(relay: RelayTransport, n = REQUESTS_PER_MINUTE) {
    for (let i = 0; i < n; i++) await relay.resolve(id.pubKeyZ32);
  }
  const write = (relay: PkarrTransport, signal = true) => () => relay.publish(createIdentity(), [{ label: "_ts", value: "1" }], signal ? { signal } : undefined);
  const read = (relay: RelayTransport, options = { urgent: true, signal: true }) => () => relay.resolve(id.pubKeyZ32, options);

  it("lets a chat's offer or answer go at once, up to its allowance, while everything else waits", async () => {
    const { relay, log, went } = counting();
    await spendTheMinute(relay);
    // Ordinary requests wait, as before…
    expect(await went(read(relay, { urgent: true, signal: false }))).toBe(false);
    expect(await went(write(relay, false))).toBe(false);
    // …the signaling goes, a fifth of the minute more, and never beyond.
    expect(allowance).toBe(6);
    for (let i = 0; i < allowance; i++) expect(await went(write(relay))).toBe(true);
    expect(await went(write(relay))).toBe(false);
    expect(log).toHaveLength(REQUESTS_PER_MINUTE + allowance);
  });

  it("gives the reads for an answer all but the last of it, which a write still takes", async () => {
    const { relay, log, went } = counting();
    await spendTheMinute(relay);
    for (let i = 0; i < allowance - 1; i++) expect(await went(read(relay))).toBe(true);
    expect(await went(read(relay))).toBe(false);
    expect(await went(write(relay))).toBe(true);
    expect(log.slice(REQUESTS_PER_MINUTE)).toEqual([...Array(allowance - 1).fill("GET"), "PUT"]);
  });

  it("is a chat's alone: a group's edge or a background request that says signal waits like the rest", async () => {
    const { relay, went } = counting();
    await spendTheMinute(relay);
    expect(await went(write(withRequestOptions(relay, { group: true })))).toBe(false);
    expect(await went(read(relay, { background: true, signal: true } as { urgent: boolean; signal: boolean }))).toBe(false);
  });

  it("is sized by each relay's own share: one more on relay.pkarr.org (5 of its 10), for a write only", async () => {
    const { relay, log, went } = counting(["https://relay.pkarr.org"]);
    await spendTheMinute(relay, 5);
    expect(await went(read(relay))).toBe(false);
    expect(await went(write(relay))).toBe(true);
    expect(await went(write(relay))).toBe(false);
    expect(log).toHaveLength(6);
  });
});
