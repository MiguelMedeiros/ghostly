import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BATCH_CAPABILITY_TTL_MS,
  BATCH_MAX_KEYS,
  BREAKER_THRESHOLD,
  BatchCapabilityCache,
  DiscoveryBudgetError,
  FRESH_READ_MS,
  HEDGE_MS,
  PKARR_FUTURE_SKEW_MS,
  RelayTransport,
  batchResponseMaxBytes,
  createIdentity,
  createRelayPayload,
  encodeBatchRequest,
  isBatchUnsupportedStatus,
  parseBatchResponse,
  toBase64,
  utf8Encode,
} from "../src";

// covers: core.relay-client, core.relay-breaker

afterEach(() => {
  vi.useRealTimers();
});

const makePacket = (id: ReturnType<typeof createIdentity>, micros: bigint, value = String(micros)) =>
  createRelayPayload(id, [{ label: "_ts", value }], micros);

/** In-memory batch-capable Pkarr relay for tests. */
function batchRelayFetch(options: {
  packets?: Map<string, Uint8Array>;
  batchStatus?: number;
  onRequest?: (info: { host: string; method: string; path: string; keys?: string[]; signal?: AbortSignal | null }) => Response | Promise<Response> | void;
} = {}): typeof fetch {
  const packets = options.packets ?? new Map<string, Uint8Array>();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname;
    let keys: string[] | undefined;
    if (method === "POST" && path.endsWith("/batch") && typeof init?.body === "string") {
      try { keys = (JSON.parse(init.body) as { keys?: string[] }).keys; } catch { /* leave undefined */ }
    }
    const override = await options.onRequest?.({ host: url.host, method, path, keys, signal: init?.signal });
    if (override) return override;

    if (method === "POST" && path.endsWith("/batch")) {
      if (options.batchStatus !== undefined && options.batchStatus !== 200) {
        return new Response(null, { status: options.batchStatus });
      }
      const out: Record<string, string | null> = {};
      for (const k of keys ?? []) {
        const bytes = packets.get(k);
        out[k] = bytes ? toBase64(bytes) : null;
      }
      return new Response(JSON.stringify({ packets: out }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const key = path.slice(path.lastIndexOf("/") + 1);
    const bytes = packets.get(key);
    return bytes ? new Response(bytes as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
  }) as typeof fetch;
}

describe("relay batch wire helpers", () => {
  it("encodes batch requests and parses valid, missing, omitted, and invalid per-key entries", () => {
    const a = createIdentity(), b = createIdentity(), c = createIdentity(), d = createIdentity(), extra = createIdentity();
    const validA = makePacket(a, 1000n);
    const forgedC = makePacket(extra, 2000n); // signed by wrong key

    expect(encodeBatchRequest([a.pubKeyZ32, b.pubKeyZ32])).toBe(JSON.stringify({ keys: [a.pubKeyZ32, b.pubKeyZ32] }));

    const body = utf8Encode(JSON.stringify({
      packets: {
        [a.pubKeyZ32]: toBase64(validA),
        [b.pubKeyZ32]: null,
        [c.pubKeyZ32]: toBase64(forgedC),
        [extra.pubKeyZ32]: toBase64(makePacket(extra, 3000n)),
      },
    }));

    const parsed = parseBatchResponse([a.pubKeyZ32, b.pubKeyZ32, c.pubKeyZ32, d.pubKeyZ32], body);
    expect(parsed.size).toBe(4);
    expect(parsed.get(a.pubKeyZ32)).toMatchObject({ kind: "packet", packet: { pubKeyZ32: a.pubKeyZ32, timestampMicros: 1000n } });
    expect(parsed.get(b.pubKeyZ32)).toEqual({ kind: "missing" });
    expect(parsed.get(c.pubKeyZ32)).toEqual({ kind: "invalid" });
    expect(parsed.get(d.pubKeyZ32)).toEqual({ kind: "missing" });
    expect(parsed.has(extra.pubKeyZ32)).toBe(false);
  });

  it("rejects malformed outer JSON envelopes and invalid per-key values", () => {
    const a = createIdentity();
    for (const bad of ["not json", "null", "[]", "{}", '{"packets":null}', '{"packets":[]}', '{"packets":"nope"}']) {
      expect(() => parseBatchResponse([a.pubKeyZ32], utf8Encode(bad))).toThrow();
    }

    for (const badValue of ["", "!!!not-base64!!!", 123, true, {}, [], "A".repeat(2000)]) {
      const body = utf8Encode(JSON.stringify({ packets: { [a.pubKeyZ32]: badValue } }));
      expect(parseBatchResponse([a.pubKeyZ32], body).get(a.pubKeyZ32)).toEqual({ kind: "invalid" });
    }
  });

  it("identifies unsupported statuses and caches capability with TTL and backward clock safety", () => {
    expect(isBatchUnsupportedStatus(404)).toBe(true);
    expect(isBatchUnsupportedStatus(405)).toBe(true);
    expect(isBatchUnsupportedStatus(501)).toBe(true);
    for (const other of [200, 400, 403, 429, 500, 502, 503]) expect(isBatchUnsupportedStatus(other)).toBe(false);

    const cache = new BatchCapabilityCache(10_000);
    expect(cache.get("https://a.test", 1_000)).toBe("unknown");
    cache.mark("https://a.test", false, 1_000);
    expect(cache.get("https://a.test", 10_999)).toBe("unsupported");
    // Expires at TTL
    expect(cache.get("https://a.test", 11_000)).toBe("unknown");
    // Clock step backward expires safely
    cache.mark("https://a.test", true, 20_000);
    expect(cache.get("https://a.test", 19_999)).toBe("unknown");
    // Prune drops removed relays
    cache.mark("https://a.test", true, 30_000);
    cache.mark("https://b.test", false, 30_000);
    cache.prune(new Set(["https://a.test"]));
    expect(cache.get("https://a.test", 30_001)).toBe("supported");
    expect(cache.get("https://b.test", 30_001)).toBe("unknown");
  });
});

describe("RelayTransport batch GET coalescing", () => {
  it("uses plain GET for single isolated reads and coalesces concurrent reads into one POST /batch", async () => {
    const ids = Array.from({ length: 6 }, () => createIdentity());
    const packets = new Map(ids.map((id, i) => [id.pubKeyZ32, makePacket(id, BigInt(1000 + i))]));
    const seen: { method: string; path: string; keys?: string[] }[] = [];

    const relay = new RelayTransport({
      freshReadMs: 0,
      relays: ["https://batch.test"],
      fetch: batchRelayFetch({ packets, onRequest: (r) => { seen.push({ method: r.method, path: r.path, keys: r.keys }); } }),
      log: () => {},
    });

    // Single isolated read: plain GET, never POST /batch.
    const single = await relay.resolve(ids[0].pubKeyZ32);
    expect(single?.timestampMicros).toBe(1000n);
    expect(seen).toEqual([{ method: "GET", path: `/${ids[0].pubKeyZ32}`, keys: undefined }]);

    // Six concurrent reads in one tick: coalesced into 1 POST /batch!
    seen.length = 0;
    const results = await Promise.all(ids.map((id) => relay.resolve(id.pubKeyZ32)));
    expect(results.map((r) => r?.timestampMicros)).toEqual([1000n, 1001n, 1002n, 1003n, 1004n, 1005n]);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].path).toBe("/batch");
    expect(seen[0].keys).toEqual(ids.map((id) => id.pubKeyZ32));
    expect(relay.batchSupport("https://batch.test")).toBe("supported");
  });

  it("deduplicates concurrent reads of the same key on the wire", async () => {
    const a = createIdentity(), b = createIdentity();
    const packets = new Map([
      [a.pubKeyZ32, makePacket(a, 5000n)],
      [b.pubKeyZ32, makePacket(b, 6000n)],
    ]);
    const seen: { method: string; path: string; keys?: string[] }[] = [];

    const relay = new RelayTransport({
      freshReadMs: 0,
      relays: ["https://batch.test"],
      fetch: batchRelayFetch({ packets, onRequest: (r) => { seen.push({ method: r.method, path: r.path, keys: r.keys }); } }),
      log: () => {},
    });

    // Two concurrent reads of only key A -> 1 single GET, both callers get the packet.
    const [r1, r2] = await Promise.all([relay.resolve(a.pubKeyZ32), relay.resolve(a.pubKeyZ32)]);
    expect(r1?.timestampMicros).toBe(5000n);
    expect(r2?.timestampMicros).toBe(5000n);
    expect(seen).toEqual([{ method: "GET", path: `/${a.pubKeyZ32}`, keys: undefined }]);

    // Duplicate key A alongside key B -> 1 POST /batch with [A, B] (no duplicate A).
    seen.length = 0;
    const [ra1, ra2, rb] = await Promise.all([
      relay.resolve(a.pubKeyZ32),
      relay.resolve(a.pubKeyZ32),
      relay.resolve(b.pubKeyZ32),
    ]);
    expect([ra1?.timestampMicros, ra2?.timestampMicros, rb?.timestampMicros]).toEqual([5000n, 5000n, 6000n]);
    expect(seen).toHaveLength(1);
    expect(seen[0].keys).toEqual([a.pubKeyZ32, b.pubKeyZ32]);
  });

  it("splits concurrent reads past BATCH_MAX_KEYS into bounded batches", async () => {
    const total = BATCH_MAX_KEYS + 6;
    const ids = Array.from({ length: total }, () => createIdentity());
    const packets = new Map(ids.map((id, i) => [id.pubKeyZ32, makePacket(id, BigInt(100 + i))]));
    const batchSizes: number[] = [];

    const relay = new RelayTransport({
      freshReadMs: 0,
      relays: ["https://batch.test"],
      fetch: batchRelayFetch({
        packets,
        onRequest: (r) => {
          if (r.method === "POST") batchSizes.push(r.keys?.length ?? 0);
        },
      }),
      log: () => {},
    });

    const results = await Promise.all(ids.map((id) => relay.resolve(id.pubKeyZ32)));
    expect(results.every((r, i) => r?.timestampMicros === BigInt(100 + i))).toBe(true);
    expect(batchSizes).toEqual([BATCH_MAX_KEYS, 6]);
  });

  it("coalesces reads arriving within batchWindowMs and flushes early when full", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const ids = Array.from({ length: 4 }, () => createIdentity());
    const packets = new Map(ids.map((id, i) => [id.pubKeyZ32, makePacket(id, BigInt(10 + i))]));
    const batchSizes: number[] = [];

    const relay = new RelayTransport({
      freshReadMs: 0,
      batchWindowMs: 25,
      batchMaxKeys: 3,
      relays: ["https://batch.test"],
      fetch: batchRelayFetch({
        packets,
        onRequest: (r) => {
          if (r.method === "POST") batchSizes.push(r.keys?.length ?? 0);
          else batchSizes.push(1);
        },
      }),
      log: () => {},
    });

    // Two keys arrive 10 ms apart -> coalesced when the 25 ms window expires.
    const p1 = relay.resolve(ids[0].pubKeyZ32);
    await vi.advanceTimersByTimeAsync(10);
    const p2 = relay.resolve(ids[1].pubKeyZ32);
    expect(batchSizes).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    expect((await p1)?.timestampMicros).toBe(10n);
    expect((await p2)?.timestampMicros).toBe(11n);
    expect(batchSizes).toEqual([2]);

    // Three keys (= batchMaxKeys) arrive at once -> flushes immediately without waiting 25 ms!
    batchSizes.length = 0;
    const pAll = Promise.all([relay.resolve(ids[0].pubKeyZ32), relay.resolve(ids[1].pubKeyZ32), relay.resolve(ids[2].pubKeyZ32)]);
    await vi.advanceTimersByTimeAsync(0);
    expect((await pAll).map((r) => r?.timestampMicros)).toEqual([10n, 11n, 12n]);
    expect(batchSizes).toEqual([3]);
  });

  it("handles partial hits, misses, omitted keys, timestamp freshness, and FRESH_READ_MS cache", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = BigInt(Date.now()) * 1000n;
    const hit = createIdentity(), missNull = createIdentity(), missOmitted = createIdentity(), skew = createIdentity();
    const farFuture = now + BigInt(PKARR_FUTURE_SKEW_MS + 600_000) * 1000n;

    let round = 0;
    let requests = 0;
    const relay = new RelayTransport({
      relays: ["https://batch.test"],
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests++;
        const { keys } = JSON.parse(init!.body as string) as { keys: string[] };
        const out: Record<string, string | null> = {};
        for (const k of keys) {
          if (k === hit.pubKeyZ32) out[k] = toBase64(makePacket(hit, round === 0 ? 5000n : 2000n));
          else if (k === missNull.pubKeyZ32) out[k] = null;
          else if (k === skew.pubKeyZ32) out[k] = toBase64(makePacket(skew, round === 0 ? farFuture : now));
          // missOmitted intentionally omitted from response
        }
        return new Response(JSON.stringify({ packets: out }), { status: 200 });
      }) as typeof fetch,
      log: () => {},
    });

    const [rHit, rNull, rOmitted, rSkew] = await Promise.all([
      relay.resolve(hit.pubKeyZ32),
      relay.resolve(missNull.pubKeyZ32),
      relay.resolve(missOmitted.pubKeyZ32),
      relay.resolve(skew.pubKeyZ32),
    ]);
    expect(rHit?.timestampMicros).toBe(5000n);
    expect(rNull).toBeNull();
    expect(rOmitted).toBeNull();
    expect(rSkew?.timestampMicros).toBe(farFuture);
    expect(relay.lastReadMissing(missNull.pubKeyZ32)).toBe(true);
    expect(relay.lastReadMissing(missOmitted.pubKeyZ32)).toBe(true);
    expect(relay.lastReadMissing(hit.pubKeyZ32)).toBe(false);
    expect(requests).toBe(1);

    // Within FRESH_READ_MS: served from memory with zero HTTP requests.
    vi.setSystemTime(Date.now() + FRESH_READ_MS - 1);
    expect((await relay.resolve(hit.pubKeyZ32))?.timestampMicros).toBe(5000n);
    expect(requests).toBe(1);

    // After FRESH_READ_MS: older packet never replaces newer (5000n stays over 2000n),
    // and present packet beats far-ahead packet (PKARR_FUTURE_SKEW_MS).
    round = 1;
    vi.setSystemTime(Date.now() + 2);
    const [rHit2, rSkew2] = await Promise.all([relay.resolve(hit.pubKeyZ32), relay.resolve(skew.pubKeyZ32)]);
    expect(rHit2?.timestampMicros).toBe(5000n);
    expect(rSkew2?.timestampMicros).toBe(now);
    expect(requests).toBe(2);
  });

  it("can be disabled explicitly via batch: false", async () => {
    const ids = [createIdentity(), createIdentity(), createIdentity()];
    const packets = new Map(ids.map((id, i) => [id.pubKeyZ32, makePacket(id, BigInt(10 + i))]));
    const methods: string[] = [];

    const relay = new RelayTransport({
      freshReadMs: 0,
      batch: false,
      relays: ["https://batch.test"],
      fetch: batchRelayFetch({ packets, onRequest: (r) => { methods.push(r.method); } }),
      log: () => {},
    });

    const results = await Promise.all(ids.map((id) => relay.resolve(id.pubKeyZ32)));
    expect(results.map((r) => r?.timestampMicros)).toEqual([10n, 11n, 12n]);
    expect(methods).toEqual(["GET", "GET", "GET"]);
  });
});

