import { describe, expect, it } from "vitest";
import {
  CHUNK_KIND,
  HttpClient,
  HttpHost,
  LIMITS,
  MAX_CHUNK_PAYLOAD_BYTES,
  buildDataSdp,
  decodeChunk,
  decodeControl,
  encodeChunk,
  encodeControl,
  extractRtcParams,
  parseLocalTarget,
  parseRtcSignal,
  relativizeLocation,
  resolveTargetUrl,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
  utf8Decode,
  utf8Encode,
  type FrameChannel,
  type LocalFetch,
  type LocalRequest,
} from "../src";
import { createChannelPair } from "./helpers";

describe("local targets", () => {
  it("accepts loopback only", () => {
    expect(parseLocalTarget("localhost:3400")).toEqual({ origin: "http://localhost:3400", basePath: "" });
    expect(parseLocalTarget("http://127.0.0.1:8080/app/")).toEqual({ origin: "http://127.0.0.1:8080", basePath: "/app" });
    expect(parseLocalTarget("http://[::1]:3000").origin).toBe("http://[::1]:3000");
    for (const bad of [
      "http://example.com",
      "http://192.168.1.10:80",
      "http://localhost.evil.com",
      "http://user:pw@localhost:1",
      "ftp://localhost",
      "file:///etc/passwd",
      "http://localhost:3400/?x=1",
      "http://0.0.0.0:80",
    ]) {
      expect(() => parseLocalTarget(bad), bad).toThrow();
    }
  });

  it("never lets a path leave the configured target", () => {
    const root = parseLocalTarget("localhost:3400");
    expect(resolveTargetUrl(root, "/api/items?page=2")).toBe("http://localhost:3400/api/items?page=2");
    for (const bad of [
      "//evil.com/x",
      "http://localhost:22/",
      "/\\evil.com",
      "@evil.com/",
      ":22/",
      "",
      "/a b",
      "/a\r\nHost: x",
    ]) {
      expect(resolveTargetUrl(root, bad), JSON.stringify(bad)).toBeNull();
    }
    // `@` and `:` are harmless once the path is anchored behind the origin
    expect(resolveTargetUrl(root, "/@evil.com:22/")).toBe("http://localhost:3400/@evil.com:22/");

    const scoped = parseLocalTarget("localhost:3400/app");
    expect(resolveTargetUrl(scoped, "/x")).toBe("http://localhost:3400/app/x");
    expect(resolveTargetUrl(scoped, "/../admin")).toBeNull();
    expect(resolveTargetUrl(scoped, "/%2e%2e/admin")).toBeNull();
    // a server that decodes separators before routing would land outside the base path
    for (const bad of ["/..%2fadmin", "/..%2Fadmin", "/..%5cadmin", "/%2E%2E/admin", "/x%2e"]) {
      expect(resolveTargetUrl(scoped, bad), bad).toBeNull();
    }
    expect(resolveTargetUrl(scoped, "/x?next=%2Fa%2e%5c")).toBe("http://localhost:3400/app/x?next=%2Fa%2e%5c");
  });

  it("rewrites locations relative to the target", () => {
    const target = parseLocalTarget("localhost:3400/app");
    expect(relativizeLocation("http://localhost:3400/app/login?next=1", target)).toBe("/login?next=1");
    expect(relativizeLocation("/app/x", target)).toBe("/x");
    for (const off of [
      "https://example.com/x",
      "//example.com/x",
      "http://localhost:22/",
      "http://localhost:3400/admin",
      "/apple",
      "http://user@localhost:3400/app/x",
    ]) {
      expect(relativizeLocation(off, target), off).toBeNull();
    }
    expect(relativizeLocation("http://localhost:3400//evil.com/x", parseLocalTarget("localhost:3400"))).toBeNull();
  });
});

