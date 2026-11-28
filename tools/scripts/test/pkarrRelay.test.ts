import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createIdentity } from "../../../packages/core/src/identity";
import { createRelayPayload, parseRelayPayload } from "../../../packages/core/src/pkarr";
import {
  comparePacketSeq,
  decodeZ32PublicKey,
  DEFAULT_LIMITS,
  encodeZ32,
  isValidZ32,
  limitVariable,
  listenProblem,
  rateKey,
  readSettings,
  RELAY_PAYLOAD_MAX_BYTES,
  startRelay,
  verifyPkarrPacket,
} from "../../../infra/services/pkarr-relay/relay.mjs";

type RelayHandle = Awaited<ReturnType<typeof startRelay>>;

/** Mock upstream Pkarr relay for integration tests. */
async function startMockUpstream(handler?: (req: IncomingMessage, res: ServerResponse, store: Map<string, Buffer>) => void | Promise<void>) {
  const store = new Map<string, Buffer>();
  const stats = { gets: 0, puts: 0, paths: [] as string[] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://upstream");
    const key = url.pathname.slice(1);
    stats.paths.push(req.url ?? "/");
    if (handler) {
      await handler(req, res, store);
      return;
    }
    if (req.method === "PUT") {
      stats.puts++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const existing = store.get(key);
      if (existing && body.readBigUInt64BE(64) < existing.readBigUInt64BE(64)) {
        res.writeHead(409);
        res.end();
        return;
      }
      store.set(key, body);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET") {
      stats.gets++;
      const packet = store.get(key);
      if (!packet) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(packet);
      return;
    }
    res.writeHead(405);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    stats,
    close: () => new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    }),
  };
}

function makePacket(identity = createIdentity(), value = "hello", seq?: bigint) {
  const ts = seq ?? BigInt(Date.now()) * 1000n;
  const payload = Buffer.from(createRelayPayload(identity, [{ label: "_ghostly", value }], ts));
  return { identity, key: identity.pubKeyZ32, seq: ts, payload };
}

async function openWs(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers });
  const messages: Record<string, unknown>[] = [];
  const waiters: Array<(msg: Record<string, unknown>) => void> = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else messages.push(msg);
  });
  await new Promise<void>((resolveOpen, rejectOpen) => {
    ws.once("open", () => resolveOpen());
    ws.once("error", rejectOpen);
  });
  const nextMessage = (timeoutMs = 3000) => {
    if (messages.length > 0) return Promise.resolve(messages.shift()!);
    return new Promise<Record<string, unknown>>((res, rej) => {
      const timer = setTimeout(() => rej(new Error("Timed out waiting for WS message")), timeoutMs);
      waiters.push((msg) => { clearTimeout(timer); res(msg); });
    });
  };
  return { ws, nextMessage };
}