describe("RelayTransport batch capability detection & HTTP fallback", () => {
  for (const status of [404, 405, 501] as const) {
    it(`falls back seamlessly to single GET on HTTP ${status} and caches single-GET capability with TTL`, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const ids = Array.from({ length: 4 }, () => createIdentity());
      const packets = new Map(ids.map((id, i) => [id.pubKeyZ32, makePacket(id, BigInt(100 + i))]));
      let batchStatus: number = status;
      const seen: { method: string; path: string }[] = [];

      const relay = new RelayTransport({
        freshReadMs: 0,
        relays: ["https://legacy.test"],
        fetch: batchRelayFetch({
          packets,
          onRequest: (r) => {
            seen.push({ method: r.method, path: r.path });
            if (r.method === "POST" && batchStatus !== 200) return new Response(null, { status: batchStatus });
          },
        }),
        log: () => {},
      });

      // Round 1: tries POST /batch once -> gets 404/405/501 -> falls back to individual GETs.
      const r1 = await Promise.all([relay.resolve(ids[0].pubKeyZ32), relay.resolve(ids[1].pubKeyZ32)]);
      expect(r1.map((p) => p?.timestampMicros)).toEqual([100n, 101n]);
      expect(seen.map((s) => s.method)).toEqual(["POST", "GET", "GET"]);
      expect(relay.batchSupport("https://legacy.test")).toBe("unsupported");
      // Unsupported /batch never trips or penalizes the circuit breaker.
      expect(relay.discovery().relays[0].state).toBe("ok");

      // Round 2 (within TTL): zero POST /batch attempts, straight to GET!
      seen.length = 0;
      const r2 = await Promise.all([relay.resolve(ids[2].pubKeyZ32), relay.resolve(ids[3].pubKeyZ32)]);
      expect(r2.map((p) => p?.timestampMicros)).toEqual([102n, 103n]);
      expect(seen.map((s) => s.method)).toEqual(["GET", "GET"]);

      // After TTL expires (relay upgraded to support /batch): re-detects and uses POST /batch!
      batchStatus = 200;
      vi.setSystemTime(Date.now() + BATCH_CAPABILITY_TTL_MS);
      seen.length = 0;
      const r3 = await Promise.all([relay.resolve(ids[0].pubKeyZ32), relay.resolve(ids[1].pubKeyZ32)]);
      expect(r3.map((p) => p?.timestampMicros)).toEqual([100n, 101n]);
      expect(seen.map((s) => s.method)).toEqual(["POST"]);
      expect(relay.batchSupport("https://legacy.test")).toBe("supported");
    });
  }

  it("clears cached capability on networkChanged() so relays are re-detected", async () => {
    const a = createIdentity(), b = createIdentity();
    const packets = new Map([[a.pubKeyZ32, makePacket(a, 1n)], [b.pubKeyZ32, makePacket(b, 2n)]]);
    let batchEnabledOnServer = false;
    const methods: string[] = [];

    const relay = new RelayTransport({
      freshReadMs: 0,
      relays: ["https://edge.test"],
      fetch: batchRelayFetch({
        packets,
        onRequest: (r) => {
          methods.push(r.method);
          if (r.method === "POST" && !batchEnabledOnServer) return new Response(null, { status: 405 });
        },
      }),
      log: () => {},
    });

    await Promise.all([relay.resolve(a.pubKeyZ32), relay.resolve(b.pubKeyZ32)]);
    expect(relay.batchSupport("https://edge.test")).toBe("unsupported");

    batchEnabledOnServer = true;
    relay.networkChanged();
    expect(relay.batchSupport("https://edge.test")).toBe("unknown");

    methods.length = 0;
    const res = await Promise.all([relay.resolve(a.pubKeyZ32), relay.resolve(b.pubKeyZ32)]);
    expect(res.map((p) => p?.timestampMicros)).toEqual([1n, 2n]);
    expect(methods).toEqual(["POST"]);
    expect(relay.batchSupport("https://edge.test")).toBe("supported");
  });
});