describe("header hygiene", () => {
  it("strips what must not cross the proxy", () => {
    expect(
      sanitizeRequestHeaders([
        ["Accept", "text/html"],
        ["Host", "evil"],
        ["Connection", "upgrade"],
        ["X-Forwarded-For", "1.2.3.4"],
        ["Sec-Fetch-Mode", "cors"],
        ["Authorization", "Bearer x"],
        ["Bad Name", "x"],
        ["X-Inject", "a\r\nb"],
        ["X-HTTP-Method-Override", "DELETE"],
        ["X-Method-Override", "DELETE"],
        ["X-HTTP-Method", "DELETE"],
        ["X-Original-URL", "/admin"],
        ["X-Rewrite-URL", "/admin"],
        ["X-Forwarded-Prefix", "/admin"],
        ["X-Forwarded-Port", "443"],
        ["X-Forwarded-Server", "evil"],
        ["Forwarded", "for=1.2.3.4"],
        ["True-Client-IP", "127.0.0.1"],
        ["CF-Connecting-IP", "127.0.0.1"],
        ["X-Real-IP", "127.0.0.1"],
        ["X-Client-IP", "127.0.0.1"],
      ]),
    ).toEqual([
      ["Accept", "text/html"],
      ["Authorization", "Bearer x"],
    ]);

    expect(
      sanitizeResponseHeaders(
        [
          ["content-type", "text/html"],
          ["content-encoding", "gzip"],
          ["content-length", "12"],
          ["transfer-encoding", "chunked"],
          ["location", "http://localhost:3400/next"],
          ["content-location", "http://localhost:9000/secret"],
          ["set-cookie", "sid=1; Domain=localhost; Path=/; HttpOnly"],
          ["set-cookie", "fix=1; Domain =invalid; Path=/"],
        ],
        parseLocalTarget("localhost:3400"),
      ),
    ).toEqual([
      ["content-type", "text/html"],
      ["location", "/next"],
      ["set-cookie", "sid=1; Path=/; HttpOnly"],
      ["set-cookie", "fix=1; Path=/"],
    ]);
  });
});

describe("frames", () => {
  it("round-trips chunks and rejects malformed frames", () => {
    const chunk = { kind: CHUNK_KIND.responseBody, id: 0xdeadbeef, end: true, payload: Uint8Array.of(1, 2, 3) };
    expect(decodeChunk(encodeChunk(chunk))).toEqual(chunk);
    expect(decodeChunk(Uint8Array.of(9, 0, 0, 0, 1, 0))).toBeNull();
    expect(decodeChunk(new Uint8Array(3))).toBeNull();
    expect(decodeChunk(new Uint8Array(LIMITS.maxChunkMessageBytes + 1))).toBeNull();
    expect(() => encodeChunk({ ...chunk, payload: new Uint8Array(MAX_CHUNK_PAYLOAD_BYTES + 1) })).toThrow();

    expect(decodeControl("{")).toBeNull();
    expect(decodeControl('{"t":"nope"}')).toBeNull();
    expect(decodeControl('{"t":"req","id":-1,"s":"a","m":"GET","p":"/","h":[]}')).toBeNull();
    expect(decodeControl('{"t":"req","id":1,"s":"a","m":"GET","p":"/","h":[["a"]]}')).toBeNull();
    expect(decodeControl('{"t":"res","id":1,"st":99,"h":[]}')).toBeNull();
    expect(decodeControl(encodeControl({ t: "req", id: 1, s: "atlas", m: "GET", p: "/", h: [], b: false }))).toEqual({
      t: "req",
      id: 1,
      s: "atlas",
      m: "GET",
      p: "/",
      h: [],
      b: false,
    });
  });
});

