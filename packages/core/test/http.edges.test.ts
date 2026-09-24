import { afterEach, describe, expect, it, vi } from "vitest";
import { utf8Decode, utf8Encode } from "../src/bytes";
import {
  CHUNK_KIND,
  LIMITS,
  decodeChunk,
  decodeControl,
  type ControlFrame,
  type FrameChannel,
  type HttpRequestFrame,
} from "../src/frames";
import {
  GhostlyHttpError,
  HttpClient,
  HttpHost,
  formatLocalTarget,
  parseLocalTarget,
  relativizeLocation,
  resolveTargetUrl,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
  webLocalFetch,
  type LocalFetch,
  type LocalRequest,
  type LocalResponse,
} from "../src/http";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A channel that records what it sends, split into control frames and chunks. */
function recorder() {
  const sent: (string | Uint8Array)[] = [];
  const channel: FrameChannel & { broken: "never" | "binary" | "always" } = {
    broken: "never",
    bufferedAmount: 0, drained: async () => {}, close() {}, onMessage: null, onClose: null,
    send(data) {
      if (this.broken === "always" || (this.broken === "binary" && typeof data !== "string")) throw new Error("Data link is not open");
      sent.push(data);
    },
  };
  const controls = () => sent.filter((s): s is string => typeof s === "string").map((s) => decodeControl(s) as ControlFrame);
  const chunks = () => sent.filter((s): s is Uint8Array => typeof s !== "string").map((s) => decodeChunk(s)!);
  const body = (id: number) => utf8Decode(new Uint8Array(chunks().filter((c) => c.id === id).flatMap((c) => [...c.payload])));
  return { channel, sent, controls, chunks, body };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("local targets", () => {
  it("refuses what is not a URL, not http(s), carries credentials, a query or a fragment", () => {
    expect(() => parseLocalTarget("http://[")).toThrow("Not a valid URL");
    expect(() => parseLocalTarget("ftp://localhost/")).toThrow("Only http and https");
    expect(() => parseLocalTarget("file:///etc/passwd")).toThrow("Only http and https");
    expect(() => parseLocalTarget("http://user:pw@localhost:1")).toThrow("Credentials");
    expect(() => parseLocalTarget("http://localhost:1/?a=1")).toThrow("query or fragment");
    expect(() => parseLocalTarget("http://localhost:1/#top")).toThrow("query or fragment");
  });

  it("refuses hosts that only look like loopback", () => {
    for (const host of ["localhost.evil.com", "127.0.0.2", "0.0.0.0", "[::ffff:127.0.0.1]", "evil.com#@localhost", "LOCALHOST.:1"]) {
      expect(() => parseLocalTarget(`http://${host}`), host).toThrow();
    }
  });

  it("drops trailing slashes from the base path and formats back to the same target", () => {
    const target = parseLocalTarget("  https://127.0.0.1:8443/app///  ");
    expect(target).toEqual({ origin: "https://127.0.0.1:8443", basePath: "/app" });
    expect(formatLocalTarget(target)).toBe("https://127.0.0.1:8443/app");
    expect(formatLocalTarget(parseLocalTarget("[::1]:3000"))).toBe("http://[::1]:3000");
  });
});

describe("resolveTargetUrl", () => {
  const root = parseLocalTarget("localhost:3400");
  const app = parseLocalTarget("localhost:3400/app");

  it("refuses control characters, spaces, DEL and backslashes anywhere in the path", () => {
    for (const path of ["/a b", "/a\tb", "/a\u0000", "/a\u007f", "/a\\b", "/ok?q=a b", "/a\r\nHost: evil"]) {
      expect(resolveTargetUrl(root, path), JSON.stringify(path)).toBeNull();
    }
  });

  it("refuses encoded separators and dots in the path but allows them in the query", () => {
    for (const path of ["/app/..%2fadmin", "/%2F", "/a%5cb", "/%2e%2e/x", "/%2E"]) expect(resolveTargetUrl(root, path), path).toBeNull();
    expect(resolveTargetUrl(root, "/search?q=a%2Fb%2e")).toBe("http://localhost:3400/search?q=a%2Fb%2e");
  });

  it("refuses relative and protocol-relative paths", () => {
    for (const path of ["", "x", "//evil.com/x", "http://evil.com/"]) expect(resolveTargetUrl(root, path)).toBeNull();
  });

  it("keeps dot segments from climbing out of the base path", () => {
    expect(resolveTargetUrl(app, "/../admin")).toBeNull();
    expect(resolveTargetUrl(app, "/../application")).toBeNull();
    expect(resolveTargetUrl(app, "/x/../../app/y")).toBe("http://localhost:3400/app/y");
    expect(resolveTargetUrl(app, "/x/../y")).toBe("http://localhost:3400/app/y");
    expect(resolveTargetUrl(app, "/")).toBe("http://localhost:3400/app/");
  });

  it("cannot be pointed at another host through an @ in the path", () => {
    expect(resolveTargetUrl(root, "/@evil.com/x")).toBe("http://localhost:3400/@evil.com/x");
  });
});

describe("relativizeLocation", () => {
  const root = parseLocalTarget("localhost:3400");
  const app = parseLocalTarget("localhost:3400/app");

  it("returns null for locations that do not parse", () => {
    expect(relativizeLocation("http://[", root)).toBeNull();
  });

  it("refuses other origins, credentials, and the same host on another port or scheme", () => {
    for (const location of ["http://evil.com/", "https://localhost:3400/", "http://localhost:3401/", "http://u:p@localhost:3400/", "//evil.com/x"]) {
      expect(relativizeLocation(location, root), location).toBeNull();
    }
  });

  it("maps the base path itself to the root and refuses siblings of it", () => {
    expect(relativizeLocation("http://localhost:3400/app", app)).toBe("/");
    expect(relativizeLocation("/app/x?y=1#z", app)).toBe("/x?y=1#z");
    expect(relativizeLocation("/application", app)).toBeNull();
    expect(relativizeLocation("/other", app)).toBeNull();
  });

  it("resolves relative locations against the base path", () => {
    expect(relativizeLocation("next", app)).toBe("/next");
    expect(relativizeLocation("../escape", app)).toBeNull();
  });

  it("never returns a path the client would read as another origin", () => {
    expect(relativizeLocation("http://localhost:3400/app//evil.com/x", app)).toBeNull();
    expect(relativizeLocation("http://localhost:3400//evil.com/x", root)).toBeNull();
  });
});

describe("header hygiene", () => {
  it("drops request headers with invalid names or values carrying CR, LF or NUL", () => {
    expect(
      sanitizeRequestHeaders([
        ["bad name", "v"],
        ["", "v"],
        ["x-ok", "a\r\nInjected: 1"],
        ["x-ok", "a\nb"],
        ["x-ok", "a\u0000b"],
        ["x-kept", "tab\tand unicode é"],
      ]),
    ).toEqual([["x-kept", "tab\tand unicode é"]]);
  });

  it("drops hop-by-hop, proxy-trust and browser-controlled request headers regardless of case", () => {
    const dropped = ["Connection", "TE", "Host", "X-Forwarded-For", "x-forwarded-whatever", "Sec-Fetch-Site", "Proxy-Authorization", "X-HTTP-Method-Override", "CF-Connecting-IP", "Content-Length", "Accept-Encoding"];
    expect(sanitizeRequestHeaders([...dropped.map((n) => [n, "v"] as [string, string]), ["Authorization", "Bearer x"]])).toEqual([["Authorization", "Bearer x"]]);
  });

  it("strips response headers that no longer apply and rewrites cookies and locations", () => {
    const target = parseLocalTarget("localhost:3400/app");
    expect(
      sanitizeResponseHeaders(
        [
          ["Content-Encoding", "gzip"],
          ["Strict-Transport-Security", "max-age=1"],
          ["Transfer-Encoding", "chunked"],
          ["bad name", "x"],
          ["x-split", "a\r\nb"],
          ["Set-Cookie", "sid=1; Domain=localhost; Path=/; domain = .localhost ; HttpOnly"],
          ["Location", "http://localhost:3400/app/next"],
          ["Content-Location", "http://evil.com/"],
          ["X-Kept", "yes"],
        ],
        target,
      ),
    ).toEqual([
      ["Set-Cookie", "sid=1; Path=/; HttpOnly"],
      ["Location", "/next"],
      ["X-Kept", "yes"],
    ]);
  });
});

describe("HttpHost", () => {
  const services = { atlas: { id: "atlas", target: parseLocalTarget("localhost:3400") } };
  const req = (patch: Partial<HttpRequestFrame> = {}): HttpRequestFrame => ({ t: "req", id: 1, s: "atlas", m: "GET", p: "/", h: [], b: false, ...patch });
  const host = (localFetch: LocalFetch) => {
    const r = recorder();
    const h = new HttpHost(r.channel, (id) => services[id as keyof typeof services], localFetch);
    return { ...r, host: h };
  };
  const ok = (body: Iterable<Uint8Array> | AsyncIterable<Uint8Array> | null = null, patch: Partial<LocalResponse> = {}): LocalResponse => ({ status: 200, headers: [], body, ...patch });
  const errorOf = (controls: ControlFrame[], id = 1) => {
    const res = controls.find((f) => f.t === "res" && f.id === id);
    return res?.t === "res" ? [res.st, res.h.find(([n]) => n === "x-ghostly-error")?.[1]] : undefined;
  };

  it.each([
    ["an unknown service", req({ s: "nope" }), 404, "unknown-service"],
    ["a method outside the allow list", req({ m: "TRACE" }), 405, "method-not-allowed"],
    ["CONNECT", req({ m: "connect" }), 405, "method-not-allowed"],
    ["a path that leaves the target", req({ p: "//evil.com/" }), 400, "bad-path"],
  ])("answers %s with an error and a plain text body, without calling the local service", async (_, frame, status, code) => {
    const localFetch = vi.fn<LocalFetch>();
    const t = host(localFetch);
    t.host.handleRequest(frame);
    await flush();
    expect(localFetch).not.toHaveBeenCalled();
    expect(errorOf(t.controls())).toEqual([status, code]);
    expect(t.body(1)).toMatch(/\n$/);
    expect(t.chunks().at(-1)?.end).toBe(true);
  });

  it("normalizes the method and ignores a second request on a stream in use", async () => {
    const localFetch = vi.fn<LocalFetch>(() => new Promise(() => {}));
    const t = host(localFetch);
    t.host.handleRequest(req({ m: "delete" }));
    t.host.handleRequest(req({ m: "get" }));
    await flush();
    expect(localFetch).toHaveBeenCalledOnce();
    expect(localFetch.mock.calls[0][0].method).toBe("DELETE");
    t.host.closeAll();
  });

  it("collects a request body before calling the local service, ignoring empty and late chunks", async () => {
    const seen: LocalRequest[] = [];
    const t = host(async (request) => (seen.push(request), ok()));
    t.host.handleRequest(req({ m: "POST", b: true }));
    t.host.handleChunk({ kind: CHUNK_KIND.requestBody, id: 1, end: false, payload: utf8Encode("he") });
    t.host.handleChunk({ kind: CHUNK_KIND.requestBody, id: 1, end: false, payload: new Uint8Array(0) });
    await flush();
    expect(seen).toEqual([]);
    t.host.handleChunk({ kind: CHUNK_KIND.requestBody, id: 1, end: true, payload: utf8Encode("llo") });
    t.host.handleChunk({ kind: CHUNK_KIND.requestBody, id: 1, end: true, payload: utf8Encode("late") });
    t.host.handleChunk({ kind: CHUNK_KIND.requestBody, id: 42, end: true, payload: utf8Encode("stray") });
    await flush();
    expect(seen).toHaveLength(1);
    expect(utf8Decode(seen[0].body!)).toBe("hello");
  });

  it("does not wait for a body on GET or HEAD even when one is announced", async () => {
    const seen: LocalRequest[] = [];
    const t = host(async (request) => (seen.push(request), ok()));
    t.host.handleRequest(req({ m: "HEAD", b: true }));
    await flush();
    expect(seen[0]).toMatchObject({ method: "HEAD", body: null });
    expect(t.controls()).toEqual([{ t: "res", id: 1, st: 200, h: [], b: false }]);
  });

  it("sends no body for HEAD even when the local service returns one", async () => {
    const t = host(async () => ok([utf8Encode("ignored")]));
    t.host.handleRequest(req({ m: "HEAD" }));
    await flush();
    expect(t.controls()).toEqual([{ t: "res", id: 1, st: 200, h: [], b: false }]);
    expect(t.chunks()).toEqual([]);
  });

  it("gives up on a request body that stops arriving, then ignores the rest of it", () => {
    vi.useFakeTimers();
    const localFetch = vi.fn<LocalFetch>();
    const t = host(localFetch);
    t.host.handleRequest(req({ m: "PUT", b: true }));
    vi.advanceTimersByTime(LIMITS.bodyIdleTimeoutMs - 1);
    t.host.handleChunk({ kind: CHUNK_KIND.requestBody, id: 1, end: false, payload: Uint8Array.of(1) });
    vi.advanceTimersByTime(LIMITS.bodyIdleTimeoutMs - 1);
    expect(t.controls()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(errorOf(t.controls())).toEqual([408, "request-timeout"]);
    expect(t.host.activeRequests).toBe(0);
    t.host.handleChunk({ kind: CHUNK_KIND.requestBody, id: 1, end: true, payload: Uint8Array.of(2) });
    expect(localFetch).not.toHaveBeenCalled();
  });

  it("answers 504 when the local service does not answer in time", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const t = host(
      (request) =>
        new Promise((_, reject) => {
          signal = request.signal;
          request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    t.host.handleRequest(req());
    await vi.advanceTimersByTimeAsync(LIMITS.requestTimeoutMs);
    expect(signal.aborted).toBe(true);
    expect(errorOf(t.controls())).toEqual([504, "timeout"]);
    expect(t.host.activeRequests).toBe(0);
  });

  it("answers 502 for a failure that is not the timeout, even one named AbortError", async () => {
    const t = host(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    t.host.handleRequest(req());
    await flush();
    expect(errorOf(t.controls())).toEqual([502, "unreachable"]);
  });

  it("resets the response when the local service fails after the headers were sent", async () => {
    const t = host(async () =>
      ok(
        (async function* () {
          yield utf8Encode("partial");
          throw new Error("socket hang up");
        })(),
      ),
    );
    t.host.handleRequest(req());
    await flush();
    expect(t.controls()).toEqual([
      { t: "res", id: 1, st: 200, h: [], b: true },
      { t: "rst", id: 1, d: "s", e: "The local service dropped the response." },
    ]);
    expect(t.chunks().some((c) => c.end)).toBe(false);
    expect(t.host.activeRequests).toBe(0);
  });

  it("says nothing about a request the client already reset", async () => {
    let fail!: (error: Error) => void;
    const t = host(() => new Promise((_, reject) => (fail = reject)));
    t.host.handleRequest(req());
    await flush();
    t.host.handleReset({ t: "rst", id: 1, d: "q", e: "" });
    fail(new Error("boom"));
    await flush();
    expect(t.sent).toEqual([]);
    expect(t.host.activeRequests).toBe(0);
  });

  it("stops streaming a response body once the client resets it", async () => {
    let next!: () => void;
    const t = host(async () =>
      ok(
        (async function* () {
          yield utf8Encode("one");
          await new Promise<void>((resolve) => (next = resolve));
          yield utf8Encode("two");
        })(),
      ),
    );
    t.host.handleRequest(req());
    await vi.waitFor(() => expect(next).toBeTypeOf("function"));
    t.host.handleReset({ t: "rst", id: 1, d: "q", e: "" });
    next();
    await flush();
    expect(t.body(1)).toBe("one");
    expect(t.chunks().some((c) => c.end)).toBe(false);
  });

  it("hands a followed redirect back as 302 for GET and 303 for other methods", async () => {
    const t = host(async (request) => ok([utf8Encode("x")], { finalUrl: `http://localhost:3400/moved?from=${request.method}` }));
    t.host.handleRequest(req());
    t.host.handleRequest(req({ id: 2, m: "POST" }));
    await flush();
    expect(t.controls()).toEqual([
      { t: "res", id: 1, st: 302, h: [["location", "/moved?from=GET"]], b: false },
      { t: "res", id: 2, st: 303, h: [["location", "/moved?from=POST"]], b: false },
    ]);
  });

  it("treats a final URL equal to the requested one as no redirect", async () => {
    const t = host(async (request) => ok([utf8Encode("body")], { finalUrl: request.url }));
    t.host.handleRequest(req({ p: "/same" }));
    await flush();
    expect(t.controls()[0]).toEqual({ t: "res", id: 1, st: 200, h: [], b: true });
    expect(t.body(1)).toBe("body");
  });

  it("passes on a 3xx without a Location, and one whose Location stays on target", async () => {
    const t = host(async (request) => (request.url.endsWith("/a") ? ok(null, { status: 304 }) : ok(null, { status: 307, headers: [["Location", "http://localhost:3400/b"]] })));
    t.host.handleRequest(req({ p: "/a" }));
    t.host.handleRequest(req({ id: 2, p: "/c" }));
    await flush();
    expect(t.controls()).toEqual([
      { t: "res", id: 1, st: 304, h: [], b: false },
      { t: "res", id: 2, st: 307, h: [["Location", "/b"]], b: false },
    ]);
  });

  it("aborts every running request when the link closes", async () => {
    const signals: AbortSignal[] = [];
    const t = host((request) => (signals.push(request.signal), new Promise(() => {})));
    t.host.handleRequest(req());
    t.host.handleRequest(req({ id: 2, m: "POST", b: true }));
    await flush();
    t.host.closeAll();
    expect(signals.map((s) => s.aborted)).toEqual([true]);
    // The fetch that has not settled still counts; the one waiting for a body does not.
    expect(t.host.activeRequests).toBe(1);
    t.host.handleReset({ t: "rst", id: 99, d: "q", e: "" });
  });

  it("does not throw when the channel is gone while answering", async () => {
    const t = host(async () => {
      throw new Error("down");
    });
    t.channel.broken = "always";
    t.host.handleRequest(req({ s: "nope" }));
    t.host.handleRequest(req({ id: 2 }));
    await flush();
    expect(t.host.activeRequests).toBe(0);
  });
});

describe("HttpClient", () => {
  const client = () => {
    const r = recorder();
    return { ...r, client: new HttpClient(r.channel) };
  };
  const lastReq = (controls: ControlFrame[]) => controls.filter((f) => f.t === "req").at(-1) as HttpRequestFrame;

  it("sends the method upper-cased with increasing stream ids and announces a body only when there is one", async () => {
    const c = client();
    void c.client.request("atlas", { method: "post", path: "/a", body: new Uint8Array(0) }).catch(() => {});
    void c.client.request("atlas", { method: "put", path: "/b", headers: [["x", "y"]], body: Uint8Array.of(1) }).catch(() => {});
    await flush();
    expect(c.controls()).toEqual([
      { t: "req", id: 1, s: "atlas", m: "POST", p: "/a", h: [], b: false },
      { t: "req", id: 2, s: "atlas", m: "PUT", p: "/b", h: [["x", "y"]], b: true },
    ]);
    expect(c.chunks()).toEqual([
      { kind: CHUNK_KIND.requestBody, id: 2, end: false, payload: Uint8Array.of(1) },
      { kind: CHUNK_KIND.requestBody, id: 2, end: true, payload: new Uint8Array(0) },
    ]);
    c.client.close();
  });

  it("ignores responses and chunks for unknown streams, and a second response for the same stream", async () => {
    const c = client();
    const pending = c.client.request("atlas", { method: "GET", path: "/" });
    c.client.handleResponse({ t: "res", id: 99, st: 200, h: [], b: false });
    c.client.handleChunk({ kind: CHUNK_KIND.responseBody, id: 1, end: true, payload: utf8Encode("early") });
    c.client.handleResponse({ t: "res", id: 1, st: 201, h: [["a", "b"]], b: true });
    c.client.handleResponse({ t: "res", id: 1, st: 500, h: [], b: false });
    c.client.handleChunk({ kind: CHUNK_KIND.responseBody, id: 1, end: true, payload: utf8Encode("body") });
    const response = await pending;
    expect(response.status).toBe(201);
    expect(response.headers).toEqual([["a", "b"]]);
    expect(utf8Decode(await response.bytes())).toBe("body");
  });

  it("yields body chunks as they arrive through async iteration", async () => {
    const c = client();
    const pending = c.client.request("atlas", { method: "GET", path: "/" });
    c.client.handleResponse({ t: "res", id: 1, st: 200, h: [], b: true });
    const response = await pending;
    const iterator = response.body[Symbol.asyncIterator]();
    const first = iterator.next();
    c.client.handleChunk({ kind: CHUNK_KIND.responseBody, id: 1, end: false, payload: utf8Encode("a") });
    expect(utf8Decode((await first).value)).toBe("a");
    c.client.handleChunk({ kind: CHUNK_KIND.responseBody, id: 1, end: true, payload: new Uint8Array(0) });
    expect((await iterator.next()).done).toBe(true);
  });

  it("accepts a body of exactly the response limit and refuses one byte more", async () => {
    const c = client();
    const exact = c.client.request("atlas", { method: "GET", path: "/", maxResponseBytes: 4 });
    c.client.handleResponse({ t: "res", id: 1, st: 200, h: [], b: true });
    c.client.handleChunk({ kind: CHUNK_KIND.responseBody, id: 1, end: true, payload: Uint8Array.of(1, 2, 3, 4) });
    expect(await (await exact).bytes()).toEqual(Uint8Array.of(1, 2, 3, 4));

    const over = c.client.request("atlas", { method: "GET", path: "/", maxResponseBytes: 4 });
    c.client.handleResponse({ t: "res", id: 2, st: 200, h: [], b: true });
    c.client.handleChunk({ kind: CHUNK_KIND.responseBody, id: 2, end: false, payload: Uint8Array.of(1, 2, 3) });
    c.client.handleChunk({ kind: CHUNK_KIND.responseBody, id: 2, end: false, payload: Uint8Array.of(4, 5) });
    const error = await (await over).bytes().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GhostlyHttpError);
    expect((error as GhostlyHttpError).code).toBe("response-too-large");
    expect(c.controls().at(-1)).toEqual({ t: "rst", id: 2, d: "q", e: "Response body too large" });
  });

  it("times out when the peer never answers, and resets the stream", async () => {
    vi.useFakeTimers();
    const c = client();
    const pending = c.client.request("atlas", { method: "GET", path: "/" });
    const failed = expect(pending).rejects.toMatchObject({ code: "timeout", message: "The peer did not answer in time" });
    await vi.advanceTimersByTimeAsync(LIMITS.requestTimeoutMs + 5_000);
    await failed;
    expect(c.controls().at(-1)).toEqual({ t: "rst", id: 1, d: "q", e: "The peer did not answer in time" });
  });

  it("times out a response body that stops arriving", async () => {
    vi.useFakeTimers();
    const c = client();
    const pending = c.client.request("atlas", { method: "GET", path: "/" });
    c.client.handleResponse({ t: "res", id: 1, st: 200, h: [], b: true });
    const response = await pending;
    const body = response.bytes().catch((e: GhostlyHttpError) => e.code);
    await vi.advanceTimersByTimeAsync(LIMITS.bodyIdleTimeoutMs - 1);
    c.client.handleChunk({ kind: CHUNK_KIND.responseBody, id: 1, end: false, payload: Uint8Array.of(1) });
    await vi.advanceTimersByTimeAsync(LIMITS.bodyIdleTimeoutMs);
    expect(await body).toBe("timeout");
  });

  it("aborts on the caller's signal and tells the peer", async () => {
    const c = client();
    const controller = new AbortController();
    const pending = c.client.request("atlas", { method: "GET", path: "/", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(c.controls().at(-1)).toEqual({ t: "rst", id: 1, d: "q", e: "Request aborted" });
    // A late response for the aborted stream is ignored.
    c.client.handleResponse({ t: "res", id: 1, st: 200, h: [], b: false });
  });

  it("fails with the peer's reason on reset, or a default one, without resetting back", async () => {
    const c = client();
    const a = c.client.request("atlas", { method: "GET", path: "/" });
    const b = c.client.request("atlas", { method: "GET", path: "/" });
    c.client.handleReset({ t: "rst", id: 1, d: "s", e: "gone" });
    c.client.handleReset({ t: "rst", id: 2, d: "s", e: "" });
    await expect(a).rejects.toMatchObject({ code: "reset", message: "gone" });
    await expect(b).rejects.toMatchObject({ code: "reset", message: "Request reset by peer" });
    expect(c.controls().filter((f) => f.t === "rst")).toEqual([]);
  });

  it("fails a request whose frame cannot be sent, and frees its slot", async () => {
    const c = client();
    c.channel.broken = "always";
    for (let i = 0; i < LIMITS.maxClientInFlight + 2; i++) {
      await expect(c.client.request("atlas", { method: "GET", path: "/" })).rejects.toThrow("Data link is not open");
    }
    c.channel.broken = "never";
    void c.client.request("atlas", { method: "GET", path: "/" }).catch(() => {});
    await flush();
    expect(c.controls()).toHaveLength(1);
    c.client.close();
  });

  it("fails a request whose body cannot be sent", async () => {
    const c = client();
    c.channel.broken = "binary";
    await expect(c.client.request("atlas", { method: "POST", path: "/", body: Uint8Array.of(1) })).rejects.toThrow("Data link is not open");
    expect(c.controls().at(-1)).toEqual({ t: "rst", id: 1, d: "q", e: "Data link is not open" });
  });

  it("refuses a control frame that would exceed the frame limit", async () => {
    const c = client();
    await expect(c.client.request("atlas", { method: "GET", path: "/", headers: [["x", "v".repeat(LIMITS.maxControlFrameBytes)]] })).rejects.toThrow(
      "Control frame too large",
    );
  });

  it("queues requests beyond the in-flight limit and releases them as slots free", async () => {
    const c = client();
    const first = Array.from({ length: LIMITS.maxClientInFlight }, () => c.client.request("atlas", { method: "GET", path: "/" }));
    const queued = c.client.request("atlas", { method: "GET", path: "/queued" });
    await flush();
    expect(c.controls()).toHaveLength(LIMITS.maxClientInFlight);
    c.client.handleResponse({ t: "res", id: 1, st: 204, h: [], b: false });
    await first[0];
    await flush();
    expect(lastReq(c.controls())).toMatchObject({ p: "/queued", id: LIMITS.maxClientInFlight + 1 });
    c.client.close();
    await expect(queued).rejects.toMatchObject({ code: "closed" });
    await Promise.allSettled(first);
  });

  it("fails queued requests when the link closes before a slot frees", async () => {
    const c = client();
    const first = Array.from({ length: LIMITS.maxClientInFlight }, () => c.client.request("atlas", { method: "GET", path: "/" }));
    const queued = c.client.request("atlas", { method: "GET", path: "/queued" });
    c.client.close();
    await expect(queued).rejects.toMatchObject({ code: "closed", message: "Data link is closed" });
    for (const request of first) await expect(request).rejects.toMatchObject({ code: "closed", message: "Data link closed" });
    expect(c.controls().filter((f) => f.t === "rst")).toEqual([]);
    expect(lastReq(c.controls()).p).toBe("/");
  });

  it("errors a body that is still streaming when the link closes", async () => {
    const c = client();
    const pending = c.client.request("atlas", { method: "GET", path: "/" });
    c.client.handleResponse({ t: "res", id: 1, st: 200, h: [], b: true });
    const response = await pending;
    c.client.close();
    await expect(response.bytes()).rejects.toMatchObject({ code: "closed" });
  });
});

describe("webLocalFetch", () => {
  function fakeResponse(chunks: Uint8Array[] | null, patch: Record<string, unknown> = {}) {
    let cancelled = false;
    const body = chunks
      ? new ReadableStream<Uint8Array>({
          pull(controller) {
            const next = chunks.shift();
            if (next) controller.enqueue(next);
            else controller.close();
          },
          cancel() {
            cancelled = true;
          },
        })
      : null;
    return { response: { status: 200, headers: new Headers([["x-a", "1"], ["x-b", "2"]]), body, redirected: false, url: "", ...patch }, cancelled: () => cancelled };
  }
  const request = (patch: Partial<LocalRequest> = {}): LocalRequest => ({
    url: "http://localhost:3400/x", method: "POST", headers: [], body: Uint8Array.of(1), signal: new AbortController().signal, ...patch,
  });

  it("calls fetch without credentials, cache or referrer, following redirects, and skips headers the platform rejects", async () => {
    const fetch = vi.fn(async () => fakeResponse(null).response);
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    const result = await webLocalFetch(request({ headers: [["x-ok", "1"], ["bad name", "2"], ["x-bad", "a\nb"]], signal }));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3400/x");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store", redirect: "follow", referrerPolicy: "no-referrer", signal });
    expect([...(init.headers as Headers)]).toEqual([["x-ok", "1"]]);
    expect(result).toEqual({ status: 200, headers: [["x-a", "1"], ["x-b", "2"]], body: null, finalUrl: undefined });
  });

  it("streams the body, skipping empty reads, and reports where a redirect ended", async () => {
    const fake = fakeResponse([Uint8Array.of(1), new Uint8Array(0), Uint8Array.of(2, 3)], { redirected: true, url: "http://localhost:3400/y" });
    vi.stubGlobal("fetch", vi.fn(async () => fake.response));
    const result = await webLocalFetch(request());
    expect(result.finalUrl).toBe("http://localhost:3400/y");
    const parts: number[][] = [];
    for await (const part of result.body as AsyncIterable<Uint8Array>) parts.push([...part]);
    expect(parts).toEqual([[1], [2, 3]]);
  });

  it("cancels the underlying stream when the reader stops early", async () => {
    const fake = fakeResponse([Uint8Array.of(1), Uint8Array.of(2)]);
    vi.stubGlobal("fetch", vi.fn(async () => fake.response));
    const result = await webLocalFetch(request());
    for await (const part of result.body as AsyncIterable<Uint8Array>) {
      expect([...part]).toEqual([1]);
      break;
    }
    await vi.waitFor(() => expect(fake.cancelled()).toBe(true));
  });
});