describe("RelayTransport batch security, budget, errors, and hedging", () => {
  it("verifies Ed25519 signature per key: valid siblings succeed while a forged key fails over to the next relay", async () => {
    const good = createIdentity(), target = createIdentity(), attacker = createIdentity(), missing = createIdentity();
    const goodBytes = makePacket(good, 100n);
    const targetRealBytes = makePacket(target, 200n);
    const targetForgedBytes = makePacket(attacker, 999n);

    const calls: string[] = [];
    const relay = new RelayTransport({
      freshReadMs: 0,
      relays: ["https://bad-sig.test", "https://honest.test"],
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push(`${url.host}:${init?.method ?? "GET"}:${url.pathname}`);
        if (url.host === "bad-sig.test" && init?.method === "POST") {
          return new Response(JSON.stringify({
            packets: {
              [good.pubKeyZ32]: toBase64(goodBytes),
              [target.pubKeyZ32]: toBase64(targetForgedBytes),
              [missing.pubKeyZ32]: null,
            },
          }), { status: 200 });
        }
        if (url.host === "honest.test") {
          if (init?.method === "POST") {
            return new Response(JSON.stringify({
              packets: { [target.pubKeyZ32]: toBase64(targetRealBytes) },
            }), { status: 200 });
          }
          const key = url.pathname.slice(1);
          if (key === target.pubKeyZ32) return new Response(targetRealBytes as BodyInit, { status: 200 });
        }
        return new Response(null, { status: 404 });
      }) as typeof fetch,
      log: () => {},
    });

    // Pin all three keys so they start at bad-sig.test (seed lastReadFrom = honest.test so next turn is bad-sig.test).
    const readFrom = (relay as unknown as { lastReadFrom: Map<string, string> }).lastReadFrom;
    for (const k of [good.pubKeyZ32, target.pubKeyZ32, missing.pubKeyZ32]) readFrom.set(k, "https://honest.test");

    const [rGood, rTarget, rMissing] = await Promise.all([
      relay.resolve(good.pubKeyZ32),
      relay.resolve(target.pubKeyZ32),
      relay.resolve(missing.pubKeyZ32),
    ]);

    expect(rGood?.timestampMicros).toBe(100n);
    expect(rTarget?.timestampMicros).toBe(200n);
    expect(rMissing).toBeNull();
    // bad-sig.test handled the batch; only target failed over to honest.test!
    expect(calls).toEqual([
      "bad-sig.test:POST:/batch",
      `honest.test:GET:/${target.pubKeyZ32}`,
    ]);
  });

  it("counts a coalesced batch as 1 HTTP request against the relay budget, and isolates budget lanes", async () => {
    const ids = Array.from({ length: 10 }, () => createIdentity());
    const packets = new Map(ids.map((id, i) => [id.pubKeyZ32, makePacket(id, BigInt(10 + i))]));
    let httpRequests = 0;

    // Tiny budget: 2 requests/minute total on one relay.
    const relay = new RelayTransport({
      freshReadMs: 0,
      requestsPerMinute: 2,
      relays: ["https://batch.test"],
      fetch: batchRelayFetch({ packets, onRequest: () => { httpRequests++; } }),
      log: () => {},
    });

    // Batch 1: 10 keys coalesced -> spends 1 of 2 requests!
    const round1 = await Promise.all(ids.map((id) => relay.resolve(id.pubKeyZ32)));
    expect(round1.every((r, i) => r?.timestampMicros === BigInt(10 + i))).toBe(true);
    expect(httpRequests).toBe(1);

    // Batch 2: 10 more keys coalesced -> spends 2 of 2 requests!
    const round2 = await Promise.all(ids.map((id) => relay.resolve(id.pubKeyZ32)));
    expect(round2.every((r, i) => r?.timestampMicros === BigInt(10 + i))).toBe(true);
    expect(httpRequests).toBe(2);

    // Batch 3: minute is spent -> held back by budget (0 more HTTP requests).
    const freshKey = createIdentity().pubKeyZ32;
    await expect(relay.resolve(freshKey)).rejects.toBeInstanceOf(DiscoveryBudgetError);
    expect(httpRequests).toBe(2);

    // Verify background lane cannot piggyback onto a chat lane batch past its background share.
    let laneRequests = 0;
    const laneRelay = new RelayTransport({
      freshReadMs: 0,
      requestsPerMinute: 3, // background share = ceil(3 * 2/3) = 2
      relays: ["https://lane.test"],
      fetch: batchRelayFetch({ packets, onRequest: () => { laneRequests++; } }),
      log: () => {},
    });
    // Spend both background slots.
    await laneRelay.resolve(ids[0].pubKeyZ32, { background: true });
    await laneRelay.resolve(ids[1].pubKeyZ32, { background: true });
    expect(laneRequests).toBe(2);

    // Now a chat read + a new background read arrive concurrently: chat goes through (slot 3),
    // background read MUST NOT piggyback onto the chat batch!
    const unknownBg = createIdentity().pubKeyZ32;
    const [chatRes, bgOutcome] = await Promise.all([
      laneRelay.resolve(ids[2].pubKeyZ32),
      laneRelay.resolve(unknownBg, { background: true }).then(() => "ok", (err) => err),
    ]);
    expect(chatRes?.timestampMicros).toBe(12n);
    expect(bgOutcome).toBeInstanceOf(DiscoveryBudgetError);
    expect(laneRequests).toBe(3);
  });

  it("handles malformed JSON, oversized batch bodies, 429, and 5xx cleanly without over-counting breaker strikes", async () => {
    const ids = Array.from({ length: 5 }, () => createIdentity());
    const packets = new Map(ids.map((id, i) => [id.pubKeyZ32, makePacket(id, BigInt(50 + i))]));

    // 1) Malformed JSON on a.test fails over to b.test and counts as ONLY 1 breaker failure (not 5!).
    const malformedRelay = new RelayTransport({
      freshReadMs: 0,
      relays: ["https://bad.test", "https://good.test"],
      fetch: batchRelayFetch({
        packets,
        onRequest: (r) => {
          if (r.host === "bad.test") return new Response("{not-json", { status: 200 });
        },
      }),
      log: () => {},
    });
    const readFrom1 = (malformedRelay as unknown as { lastReadFrom: Map<string, string> }).lastReadFrom;
    for (const id of ids) readFrom1.set(id.pubKeyZ32, "https://good.test");

    const res1 = await Promise.all(ids.map((id) => malformedRelay.resolve(id.pubKeyZ32)));
    expect(res1.map((p) => p?.timestampMicros)).toEqual([50n, 51n, 52n, 53n, 54n]);
    // 5 keys in 1 bad batch = 1 strike < BREAKER_THRESHOLD (3), so bad.test is NOT tripped yet.
    expect(BREAKER_THRESHOLD).toBe(3);
    expect(malformedRelay.discovery().relays.find((r) => r.relay === "https://bad.test")?.state).toBe("ok");

    // 2) Oversized response body (> batchResponseMaxBytes) rejected before filling memory, fails over to good.test.
    const oversizedRelay = new RelayTransport({
      freshReadMs: 0,
      relays: ["https://huge.test", "https://good.test"],
      fetch: batchRelayFetch({
        packets,
        onRequest: (r) => {
          if (r.host === "huge.test") {
            return new Response(new Uint8Array(10), {
              status: 200,
              headers: { "content-length": String(batchResponseMaxBytes(ids.length) + 1) },
            });
          }
        },
      }),
      log: () => {},
    });
    const readFrom2 = (oversizedRelay as unknown as { lastReadFrom: Map<string, string> }).lastReadFrom;
    for (const id of ids) readFrom2.set(id.pubKeyZ32, "https://good.test");
    const res2 = await Promise.all(ids.map((id) => oversizedRelay.resolve(id.pubKeyZ32)));
    expect(res2.map((p) => p?.timestampMicros)).toEqual([50n, 51n, 52n, 53n, 54n]);

    // 3) 429 on POST /batch cools down relay, does NOT mark batch unsupported, and fails over cleanly.
    const throttledRelay = new RelayTransport({
      freshReadMs: 0,
      relays: ["https://busy.test", "https://good.test"],
      fetch: batchRelayFetch({
        packets,
        onRequest: (r) => {
          if (r.host === "busy.test") return new Response(null, { status: 429, headers: { "retry-after": "30" } });
        },
      }),
      log: () => {},
    });
    const readFrom3 = (throttledRelay as unknown as { lastReadFrom: Map<string, string> }).lastReadFrom;
    for (const id of ids) readFrom3.set(id.pubKeyZ32, "https://good.test");
    const res3 = await Promise.all(ids.map((id) => throttledRelay.resolve(id.pubKeyZ32)));
    expect(res3.map((p) => p?.timestampMicros)).toEqual([50n, 51n, 52n, 53n, 54n]);
    expect(throttledRelay.batchSupport("https://busy.test")).toBe("unknown");
    expect(throttledRelay.discovery().relays.find((r) => r.relay === "https://busy.test")?.state).toBe("throttled");
  });

  it("aborts the underlying POST /batch only when every waiter aborts, keeping surviving waiters intact during hedging", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const k1 = createIdentity(), k2 = createIdentity();
    const p1Bytes = makePacket(k1, 100n);
    const p2Bytes = makePacket(k2, 200n);

    let slowBatchAborted = false;
    const relay = new RelayTransport({
      freshReadMs: 0,
      relays: ["https://slow.test", "https://fast.test"],
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
        const url = new URL(String(input));
        if (url.host === "slow.test") {
          const timer = setTimeout(() => {
            resolve(new Response(JSON.stringify({
              packets: { [k1.pubKeyZ32]: toBase64(p1Bytes), [k2.pubKeyZ32]: toBase64(p2Bytes) },
            }), { status: 200 }));
          }, 3_500);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            slowBatchAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
          return;
        }
        // fast.test answers k1 quickly, returns 503 for k2 so k2 stays waiting on slow.test!
        const key = url.pathname.slice(1);
        const timer = setTimeout(() => {
          if (key === k1.pubKeyZ32) resolve(new Response(p1Bytes as BodyInit, { status: 200 }));
          else resolve(new Response(null, { status: 503 }));
        }, 50);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as typeof fetch,
      log: () => {},
    });

    // Force both keys to start at slow.test, with k2 already known missing so k2 hedges late while k1 hedges at HEDGE_MS.
    const readFrom = (relay as unknown as { lastReadFrom: Map<string, string> }).lastReadFrom;
    readFrom.set(k1.pubKeyZ32, "https://fast.test");
    readFrom.set(k2.pubKeyZ32, "https://fast.test");
    (relay as unknown as { missing: Set<string> }).missing.add(k2.pubKeyZ32);

    const r1Promise = relay.resolve(k1.pubKeyZ32);
    const r2Promise = relay.resolve(k2.pubKeyZ32);

    // At HEDGE_MS + 100ms, k1 hedges to fast.test and wins, aborting ONLY k1's waiter.
    await vi.advanceTimersByTimeAsync(HEDGE_MS + 100);
    expect((await r1Promise)?.timestampMicros).toBe(100n);
    // slow.test's batch MUST NOT be aborted because k2 is still waiting on it!
    expect(slowBatchAborted).toBe(false);

    // At 3.6s, slow.test finishes the batch and delivers k2's packet!
    await vi.advanceTimersByTimeAsync(2_100);
    expect((await r2Promise)?.timestampMicros).toBe(200n);
    expect(slowBatchAborted).toBe(false);

    // Now make fast.test answer BOTH keys quickly: when both hedge and win, the underlying POST /batch IS aborted!
    let allAborted = false;
    const relay2 = new RelayTransport({
      freshReadMs: 0,
      relays: ["https://slow2.test", "https://fast2.test"],
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
        const url = new URL(String(input));
        if (url.host === "slow2.test") {
          const timer = setTimeout(() => resolve(new Response(JSON.stringify({ packets: {} }), { status: 200 })), 8_000);
          init?.signal?.addEventListener("abort", () => { clearTimeout(timer); allAborted = true; reject(new DOMException("aborted", "AbortError")); });
          return;
        }
        const timer = setTimeout(() => {
          if (init?.method === "POST") {
            resolve(new Response(JSON.stringify({
              packets: { [k1.pubKeyZ32]: toBase64(p1Bytes), [k2.pubKeyZ32]: toBase64(p2Bytes) },
            }), { status: 200 }));
            return;
          }
          const key = url.pathname.slice(1);
          resolve(new Response((key === k1.pubKeyZ32 ? p1Bytes : p2Bytes) as BodyInit, { status: 200 }));
        }, 50);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); });
      })) as typeof fetch,
      log: () => {},
    });
    const readFrom2 = (relay2 as unknown as { lastReadFrom: Map<string, string> }).lastReadFrom;
    readFrom2.set(k1.pubKeyZ32, "https://fast2.test");
    readFrom2.set(k2.pubKeyZ32, "https://fast2.test");

    const both = Promise.all([relay2.resolve(k1.pubKeyZ32), relay2.resolve(k2.pubKeyZ32)]);
    await vi.advanceTimersByTimeAsync(HEDGE_MS + 100);
    expect((await both).map((p) => p?.timestampMicros)).toEqual([100n, 200n]);
    expect(allAborted).toBe(true);
  });

  it("does not let valid siblings erase a forged-packet breaker strike across batches, and falls back across relays when budget is tight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const good = createIdentity(), target = createIdentity(), attacker = createIdentity();
    const goodBytes = makePacket(good, 100n), targetBytes = makePacket(target, 200n), forgedBytes = makePacket(attacker, 300n);

    // Three consecutive batches with a forged packet for `target` alongside valid `good` must trip bad.test.
    const relay = new RelayTransport({
      freshReadMs: 0,
      relays: ["https://bad.test", "https://good.test"],
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.host === "bad.test" && init?.method === "POST") {
          return new Response(JSON.stringify({
            packets: { [good.pubKeyZ32]: toBase64(goodBytes), [target.pubKeyZ32]: toBase64(forgedBytes) },
          }), { status: 200 });
        }
        const key = url.pathname.slice(1);
        return new Response((key === good.pubKeyZ32 ? goodBytes : targetBytes) as BodyInit, { status: 200 });
      }) as typeof fetch,
      log: () => {},
    });
    const readFrom = (relay as unknown as { lastReadFrom: Map<string, string> }).lastReadFrom;
    for (let i = 0; i < BREAKER_THRESHOLD; i++) {
      // Advance past network cooldown so bad.test is tried again on each round.
      if (i > 0) vi.setSystemTime(Date.now() + 25_000);
      readFrom.set(good.pubKeyZ32, "https://good.test");
      readFrom.set(target.pubKeyZ32, "https://good.test");
      const [g, t] = await Promise.all([relay.resolve(good.pubKeyZ32), relay.resolve(target.pubKeyZ32)]);
      expect(g?.timestampMicros).toBe(100n);
      expect(t?.timestampMicros).toBe(200n);
    }
    expect(relay.discovery().relays.find((r) => r.relay === "https://bad.test")?.state).toBe("failing");

    // Tight budget fallback: relay A has requestsPerMinute=2 and returns 405 on POST /batch.
    // 1 POST (405) + 1 GET exhaust A's budget; the remaining keys fail over to relay B!
    const ids = Array.from({ length: 4 }, () => createIdentity());
    const packets = new Map(ids.map((id, i) => [id.pubKeyZ32, makePacket(id, BigInt(10 + i))]));
    const hits: string[] = [];
    const tight = new RelayTransport({
      freshReadMs: 0,
      requestsPerMinute: 2,
      relays: ["https://a.test", "https://b.test"],
      fetch: batchRelayFetch({
        packets,
        onRequest: (r) => {
          hits.push(`${r.host}:${r.method}`);
          if (r.host === "a.test" && r.method === "POST") return new Response(null, { status: 405 });
        },
      }),
      log: () => {},
    });
    const rf = (tight as unknown as { lastReadFrom: Map<string, string> }).lastReadFrom;
    for (const id of ids) rf.set(id.pubKeyZ32, "https://b.test");
    const resolved = await Promise.all(ids.map((id) => tight.resolve(id.pubKeyZ32)));
    expect(resolved.map((p) => p?.timestampMicros)).toEqual([10n, 11n, 12n, 13n]);
    // a.test spent at most its 2-request budget (1 POST 405 + 1 fallback GET); b.test served the rest!
    expect(hits.filter((h) => h.startsWith("a.test:"))).toEqual(["a.test:POST", "a.test:GET"]);
    expect(hits.some((h) => h.startsWith("b.test:"))).toBe(true);
  });
});