describe("rtc signal", () => {
  const sdp = [
    "v=0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "a=candidate:1 1 udp 2113937151 3f6b2a9e-1b7c-4b1d-9c3e-0d2f6f6f7a11.local 54400 typ host generation 0",
    "a=candidate:2 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active",
    "a=candidate:3 1 udp 1677729535 203.0.113.7 61000 typ srflx raddr 0.0.0.0 rport 0",
    "a=candidate:3 1 udp 1677729535 203.0.113.7 61000 typ srflx raddr 0.0.0.0 rport 0",
    "a=ice-ufrag:abcd",
    "a=ice-pwd:0123456789abcdefghijklmn",
    `a=fingerprint:sha-256 ${Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0").toUpperCase()).join(":")}`,
    "a=setup:actpass",
    "",
  ].join("\r\n");

  it("extracts a compact signal and rebuilds a usable SDP", () => {
    const params = extractRtcParams(sdp);
    expect(params.c).toEqual(["h,3f6b2a9e-1b7c-4b1d-9c3e-0d2f6f6f7a11.local,54400", "s,203.0.113.7,61000"]);
    const signal = parseRtcSignal(JSON.stringify({ t: "o", ts: 1, ...params }))!;
    expect(signal).not.toBeNull();
    expect(JSON.stringify(signal).length).toBeLessThan(300);

    const rebuilt = buildDataSdp(signal);
    expect(extractRtcParams(rebuilt)).toEqual(params);
    expect(rebuilt).toContain("a=candidate:2 1 udp 1686052606 203.0.113.7 61000 typ srflx raddr 0.0.0.0 rport 0");
  });

  it("rejects values that could inject SDP lines", () => {
    const good = { t: "o", ts: 1, ...extractRtcParams(sdp) };
    expect(parseRtcSignal(JSON.stringify({ ...good, u: "x\r\na=setup:active" }))).toBeNull();
    expect(parseRtcSignal(JSON.stringify({ ...good, c: ["h,1.2.3.4 9 typ host\r\na=x,1"] }))).toBeNull();
    expect(parseRtcSignal(JSON.stringify({ ...good, f: "zz" }))).toBeNull();
    expect(parseRtcSignal(JSON.stringify({ ...good, s: "holdconn" }))).toBeNull();
    expect(parseRtcSignal(JSON.stringify({ ...good, t: "x" }))).toBeNull();
  });
});