describe("Pkarr relay validation helpers (infra/services/pkarr-relay)", () => {
  it("validates canonical 52-char z-base32 keys and rejects malformed or non-canonical keys", () => {
    const id = createIdentity();
    expect(isValidZ32(id.pubKeyZ32)).toBe(true);
    const decoded = decodeZ32PublicKey(id.pubKeyZ32);
    expect(decoded).not.toBeNull();
    expect(Buffer.from(id.publicKey).equals(decoded!)).toBe(true);
    expect(encodeZ32(decoded!)).toBe(id.pubKeyZ32);

    // Wrong length, uppercase, invalid alphabet chars
    expect(isValidZ32("")).toBe(false);
    expect(isValidZ32(id.pubKeyZ32.slice(0, 51))).toBe(false);
    expect(isValidZ32(`${id.pubKeyZ32}y`)).toBe(false);
    expect(isValidZ32(id.pubKeyZ32.toUpperCase())).toBe(false);
    expect(isValidZ32("l".repeat(52))).toBe(false);
    expect(isValidZ32("__proto__")).toBe(false);

    // Non-canonical trailing 4 bits: replace final char with one whose lower 4 bits are non-zero (index 1 = 'b')
    const nonCanonical = `${id.pubKeyZ32.slice(0, 51)}b`;
    expect(isValidZ32(nonCanonical)).toBe(false);
  });

  it("verifies signed Pkarr packets and rejects tampered, oversize, short, or small-order packets", () => {
    const pkt = makePacket();
    const ok = verifyPkarrPacket(pkt.key, pkt.payload);
    expect(ok.ok).toBe(true);
    expect(ok.seq).toBe(pkt.seq);

    // Tampered signature byte
    const badSig = Buffer.from(pkt.payload);
    badSig[0] ^= 0x01;
    expect(verifyPkarrPacket(pkt.key, badSig)).toMatchObject({ ok: false, code: "invalid_signature" });

    // Tampered timestamp
    const badSeq = Buffer.from(pkt.payload);
    badSeq[71] ^= 0x01;
    expect(verifyPkarrPacket(pkt.key, badSeq)).toMatchObject({ ok: false, code: "invalid_signature" });

    // Wrong key
    const other = createIdentity();
    expect(verifyPkarrPacket(other.pubKeyZ32, pkt.payload)).toMatchObject({ ok: false, code: "invalid_signature" });

    // Too short / too large
    expect(verifyPkarrPacket(pkt.key, Buffer.alloc(83))).toMatchObject({ ok: false, code: "packet_too_short" });
    expect(verifyPkarrPacket(pkt.key, Buffer.alloc(RELAY_PAYLOAD_MAX_BYTES + 1))).toMatchObject({ ok: false, code: "packet_too_large" });

    // Small-order Ed25519 key (all zeros)
    const zeroKeyZ32 = encodeZ32(Buffer.alloc(32));
    expect(verifyPkarrPacket(zeroKeyZ32, pkt.payload)).toMatchObject({ ok: false, code: "invalid_key" });
  });

  it("enforces monotonic timestamps with future-skew protection", () => {
    const nowMs = 1_750_000_000_000;
    const base = { seq: BigInt(nowMs) * 1000n, payload: Buffer.from("a") };
    const newer = { seq: BigInt(nowMs + 1000) * 1000n, payload: Buffer.from("b") };
    const older = { seq: BigInt(nowMs - 1000) * 1000n, payload: Buffer.from("c") };
    const farFuture = { seq: BigInt(nowMs + 60 * 60_000) * 1000n, payload: Buffer.from("d") };

    expect(comparePacketSeq(null, base, nowMs)).toBe("newer");
    expect(comparePacketSeq(base, { ...base }, nowMs)).toBe("same");
    expect(comparePacketSeq(base, newer, nowMs)).toBe("newer");
    expect(comparePacketSeq(base, older, nowMs)).toBe("stale");
    // A far-future packet does not overwrite a current-time packet, and a current-time packet replaces a far-future one.
    expect(comparePacketSeq(base, farFuture, nowMs)).toBe("stale");
    expect(comparePacketSeq(farFuture, base, nowMs)).toBe("newer");
  });
});

