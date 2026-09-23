import { describe, expect, it } from "vitest";
import { RelayTransport, createIdentity, createRelayPayload } from "../src";

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