describe("http over the data link", () => {
  function setup(localFetch: LocalFetch) {
    const [clientSide, hostSide] = createChannelPair();
    const services = new Map([["atlas", { id: "atlas", target: parseLocalTarget("localhost:3400") }]]);
    const host = new HttpHost(hostSide, (id) => services.get(id), localFetch);
    const client = new HttpClient(clientSide);
    wire(hostSide, { req: (f) => host.handleRequest(f), rst: (f) => host.handleReset(f), chunk: (c) => host.handleChunk(c) });
    wire(clientSide, { res: (f) => client.handleResponse(f), rst: (f) => client.handleReset(f), chunk: (c) => client.handleChunk(c) });
    return { client, host, clientSide, hostSide };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function wire(channel: FrameChannel, handlers: Record<string, (frame: any) => void>) {
    channel.onMessage = (data) => {
      if (typeof data !== "string") return handlers.chunk(decodeChunk(data));
      const frame = decodeControl(data);
      if (frame) handlers[frame.t]?.(frame);
    };
  }

  async function* bodyOf(...parts: Uint8Array[]) {
    for (const p of parts) yield p;
  }

  it("proxies a request to the configured target only", async () => {
    const seen: LocalRequest[] = [];
    const { client } = setup(async (request) => {
      seen.push(request);
      return { status: 200, headers: [["content-type", "text/plain"]], body: bodyOf(utf8Encode("hello "), utf8Encode("atlas")) };
    });

    const response = await client.request("atlas", {
      method: "get",
      path: "/api?q=1",
      headers: [
        ["accept", "*/*"],
        ["host", "evil"],
      ],
    });
    expect(response.status).toBe(200);
    expect(utf8Decode(await response.bytes())).toBe("hello atlas");
    expect(seen[0].url).toBe("http://localhost:3400/api?q=1");
    expect(seen[0].method).toBe("GET");
    expect(seen[0].headers).toEqual([["accept", "*/*"]]);
  });

  it("streams large binary bodies in both directions", async () => {
    const upload = new Uint8Array(200_000).map((_, i) => i % 251);
    const download = new Uint8Array(1_000_000).map((_, i) => i % 241);
    const { client } = setup(async (request) => {
      expect(request.body).toEqual(upload);
      return { status: 201, headers: [], body: bodyOf(download.subarray(0, 300_000), download.subarray(300_000)) };
    });
    const response = await client.request("atlas", { method: "POST", path: "/upload", body: upload });
    expect(response.status).toBe(201);
    expect(await response.bytes()).toEqual(download);
  });

  it("answers for unknown services, bad paths and bad methods without touching the network", async () => {
    let calls = 0;
    const { client } = setup(async () => {
      calls++;
      return { status: 200, headers: [], body: null };
    });
    expect((await client.request("ssh", { method: "GET", path: "/" })).status).toBe(404);
    expect((await client.request("atlas", { method: "GET", path: "//evil.com/" })).status).toBe(400);
    expect((await client.request("atlas", { method: "GET", path: "http://localhost:22/" })).status).toBe(400);
    expect((await client.request("atlas", { method: "CONNECT", path: "/" })).status).toBe(405);
    expect((await client.request("atlas", { method: "TRACE", path: "/" })).status).toBe(405);
    expect(calls).toBe(0);
  });

  it("hands on-target redirects back to the client and blocks the rest", async () => {
    const locations: Record<string, string> = {
      "/docs": "http://localhost:3400/docs/",
      "/relative": "next",
      "/out": "http://localhost:22/",
      "/far": "https://example.com/",
      "/sneaky": "//example.com/",
    };
    const { client } = setup(async (request) => ({
      status: 307,
      headers: [["location", locations[new URL(request.url).pathname]]],
      body: null,
    }));
    const redirect = await client.request("atlas", { method: "POST", path: "/docs", body: utf8Encode("x") });
    expect(redirect.status).toBe(307);
    expect(redirect.headers).toEqual([["location", "/docs/"]]);
    expect((await client.request("atlas", { method: "GET", path: "/relative" })).headers).toEqual([["location", "/next"]]);
    for (const path of ["/out", "/far", "/sneaky"]) {
      const blocked = await client.request("atlas", { method: "GET", path });
      expect(blocked.status, path).toBe(502);
      expect(blocked.headers).toContainEqual(["x-ghostly-error", "redirect-blocked"]);
      expect(utf8Decode(await blocked.bytes())).not.toContain("localhost");
    }
  });

  it("hands a redirect a browser followed back to the client, never off the target", async () => {
    const finals: Record<string, string> = {
      "/docs": "http://localhost:3400/docs/",
      "/out": "http://localhost:22/admin",
      "/far": "https://example.com/",
    };
    const { client } = setup(async (request) => ({
      status: 200,
      headers: [["content-type", "text/html"]],
      body: null,
      finalUrl: finals[new URL(request.url).pathname],
    }));
    const followed = await client.request("atlas", { method: "GET", path: "/docs" });
    expect(followed.status).toBe(302);
    expect(followed.headers).toEqual([["location", "/docs/"]]);
    for (const path of ["/out", "/far"]) {
      const blocked = await client.request("atlas", { method: "GET", path });
      expect(blocked.status, path).toBe(502);
      expect(blocked.headers).toContainEqual(["x-ghostly-error", "redirect-blocked"]);
      expect(utf8Decode(await blocked.bytes())).not.toContain("localhost");
    }
  });

  it("keeps counting a reset request until its local fetch settles", async () => {
    // Desktop's local fetch ignores the abort signal, like this one.
    const release: (() => void)[] = [];
    const { host, clientSide } = setup(
      () =>
        new Promise((resolve) =>
          release.push(() => resolve({ status: 200, headers: [], body: bodyOf(utf8Encode("stale")) })),
        ),
    );
    const responses: { id: number; st: number }[] = [];
    clientSide.onMessage = (data) => {
      const frame = typeof data === "string" ? decodeControl(data) : null;
      if (frame?.t === "res") responses.push({ id: frame.id, st: frame.st });
    };
    const tick = () => new Promise((r) => setTimeout(r, 10));

    for (let i = 0; i < LIMITS.maxConcurrentRequestsPerPeer; i++) {
      clientSide.send(encodeControl({ t: "req", id: i, s: "atlas", m: "GET", p: "/", h: [], b: false }));
      clientSide.send(encodeControl({ t: "rst", id: i, d: "q", e: "" }));
    }
    await tick();
    expect(host.activeRequests).toBe(LIMITS.maxConcurrentRequestsPerPeer);
    clientSide.send(encodeControl({ t: "req", id: 1000, s: "atlas", m: "GET", p: "/", h: [], b: false }));
    await tick();
    expect(responses).toEqual([{ id: 1000, st: 503 }]);

    // settling one fetch frees a slot; id 0 is reused while its old fetch still runs
    release.splice(1, 1)[0]();
    await tick();
    clientSide.send(encodeControl({ t: "req", id: 0, s: "atlas", m: "GET", p: "/", h: [], b: false }));
    await tick();
    expect(host.activeRequests).toBe(LIMITS.maxConcurrentRequestsPerPeer);

    // the stale runs for the same id settle and must neither answer for nor end the new stream
    release.splice(0, LIMITS.maxConcurrentRequestsPerPeer - 1).forEach((r) => r());
    await tick();
    expect(responses).toEqual([{ id: 1000, st: 503 }]);
    expect(host.activeRequests).toBe(1);

    release.shift()!();
    await tick();
    expect(responses).toEqual([
      { id: 1000, st: 503 },
      { id: 0, st: 200 },
    ]);
    expect(host.activeRequests).toBe(0);
  });

  it("reports an unreachable service as 502", async () => {
    const { client } = setup(async () => {
      throw new TypeError("Failed to fetch");
    });
    const response = await client.request("atlas", { method: "GET", path: "/" });
    expect(response.status).toBe(502);
    expect(response.headers).toContainEqual(["x-ghostly-error", "unreachable"]);
  });

  it("enforces the request and response size limits", async () => {
    const { client, clientSide } = setup(async () => ({
      status: 200,
      headers: [],
      body: bodyOf(new Uint8Array(50_000)),
    }));
    await expect(
      client.request("atlas", { method: "POST", path: "/", body: new Uint8Array(LIMITS.maxRequestBodyBytes + 1) }),
    ).rejects.toThrow("too large");

    const response = await client.request("atlas", { method: "GET", path: "/", maxResponseBytes: 20_000 });
    await expect(response.bytes()).rejects.toThrow("too large");

    // a peer that ignores the client-side check is stopped by the host
    clientSide.send(encodeControl({ t: "req", id: 9000, s: "atlas", m: "POST", p: "/", h: [], b: true }));
    const big = new Uint8Array(MAX_CHUNK_PAYLOAD_BYTES);
    const received = new Promise<number>((resolve) => {
      const previous = clientSide.onMessage;
      clientSide.onMessage = (data) => {
        const frame = typeof data === "string" ? decodeControl(data) : null;
        if (frame?.t === "res" && frame.id === 9000) resolve(frame.st);
        else previous?.(data);
      };
    });
    for (let sent = 0; sent <= LIMITS.maxRequestBodyBytes; sent += big.length) {
      clientSide.send(encodeChunk({ kind: CHUNK_KIND.requestBody, id: 9000, end: false, payload: big }));
    }
    expect(await received).toBe(413);
  });

  it("caps concurrent requests per peer", async () => {
    const release: (() => void)[] = [];
    const { client, host, clientSide } = setup(
      () => new Promise((resolve) => release.push(() => resolve({ status: 204, headers: [], body: null }))),
    );
    const pending = Array.from({ length: LIMITS.maxClientInFlight }, () => client.request("atlas", { method: "GET", path: "/" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(host.activeRequests).toBe(LIMITS.maxClientInFlight);

    // bypass the polite client to hit the host's own limit
    const statuses: number[] = [];
    const previous = clientSide.onMessage;
    clientSide.onMessage = (data) => {
      const frame = typeof data === "string" ? decodeControl(data) : null;
      if (frame?.t === "res" && frame.id >= 5000) statuses.push(frame.st);
      else previous?.(data);
    };
    for (let i = 0; i < LIMITS.maxConcurrentRequestsPerPeer; i++) {
      clientSide.send(encodeControl({ t: "req", id: 5000 + i, s: "atlas", m: "GET", p: "/", h: [], b: false }));
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(host.activeRequests).toBe(LIMITS.maxConcurrentRequestsPerPeer);
    expect(statuses.filter((s) => s === 503)).toHaveLength(LIMITS.maxClientInFlight);

    release.forEach((r) => r());
    expect((await Promise.all(pending)).every((r) => r.status === 204)).toBe(true);
  });

  it("fails pending requests when the link closes", async () => {
    const { client, clientSide } = setup(() => new Promise(() => {}));
    const pending = client.request("atlas", { method: "GET", path: "/" });
    clientSide.close();
    client.close();
    await expect(pending).rejects.toThrow("closed");
    await expect(client.request("atlas", { method: "GET", path: "/" })).rejects.toThrow("closed");
  });
});

describe("payment frames", () => {
  const request = {
    t: "pay-req" as const,
    id: "req-00000001",
    ts: 1,
    v: "1000",
    u: "sat",
    memo: "coffee",
    e: [
      ["btc-lightning-bolt11", "lnbc10u1…"],
      ["cashu", '{"mints":["https://mint.example"]}'],
    ] as [string, string][],
  };

  it("round-trips requests, payments and results", () => {
    expect(decodeControl(encodeControl(request))).toEqual(request);
    const pay = { t: "pay" as const, id: "pay-00000001", ts: 2, rid: request.id, v: "1000", u: "sat", memo: undefined, e: ["cashu", "cashuBtoken"] as [string, string] };
    expect(decodeControl(encodeControl(pay))).toEqual(pay);
    expect(decodeControl(encodeControl({ t: "pay-res", id: pay.id, ok: true, v: "999" }))).toEqual({ t: "pay-res", id: pay.id, ok: true, v: "999", err: undefined });
  });

  it("rejects malformed amounts, ids and endpoints", () => {
    const bad = (patch: object) => decodeControl(JSON.stringify({ ...request, ...patch }));
    expect(bad({ v: "1e3" })).toBeNull();
    expect(bad({ v: "-5" })).toBeNull();
    expect(bad({ v: 1000 })).toBeNull();
    expect(bad({ v: "007" })).toBeNull();
    expect(bad({ u: "SAT!" })).toBeNull();
    expect(bad({ id: "x" })).toBeNull();
    expect(bad({ e: [] })).toBeNull();
    expect(bad({ e: [["Not An Identifier", "x"]] })).toBeNull();
    expect(bad({ e: [["cashu"]] })).toBeNull();
    expect(bad({ v: "0.00000001" })).not.toBeNull();
  });

  it("carries versioned Ark requests and receipts without accepting arbitrary paths", () => {
    const ark = { ...request, e: [["btc-arkade/1", '{"method":"arkade"}']] as [string, string][] };
    expect(decodeControl(encodeControl(ark))).toEqual(ark);
    const receipt = { t: "pay" as const, id: "pay-00000001", ts: 2, rid: request.id, v: "1000", u: "sat", memo: undefined, e: ["btc-arkade/1", '{"txid":"example"}'] as [string, string] };
    expect(decodeControl(encodeControl(receipt))).toEqual(receipt);
    for (const id of ["btc-arkade/0", "btc-arkade/01", "btc-arkade/1/2", "btc-arkade/", "https://provider", "a".repeat(65)]) {
      expect(decodeControl(JSON.stringify({ ...ark, e: [[id, "payload"]] }))).toBeNull();
    }
  });
});