describe("Pkarr relay HTTP, batch, push, and limits (infra/services/pkarr-relay)", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length) {
      await closers.pop()!();
    }
  });

  async function boot(opts: Parameters<typeof startRelay>[0] = {}): Promise<RelayHandle> {
    const relay = await startRelay(opts);
    closers.push(() => relay.close());
    return relay;
  }

  it("serves /healthz with capabilities (no user counts) and standard security/CORS headers", async () => {
    const relay = await boot({ origins: ["https://app.example"] });
    const base = `http://127.0.0.1:${relay.port}`;

    const health = await fetch(`${base}/healthz?probe=1`);
    expect(health.status).toBe(200);
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(health.headers.get("referrer-policy")).toBe("no-referrer");
    expect(health.headers.get("cache-control")).toBe("no-store");
    const body = await health.json();
    expect(body).toEqual({
      ok: true,
      capabilities: {
        batchGet: true,
        batchPut: true,
        pushWs: true,
        pushSse: true,
        maxBatchKeys: DEFAULT_LIMITS.maxBatchKeys,
        maxSubscribeKeys: DEFAULT_LIMITS.maxKeysPerConnection,
      },
    });
    expect(body.subscribers).toBeUndefined();

    const head = await fetch(`${base}/healthz`, { method: "HEAD" });
    expect(head.status).toBe(200);

    // CORS preflight + origin check
    const preflight = await fetch(`${base}/batch`, { method: "OPTIONS", headers: { Origin: "https://app.example" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(preflight.headers.get("access-control-expose-headers")).toContain("Date");

    const forbidden = await fetch(`${base}/batch`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ keys: [] }),
    });
    expect(forbidden.status).toBe(403);
  });

  it("proxies legacy single-key GET /:z32 and PUT /:z32 with caching, NetworkOnly, and validation", async () => {
    const upstream = await startMockUpstream();
    closers.push(() => upstream.close());
    const relay = await boot({ upstreams: [upstream.url], limits: { upstreamRefreshMs: 0 } });
    const base = `http://127.0.0.1:${relay.port}`;

    const id = createIdentity();
    const t1 = BigInt(Date.now()) * 1000n;
    const p1 = makePacket(id, "v1", t1);

    // Miss before PUT
    expect((await fetch(`${base}/${id.pubKeyZ32}`)).status).toBe(404);
    expect(upstream.stats.gets).toBe(1);

    // Invalid key / bad signature / oversize rejected before touching upstream
    expect((await fetch(`${base}/not-a-valid-z32-key`)).status).toBe(400);
    const badSig = Buffer.from(p1.payload);
    badSig[0] ^= 0xff;
    expect((await fetch(`${base}/${id.pubKeyZ32}`, { method: "PUT", body: badSig })).status).toBe(400);
    expect((await fetch(`${base}/${id.pubKeyZ32}`, { method: "PUT", body: Buffer.alloc(RELAY_PAYLOAD_MAX_BYTES + 1) })).status).toBe(413);
    expect(upstream.stats.puts).toBe(0);

    // Valid PUT caches and forwards upstream
    const put1 = await fetch(`${base}/${id.pubKeyZ32}`, { method: "PUT", body: p1.payload });
    expect(put1.status).toBe(204);
    expect(upstream.stats.puts).toBe(1);

    // GET hits local cache without hitting upstream again
    const get1 = await fetch(`${base}/${id.pubKeyZ32}`);
    expect(get1.status).toBe(200);
    const raw1 = Buffer.from(await get1.arrayBuffer());
    expect(raw1.equals(p1.payload)).toBe(true);
    expect(parseRelayPayload(id.pubKeyZ32, raw1).records[0].value).toBe("v1");
    expect(upstream.stats.gets).toBe(1);

    // Older PUT is rejected with 409
    const pOld = makePacket(id, "old", t1 - 5000n);
    expect((await fetch(`${base}/${id.pubKeyZ32}`, { method: "PUT", body: pOld.payload })).status).toBe(409);

    // Update directly on upstream, then NetworkOnly bypasses cache
    const p2 = makePacket(id, "v2", t1 + 5000n);
    upstream.store.set(id.pubKeyZ32, p2.payload);
    const getFresh = await fetch(`${base}/${id.pubKeyZ32}?policy=NetworkOnly`);
    expect(getFresh.status).toBe(200);
    const raw2 = Buffer.from(await getFresh.arrayBuffer());
    expect(parseRelayPayload(id.pubKeyZ32, raw2).records[0].value).toBe("v2");
    expect(upstream.stats.gets).toBe(2);
  });

  it("resolves Batch GET via POST /batch and GET /batch with cache hits, upstream fetches, misses, and upstream signature verification", async () => {
    const idCached = createIdentity();
    const idUpstream = createIdentity();
    const idTampered = createIdentity();
    const idMissing = createIdentity();
    const pCached = makePacket(idCached, "cached");
    const pUpstream = makePacket(idUpstream, "upstream");
    const pTampered = makePacket(idTampered, "tampered");
    pTampered.payload[10] ^= 0xff; // corrupted upstream bytes

    const upstream = await startMockUpstream();
    closers.push(() => upstream.close());
    upstream.store.set(idUpstream.pubKeyZ32, pUpstream.payload);
    upstream.store.set(idTampered.pubKeyZ32, pTampered.payload);

    const relay = await boot({ upstreams: [upstream.url], limits: { maxBatchKeys: 4, upstreamRefreshMs: 0 } });
    const base = `http://127.0.0.1:${relay.port}`;

    // Seed one key locally
    expect((await fetch(`${base}/${idCached.pubKeyZ32}`, { method: "PUT", body: pCached.payload })).status).toBe(204);

    // POST /batch with duplicate key + cache hit + upstream hit + miss
    const res = await fetch(`${base}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keys: [idCached.pubKeyZ32, idCached.pubKeyZ32, idUpstream.pubKeyZ32, idMissing.pubKeyZ32],
      }),
    });
    expect(res.status).toBe(200);
    const { results } = await res.json();
    expect(results[idCached.pubKeyZ32]).toMatchObject({ status: "ok", cached: true, seq: pCached.seq.toString() });
    expect(results[idUpstream.pubKeyZ32]).toMatchObject({ status: "ok", cached: false, seq: pUpstream.seq.toString() });
    expect(results[idMissing.pubKeyZ32]).toEqual({ status: "not_found" });

    // Verify returned base64 bytes pass @ghostly/core parseRelayPayload verbatim
    const decoded = Buffer.from(results[idUpstream.pubKeyZ32].packet, "base64");
    expect(parseRelayPayload(idUpstream.pubKeyZ32, decoded).records[0].value).toBe("upstream");

    // GET /batch?keys=... returns now-cached idUpstream and refuses tampered upstream packet
    const res2 = await fetch(`${base}/batch?keys=${idUpstream.pubKeyZ32},${idTampered.pubKeyZ32}`);
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.results[idUpstream.pubKeyZ32].cached).toBe(true);
    expect(body2.results[idTampered.pubKeyZ32]).toEqual({ status: "error", error: "upstream_unavailable" });

    // Enforces maxBatchKeys and invalid key validation
    const tooMany = await fetch(`${base}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys: Array.from({ length: 5 }, () => createIdentity().pubKeyZ32) }),
    });
    expect(tooMany.status).toBe(400);

    const badKey = await fetch(`${base}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys: ["invalid"] }),
    });
    expect(badKey.status).toBe(400);
  });

  it("validates every item independently on Batch PUT (PUT /batch) and blocks invalid or stale packets", async () => {
    const upstream = await startMockUpstream();
    closers.push(() => upstream.close());
    const relay = await boot({ upstreams: [upstream.url], limits: { upstreamRefreshMs: 0 } });
    const base = `http://127.0.0.1:${relay.port}`;

    const id1 = createIdentity();
    const id2 = createIdentity();
    const id3 = createIdentity();
    const now = BigInt(Date.now()) * 1000n;
    const p1 = makePacket(id1, "one", now);
    const p2Fresh = makePacket(id2, "two-fresh", now + 5000n);
    const p2Stale = makePacket(id2, "two-stale", now);
    const p3Bad = makePacket(id3, "bad", now);
    p3Bad.payload[5] ^= 0x80;

    // Pre-seed id2 with newer timestamp
    expect((await fetch(`${base}/${id2.pubKeyZ32}`, { method: "PUT", body: p2Fresh.payload })).status).toBe(204);

    // Send mixed batch (p1 uses base64url, p2 is stale, p3 has invalid sig, __proto__ is invalid key)
    const res = await fetch(`${base}/batch`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        packets: {
          [id1.pubKeyZ32]: p1.payload.toString("base64url"),
          [id2.pubKeyZ32]: p2Stale.payload.toString("base64"),
          [id3.pubKeyZ32]: p3Bad.payload.toString("base64"),
          __proto__: "AAAA",
        },
      }),
    });
    expect(res.status).toBe(200);
    const { results } = await res.json();
    expect(results[id1.pubKeyZ32]).toEqual({ status: "ok", seq: p1.seq.toString() });
    expect(results[id2.pubKeyZ32]).toEqual({ status: "stale" });
    expect(results[id3.pubKeyZ32]).toMatchObject({ status: "invalid_signature" });
    expect(upstream.store.has(id1.pubKeyZ32)).toBe(true);
    expect(upstream.store.has(id3.pubKeyZ32)).toBe(false);
  });

  it("delivers WebSocket push updates with strict client isolation, subscribe/unsubscribe, and upstream refresh", async () => {
    const upstream = await startMockUpstream();
    closers.push(() => upstream.close());
    const relay = await boot({ upstreams: [upstream.url], limits: { upstreamRefreshMs: 120 } });
    const base = `http://127.0.0.1:${relay.port}`;

    const idA = createIdentity();
    const idB = createIdentity();
    const t1 = BigInt(Date.now()) * 1000n;
    const pA1 = makePacket(idA, "a1", t1);

    // Pre-populate idA so subscribe returns cached snapshot
    expect((await fetch(`${base}/${idA.pubKeyZ32}`, { method: "PUT", body: pA1.payload })).status).toBe(204);

    const clientA = await openWs(`ws://127.0.0.1:${relay.port}/subscribe`);
    const clientB = await openWs(`ws://127.0.0.1:${relay.port}/subscribe`);
    closers.push(async () => { clientA.ws.close(); clientB.ws.close(); });

    // Subscribe clientA to idA, clientB to idB
    clientA.ws.send(JSON.stringify({ op: "subscribe", keys: [idA.pubKeyZ32] }));
    expect(await clientA.nextMessage()).toEqual({ op: "subscribed", keys: [idA.pubKeyZ32], count: 1 });
    // Immediate cached snapshot for idA
    const snap = await clientA.nextMessage();
    expect(snap).toMatchObject({ op: "update", key: idA.pubKeyZ32, seq: t1.toString() });

    clientB.ws.send(JSON.stringify({ op: "subscribe", keys: [idB.pubKeyZ32] }));
    expect(await clientB.nextMessage()).toEqual({ op: "subscribed", keys: [idB.pubKeyZ32], count: 1 });

    // Ping/pong
    clientB.ws.send(JSON.stringify({ op: "ping" }));
    expect(await clientB.nextMessage()).toEqual({ op: "pong" });

    // Publish newer packet for idB via Batch PUT -> clientB gets update, clientA does not
    const pB1 = makePacket(idB, "b1", t1 + 1000n);
    await fetch(`${base}/batch`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packets: { [idB.pubKeyZ32]: pB1.payload.toString("base64") } }),
    });
    const updB = await clientB.nextMessage();
    expect(updB).toMatchObject({ op: "update", key: idB.pubKeyZ32, seq: pB1.seq.toString() });
    const parsedB = parseRelayPayload(idB.pubKeyZ32, Buffer.from(updB.packet as string, "base64"));
    expect(parsedB.records[0].value).toBe("b1");

    // Verify clientA got no leaked event for idB by sending a ping and checking next message is pong
    clientA.ws.send(JSON.stringify({ op: "ping" }));
    expect(await clientA.nextMessage()).toEqual({ op: "pong" });

    // Write newer packet for idA directly to upstream -> background refresh pushes it to clientA!
    const pA2 = makePacket(idA, "a2-upstream", t1 + 5000n);
    upstream.store.set(idA.pubKeyZ32, pA2.payload);
    const updA = await clientA.nextMessage(3000);
    expect(updA).toMatchObject({ op: "update", key: idA.pubKeyZ32, seq: pA2.seq.toString() });
    expect(parseRelayPayload(idA.pubKeyZ32, Buffer.from(updA.packet as string, "base64")).records[0].value).toBe("a2-upstream");

    // Unsubscribe idA
    clientA.ws.send(JSON.stringify({ op: "unsubscribe", keys: [idA.pubKeyZ32] }));
    expect(await clientA.nextMessage()).toEqual({ op: "unsubscribed", keys: [idA.pubKeyZ32], count: 0 });
  });

  it("delivers SSE push updates on GET /subscribe and cleans up on disconnect", async () => {
    const relay = await boot();
    const base = `http://127.0.0.1:${relay.port}`;
    const id = createIdentity();
    const controller = new AbortController();
    closers.push(async () => controller.abort());

    const res = await fetch(`${base}/subscribe?keys=${id.pubKeyZ32}&initial=0`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readUntil = async (needle: string) => {
      while (!buffer.includes(needle)) {
        const { done, value } = await reader.read();
        if (done) throw new Error("SSE stream closed early");
        buffer += decoder.decode(value, { stream: true });
      }
      return buffer;
    };

    await readUntil("event: subscribed");
    expect(relay.stats().subscribers).toBe(1);

    const pkt = makePacket(id, "sse-msg");
    expect((await fetch(`${base}/${id.pubKeyZ32}`, { method: "PUT", body: pkt.payload })).status).toBe(204);

    await readUntil("event: update");
    expect(buffer).toContain(id.pubKeyZ32);
    expect(buffer).toContain(pkt.payload.toString("base64"));

    await reader.cancel().catch(() => {});
    controller.abort();
    await new Promise((r) => setTimeout(r, 80));
    expect(relay.stats().subscribers).toBe(0);
    expect(relay.stats().subscribedKeys).toBe(0);
  });

  it("enforces per-IP request rate limits, Cloudflare IP header, and connection/key caps", async () => {
    const relay = await boot({
      proxies: 1,
      limits: {
        requestsPerMinute: 2,
        connectsPerMinutePerIp: 10,
        maxConnectionsPerIp: 2,
        maxConnections: 3,
        maxKeysPerConnection: 2,
        maxKeysPerIp: 3,
      },
    });
    const base = `http://127.0.0.1:${relay.port}`;
    const id1 = createIdentity();
    const id2 = createIdentity();
    const id3 = createIdentity();
    const id4 = createIdentity();

    // 1. Per-IP HTTP rate limit with X-Forwarded-For isolation (IPv6 /64 grouped together)
    const getAs = (ip: string) => fetch(`${base}/${id1.pubKeyZ32}`, { headers: { "X-Forwarded-For": ip } });
    expect((await getAs("2001:db8:1:2::1")).status).toBe(404);
    expect((await getAs("2001:db8:1:2::9999")).status).toBe(404);
    const limited = await getAs("2001:db8:1:2::abcd");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // Different IP still allowed
    expect((await getAs("203.0.113.10")).status).toBe(404);

    // 2. Per-IP concurrent connections & per-connection/per-IP key caps
    const ws1 = await openWs(`ws://127.0.0.1:${relay.port}/subscribe`, { "X-Forwarded-For": "198.51.100.1" });
    const ws2 = await openWs(`ws://127.0.0.1:${relay.port}/subscribe`, { "X-Forwarded-For": "198.51.100.1" });
    closers.push(async () => { ws1.ws.close(); ws2.ws.close(); });

    // 3rd connection from same IP rejected with 429
    await expect(openWs(`ws://127.0.0.1:${relay.port}/subscribe`, { "X-Forwarded-For": "198.51.100.1" })).rejects.toThrow(/429/);

    // Subscribe 2 keys on ws1 (hits maxKeysPerConnection=2), 3rd key on ws1 rejected
    ws1.ws.send(JSON.stringify({ op: "subscribe", keys: [id1.pubKeyZ32, id2.pubKeyZ32] }));
    expect(await ws1.nextMessage()).toMatchObject({ op: "subscribed", count: 2 });
    ws1.ws.send(JSON.stringify({ op: "subscribe", keys: [id3.pubKeyZ32] }));
    expect(await ws1.nextMessage()).toMatchObject({ op: "error", code: "max_keys_per_connection" });

    // ws2 from same IP can add 1 more key (total 3 = maxKeysPerIp), adding 2nd on ws2 hits maxKeysPerIp
    ws2.ws.send(JSON.stringify({ op: "subscribe", keys: [id3.pubKeyZ32] }));
    expect(await ws2.nextMessage()).toMatchObject({ op: "subscribed", count: 1 });
    ws2.ws.send(JSON.stringify({ op: "subscribe", keys: [id4.pubKeyZ32] }));
    expect(await ws2.nextMessage()).toMatchObject({ op: "error", code: "max_keys_per_ip" });

    // Global maxConnections=3: one more IP fits, fourth connection rejected with 503
    const ws3 = await openWs(`ws://127.0.0.1:${relay.port}/subscribe`, { "X-Forwarded-For": "198.51.100.2" });
    closers.push(async () => ws3.ws.close());
    await expect(openWs(`ws://127.0.0.1:${relay.port}/subscribe`, { "X-Forwarded-For": "198.51.100.3" })).rejects.toThrow(/503/);
  });

  it("persists shared per-IP byte budget across disconnects/reconnects and throttles connect loops", async () => {
    const relay = await boot({
      cloudflare: true,
      limits: {
        connectsPerMinutePerIp: 2,
        bytesPerSecondPerIp: 1,
        burstBytesPerIp: 220,
      },
    });

    // Exhaust burst on IP .4, close socket, reconnect immediately -> still throttled (no fresh burst!)
    const ws1 = await openWs(`ws://127.0.0.1:${relay.port}/subscribe`, { "CF-Connecting-IP": "198.51.100.4" });
    ws1.ws.send(JSON.stringify({ op: "ping", pad: "x".repeat(80) }));
    expect(await ws1.nextMessage()).toEqual({ op: "pong" });
    ws1.ws.send(JSON.stringify({ op: "ping", pad: "x".repeat(80) }));
    expect(await ws1.nextMessage()).toMatchObject({ op: "error", code: "rate_limited" });
    ws1.ws.close();
    await new Promise((r) => setTimeout(r, 40));
    await expect(openWs(`ws://127.0.0.1:${relay.port}/subscribe`, { "CF-Connecting-IP": "198.51.100.4" })).rejects.toThrow(/429/);

    // Connect-rate cap per IP: 2 connects succeed on IP .5, 3rd within the minute returns 429
    const wsA = await openWs(`ws://127.0.0.1:${relay.port}/subscribe`, { "CF-Connecting-IP": "198.51.100.5" });
    wsA.ws.close();
    const wsB = await openWs(`ws://127.0.0.1:${relay.port}/subscribe`, { "CF-Connecting-IP": "198.51.100.5" });
    wsB.ws.close();
    await new Promise((r) => setTimeout(r, 40));
    await expect(openWs(`ws://127.0.0.1:${relay.port}/subscribe`, { "CF-Connecting-IP": "198.51.100.5" })).rejects.toThrow(/429/);
  });

  it("evicts least-recently-used entries when cache exceeds maxCacheEntries", async () => {
    const relay = await boot({ limits: { maxCacheEntries: 2 } });
    const base = `http://127.0.0.1:${relay.port}`;
    const p1 = makePacket();
    const p2 = makePacket();
    const p3 = makePacket();

    expect((await fetch(`${base}/${p1.key}`, { method: "PUT", body: p1.payload })).status).toBe(204);
    expect((await fetch(`${base}/${p2.key}`, { method: "PUT", body: p2.payload })).status).toBe(204);
    // Touch p1 so p2 becomes LRU
    expect((await fetch(`${base}/${p1.key}`)).status).toBe(200);
    // Insert p3 -> evicts p2
    expect((await fetch(`${base}/${p3.key}`, { method: "PUT", body: p3.payload })).status).toBe(204);

    expect(relay.stats().cached).toBe(2);
    expect((await fetch(`${base}/${p1.key}`)).status).toBe(200);
    expect((await fetch(`${base}/${p3.key}`)).status).toBe(200);
    expect((await fetch(`${base}/${p2.key}`)).status).toBe(404);
  });

  it("applies upstream timeout and circuit breaker, then recovers after cooldown", async () => {
    let mode: "slow" | "fail" | "ok" = "slow";
    let upstreamHits = 0;
    const pkt = makePacket();

    const upstream = await startMockUpstream(async (_req, res) => {
      upstreamHits++;
      if (mode === "slow") {
        await new Promise((r) => setTimeout(r, 300));
        if (!res.writableEnded) { res.writeHead(200); res.end(pkt.payload); }
        return;
      }
      if (mode === "fail") {
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(pkt.payload);
    });
    closers.push(() => upstream.close());

    const relay = await boot({
      upstreams: [upstream.url],
      limits: {
        upstreamTimeoutMs: 80,
        upstreamBreakerThreshold: 2,
        upstreamBreakerCooldownMs: 150,
        upstreamRefreshMs: 0,
      },
    });
    const base = `http://127.0.0.1:${relay.port}`;

    // Failure 1: timeout
    expect((await fetch(`${base}/${pkt.key}`)).status).toBe(502);
    // Failure 2: HTTP 500 -> trips circuit breaker
    mode = "fail";
    expect((await fetch(`${base}/${pkt.key}`)).status).toBe(502);
    expect(upstreamHits).toBe(2);

    // While breaker is open, request returns 503 immediately without hitting upstream
    mode = "ok";
    const duringOpen = await fetch(`${base}/${pkt.key}`);
    expect(duringOpen.status).toBe(503);
    expect(upstreamHits).toBe(2);

    // After cooldown, half-open probe succeeds and closes circuit
    await new Promise((r) => setTimeout(r, 180));
    const recovered = await fetch(`${base}/${pkt.key}`);
    expect(recovered.status).toBe(200);
    expect(upstreamHits).toBe(3);
  });

  it("parses settings, flags typos, formats listenProblem, and shuts down server.mjs cleanly on SIGTERM", async () => {
    expect(readSettings({})).toEqual({
      port: 49490,
      host: "0.0.0.0",
      upstreams: [],
      origins: [],
      proxies: 0,
      cloudflare: false,
      limits: {},
      ignored: [],
    });
    expect(readSettings({
      PORT: "8080",
      GHOSTLY_PKARR_UPSTREAMS: "https://relay-a.example/, https://relay-b.example",
      GHOSTLY_RELAY_PROXIES: "1",
      GHOSTLY_RELAY_MAX_BATCH_KEYS: "32",
      GHOSTLY_RELAY_UPSTREAM_REFRESH_MS: "0",
      GHOSTLY_RELAY_ORIGIN: "https://app.example",
    })).toEqual({
      port: 8080,
      host: "127.0.0.1",
      upstreams: ["https://relay-a.example", "https://relay-b.example"],
      origins: [],
      proxies: 1,
      cloudflare: false,
      limits: { maxBatchKeys: 32, upstreamRefreshMs: 0 },
      ignored: ["GHOSTLY_RELAY_ORIGIN (GHOSTLY_RELAY_ORIGINS?)"],
    });
    expect(() => readSettings({ GHOSTLY_RELAY_PROXIES: "1", GHOSTLY_RELAY_CLOUDFLARE: "1" })).toThrow(/GHOSTLY_RELAY_CLOUDFLARE=1/);
    expect(() => readSettings({ GHOSTLY_PKARR_UPSTREAMS: "ftp://bad.example" })).toThrow(/HTTP\(S\) upstream/);
    expect(limitVariable("maxBatchKeys")).toBe("GHOSTLY_RELAY_MAX_BATCH_KEYS");
    expect(rateKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(listenProblem(Object.assign(new Error("in use"), { code: "EADDRINUSE" }), { port: 49490, host: "127.0.0.1" }))
      .toBe("port 49490 on 127.0.0.1 is already in use (PORT)");

    // Spawn server.mjs, open a WS client, send SIGTERM, verify 1001 close and clean exit 0
    const serviceDir = resolve(import.meta.dirname, "../../../infra/services/pkarr-relay");
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GHOSTLY_|PORT$|HOST$)/.test(k)));
    const testPort = 49591;
    const child: ChildProcess = spawn(process.execPath, ["server.mjs"], {
      cwd: serviceDir,
      env: { ...cleanEnv, HOST: "127.0.0.1", PORT: String(testPort) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    closers.push(async () => { child.kill("SIGKILL"); });

    const lines: string[] = [];
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => lines.push(...chunk.split("\n").filter(Boolean)));
    const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
    await new Promise<void>((ready, fail) => {
      const poll = setInterval(() => { if (lines.some((l) => l.includes(`on port ${testPort}`))) { clearInterval(poll); ready(); } }, 40);
      void exited.then(() => { clearInterval(poll); fail(new Error(`pkarr-relay exited early: ${lines.join("\n")}`)); });
    });

    const { ws } = await openWs(`ws://127.0.0.1:${testPort}/subscribe`);
    const closed = new Promise<{ code: number; reason: string }>((done) => {
      ws.once("close", (code, reason) => done({ code, reason: reason.toString("utf8") }));
    });
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(await closed).toEqual({ code: 1001, reason: "The relay is stopping" });
    expect(lines.some((l) => l.includes("Ghostly Pkarr relay stopping (1 subscriber)"))).toBe(true);
    expect(lines.at(-1)).toMatch(/Ghostly Pkarr relay stopped$/);
  }, 20_000);
});
