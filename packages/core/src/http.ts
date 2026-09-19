import { concatBytes, utf8Encode } from "./bytes";
import {
  CHUNK_KIND,
  LIMITS,
  encodeControl,
  sendBody,
  type ChunkFrame,
  type FrameChannel,
  type HeaderList,
  type HttpRequestFrame,
  type HttpResponseFrame,
  type ResetFrame,
} from "./frames";

/**
 * HTTP over the Ghostly data link (`ghostly-http/1`).
 *
 * The client names a service id and an origin-form path. The host owns the
 * mapping from service id to a loopback target the user configured; nothing a
 * remote peer sends can change where a request goes.
 */

// ---------------------------------------------------------------------------
// Local targets
// ---------------------------------------------------------------------------

export interface LocalTarget {
  /** e.g. `http://localhost:3400` */
  origin: string;
  /** Path prefix without trailing slash, `""` for the root. */
  basePath: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Accepts `localhost:3400`, `http://127.0.0.1:8080/app`, … and nothing that is not loopback. */
export function parseLocalTarget(input: string): LocalTarget {
  let text = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https targets are supported");
  if (url.username || url.password) throw new Error("Credentials in the target URL are not supported");
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("Only services on this machine can be shared (localhost, 127.0.0.1 or [::1])");
  }
  if (url.search || url.hash) throw new Error("The target cannot contain a query or fragment");
  return { origin: url.origin, basePath: url.pathname.replace(/\/+$/, "") };
}

export function formatLocalTarget(target: LocalTarget): string {
  return `${target.origin}${target.basePath}`;
}

/**
 * Resolves a peer-supplied path against the configured target. Returns null
 * unless the result stays on the target origin and under its base path.
 */
export function resolveTargetUrl(target: LocalTarget, path: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 32 || code === 127 || char === "\\") return null;
  }
  let url: URL;
  try {
    url = new URL(`${target.origin}${target.basePath}${path}`);
  } catch {
    return null;
  }
  if (url.origin !== target.origin || url.username || url.password) return null;
  if (target.basePath && url.pathname !== target.basePath && !url.pathname.startsWith(`${target.basePath}/`)) {
    return null;
  }
  return url.href;
}

// ---------------------------------------------------------------------------
// Header hygiene
// ---------------------------------------------------------------------------

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Set by the host's own HTTP stack, or meaningless once proxied. */
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "origin",
  "referer",
  "content-length",
  "accept-encoding",
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

/** The local fetch decodes the body, so the encoding headers no longer apply. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "strict-transport-security",
  "alt-svc",
  "public-key-pins",
]);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function isCleanHeaderValue(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0 || code === 10 || code === 13) return false;
  }
  return true;
}

export function sanitizeRequestHeaders(headers: HeaderList): HeaderList {
  return headers.filter(([name, value]) => {
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name) || !isCleanHeaderValue(value)) return false;
    if (HOP_BY_HOP.has(lower) || DROPPED_REQUEST_HEADERS.has(lower)) return false;
    return !lower.startsWith("sec-") && !lower.startsWith("proxy-");
  });
}

export function sanitizeResponseHeaders(headers: HeaderList, target: LocalTarget): HeaderList {
  const out: HeaderList = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name) || !isCleanHeaderValue(value)) continue;
    if (HOP_BY_HOP.has(lower) || DROPPED_RESPONSE_HEADERS.has(lower)) continue;
    if (lower === "location" || lower === "content-location") {
      out.push([name, relativizeLocation(value, target)]);
    } else if (lower === "set-cookie") {
      // The cookie belongs to the virtual origin on the client, not to localhost.
      out.push([name, value.replace(/;\s*domain\s*=[^;]*/gi, "")]);
    } else {
      out.push([name, value]);
    }
  }
  return out;
}

/** Turns `http://localhost:3400/base/x` into `/x` so the client never learns or follows the local address. */
export function relativizeLocation(location: string, target: LocalTarget): string {
  let url: URL;
  try {
    url = new URL(location, `${target.origin}${target.basePath}/`);
  } catch {
    return location;
  }
  if (url.origin !== target.origin) return location;
  let path = url.pathname;
  if (target.basePath && (path === target.basePath || path.startsWith(`${target.basePath}/`))) {
    path = path.slice(target.basePath.length) || "/";
  }
  return `${path}${url.search}${url.hash}`;
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export interface HostedHttpService {
  id: string;
  target: LocalTarget;
}

export interface LocalRequest {
  url: string;
  method: string;
  headers: HeaderList;
  body: Uint8Array | null;
  signal: AbortSignal;
}

export interface LocalResponse {
  status: number;
  headers: HeaderList;
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | null;
  /** Final URL when the local stack followed redirects on its own. */
  finalUrl?: string;
}

/** Performs the request against the local service. Browser: `fetch`. Desktop: the Rust side. */
export type LocalFetch = (request: LocalRequest) => Promise<LocalResponse>;

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

interface HostStream {
  frame: HttpRequestFrame;
  service: HostedHttpService;
  url: string;
  body: Uint8Array[];
  bodyBytes: number;
  abort: AbortController;
  started: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export class HttpHost {
  private readonly streams = new Map<number, HostStream>();

  constructor(
    private readonly channel: FrameChannel,
    private readonly getService: (id: string) => HostedHttpService | undefined,
    private readonly localFetch: LocalFetch,
  ) {}

  get activeRequests(): number {
    return this.streams.size;
  }

  handleRequest(frame: HttpRequestFrame): void {
    if (this.streams.has(frame.id)) return;

    const method = frame.m.toUpperCase();
    const service = this.getService(frame.s);
    if (!service) return this.fail(frame.id, 404, "unknown-service", "This peer does not share that service.");
    if (!ALLOWED_METHODS.has(method)) return this.fail(frame.id, 405, "method-not-allowed", "Method not allowed.");
    if (this.streams.size >= LIMITS.maxConcurrentRequestsPerPeer) {
      return this.fail(frame.id, 503, "busy", "Too many concurrent requests.");
    }
    const url = resolveTargetUrl(service.target, frame.p);
    if (!url) return this.fail(frame.id, 400, "bad-path", "Invalid request path.");

    const stream: HostStream = {
      frame: { ...frame, m: method },
      service,
      url,
      body: [],
      bodyBytes: 0,
      abort: new AbortController(),
      started: false,
    };
    this.streams.set(frame.id, stream);

    if (frame.b && !BODYLESS_METHODS.has(method)) this.armIdleTimer(stream);
    else void this.run(stream);
  }

  handleChunk(chunk: ChunkFrame): void {
    const stream = this.streams.get(chunk.id);
    if (!stream || stream.started) return;

    stream.bodyBytes += chunk.payload.length;
    if (stream.bodyBytes > LIMITS.maxRequestBodyBytes) {
      this.end(stream);
      return this.fail(chunk.id, 413, "request-too-large", "Request body too large.");
    }
    if (chunk.payload.length > 0) stream.body.push(chunk.payload.slice());
    if (chunk.end) void this.run(stream);
    else this.armIdleTimer(stream);
  }

  handleReset(frame: ResetFrame): void {
    const stream = this.streams.get(frame.id);
    if (stream) this.end(stream);
  }

  closeAll(): void {
    for (const stream of [...this.streams.values()]) this.end(stream);
  }

  private armIdleTimer(stream: HostStream): void {
    clearTimeout(stream.idleTimer);
    stream.idleTimer = setTimeout(() => {
      this.end(stream);
      this.fail(stream.frame.id, 408, "request-timeout", "Request body timed out.");
    }, LIMITS.bodyIdleTimeoutMs);
  }

  private end(stream: HostStream): void {
    clearTimeout(stream.idleTimer);
    stream.abort.abort();
    this.streams.delete(stream.frame.id);
  }

  private fail(id: number, status: number, code: string, message: string): void {
    const body = utf8Encode(`${message}\n`);
    try {
      this.channel.send(
        encodeControl({
          t: "res",
          id,
          st: status,
          h: [
            ["content-type", "text/plain; charset=utf-8"],
            ["x-ghostly-error", code],
          ],
          b: true,
        }),
      );
      void sendBody(this.channel, CHUNK_KIND.responseBody, id, [body]).catch(() => {});
    } catch {
      // channel already closed
    }
  }

  private async run(stream: HostStream): Promise<void> {
    stream.started = true;
    clearTimeout(stream.idleTimer);
    const { frame, service } = stream;
    const timeout = setTimeout(() => stream.abort.abort(), LIMITS.requestTimeoutMs);
    let headersSent = false;

    try {
      const response = await this.localFetch({
        url: stream.url,
        method: frame.m,
        headers: sanitizeRequestHeaders(frame.h),
        body: stream.body.length > 0 ? concatBytes(...stream.body) : null,
        signal: stream.abort.signal,
      });
      stream.body = [];
      clearTimeout(timeout);
      if (!this.streams.has(frame.id)) return;

      if (response.finalUrl && response.finalUrl !== stream.url) {
        // The local stack followed a redirect. Hand it back to the client so its
        // address bar and relative URLs stay right, but never off the target.
        const location = relativizeLocation(response.finalUrl, service.target);
        if (!location.startsWith("/")) {
          this.end(stream);
          return this.fail(frame.id, 502, "redirect-blocked", "The service redirected outside of the shared target.");
        }
        this.channel.send(
          encodeControl({
            t: "res",
            id: frame.id,
            st: BODYLESS_METHODS.has(frame.m) ? 302 : 303,
            h: [["location", location]],
            b: false,
          }),
        );
        this.end(stream);
        return;
      }

      const hasBody = response.body !== null && frame.m !== "HEAD";
      const res: HttpResponseFrame = {
        t: "res",
        id: frame.id,
        st: response.status,
        h: sanitizeResponseHeaders(response.headers, service.target),
        b: hasBody,
      };
      this.channel.send(encodeControl(res));
      headersSent = true;
      if (hasBody && response.body) {
        await sendBody(this.channel, CHUNK_KIND.responseBody, frame.id, response.body, () => !this.streams.has(frame.id));
      }
      this.end(stream);
    } catch (error) {
      clearTimeout(timeout);
      if (!this.streams.has(frame.id)) return;
      this.end(stream);
      if (headersSent) {
        try {
          this.channel.send(encodeControl({ t: "rst", id: frame.id, d: "s", e: "The local service dropped the response." }));
        } catch {
          // channel already closed
        }
      } else if (stream.abort.signal.aborted && (error as Error)?.name === "AbortError") {
        this.fail(frame.id, 504, "timeout", "The local service did not answer in time.");
      } else {
        this.fail(frame.id, 502, "unreachable", "The local service is not reachable.");
      }
    }
  }
}

/** `LocalFetch` on top of the web `fetch` API, for any host that has one. */
export const webLocalFetch: LocalFetch = async (request) => {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    try {
      headers.append(name, value);
    } catch {
      // header rejected by the platform
    }
  }
  const response = await fetch(request.url, {
    method: request.method,
    headers,
    body: request.body as BodyInit | null,
    signal: request.signal,
    // Never the host user's own cookies or HTTP auth: a remote peer must not
    // inherit the session the host has with its local application.
    credentials: "omit",
    cache: "no-store",
    redirect: "follow",
    referrerPolicy: "no-referrer",
  });

  const responseHeaders: HeaderList = [];
  response.headers.forEach((value, name) => responseHeaders.push([name, value]));

  return {
    status: response.status,
    headers: responseHeaders,
    body: response.body ? readStream(response.body) : null,
    finalUrl: response.redirected ? response.url : undefined,
  };
};

async function* readStream(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.length > 0) yield value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ClientRequest {
  method: string;
  path: string;
  headers?: HeaderList;
  body?: Uint8Array | null;
  signal?: AbortSignal;
  maxResponseBytes?: number;
}

export interface ClientResponse {
  status: number;
  headers: HeaderList;
  body: AsyncIterable<Uint8Array>;
  /** Collects the whole body, bounded by `maxResponseBytes`. */
  bytes(): Promise<Uint8Array>;
}

export class GhostlyHttpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface ClientStream {
  resolve: (response: ClientResponse) => void;
  reject: (error: Error) => void;
  headersTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  queue: BodyQueue | null;
  received: number;
  maxBytes: number;
}

class BodyQueue implements AsyncIterable<Uint8Array> {
  private chunks: Uint8Array[] = [];
  private done = false;
  private error: Error | null = null;
  private wake: (() => void) | null = null;

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.wake?.();
  }

  finish(error?: Error): void {
    if (this.done) return;
    this.done = true;
    this.error = error ?? null;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (;;) {
      while (this.chunks.length > 0) yield this.chunks.shift()!;
      if (this.error) throw this.error;
      if (this.done) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

export class HttpClient {
  private nextId = 1;
  private readonly streams = new Map<number, ClientStream>();
  private readonly waiting: (() => void)[] = [];
  private inFlight = 0;
  private closed = false;

  constructor(private readonly channel: FrameChannel) {}

  async request(serviceId: string, request: ClientRequest): Promise<ClientResponse> {
    if (this.closed) throw new GhostlyHttpError("closed", "Data link is closed");
    if (this.inFlight >= LIMITS.maxClientInFlight) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
      if (this.closed) throw new GhostlyHttpError("closed", "Data link is closed");
    }
    this.inFlight++;

    const id = this.nextId++;
    const body = request.body && request.body.length > 0 ? request.body : null;
    if (body && body.length > LIMITS.maxRequestBodyBytes) {
      this.release();
      throw new GhostlyHttpError("request-too-large", "Request body too large");
    }

    return new Promise<ClientResponse>((resolve, reject) => {
      const stream: ClientStream = {
        resolve,
        reject,
        queue: null,
        received: 0,
        maxBytes: request.maxResponseBytes ?? LIMITS.maxResponseBodyBytes,
      };
      this.streams.set(id, stream);
      stream.headersTimer = setTimeout(
        () => this.abort(id, new GhostlyHttpError("timeout", "The peer did not answer in time")),
        LIMITS.requestTimeoutMs + 5_000,
      );
      request.signal?.addEventListener("abort", () => this.abort(id, new GhostlyHttpError("aborted", "Request aborted")));

      try {
        this.channel.send(
          encodeControl({
            t: "req",
            id,
            s: serviceId,
            m: request.method.toUpperCase(),
            p: request.path,
            h: request.headers ?? [],
            b: body !== null,
          }),
        );
        if (body) {
          sendBody(this.channel, CHUNK_KIND.requestBody, id, [body], () => !this.streams.has(id)).catch((error) =>
            this.abort(id, error as Error),
          );
        }
      } catch (error) {
        this.abort(id, error as Error, false);
      }
    });
  }

  handleResponse(frame: HttpResponseFrame): void {
    const stream = this.streams.get(frame.id);
    if (!stream || stream.queue) return;
    clearTimeout(stream.headersTimer);

    const queue = new BodyQueue();
    stream.queue = queue;
    if (frame.b) this.armIdleTimer(frame.id, stream);
    else this.finish(frame.id);

    stream.resolve({
      status: frame.st,
      headers: frame.h,
      body: queue,
      bytes: async () => {
        const parts: Uint8Array[] = [];
        for await (const part of queue) parts.push(part);
        return concatBytes(...parts);
      },
    });
  }

  handleChunk(chunk: ChunkFrame): void {
    const stream = this.streams.get(chunk.id);
    if (!stream?.queue) return;

    stream.received += chunk.payload.length;
    if (stream.received > stream.maxBytes) {
      return this.abort(chunk.id, new GhostlyHttpError("response-too-large", "Response body too large"));
    }
    if (chunk.payload.length > 0) stream.queue.push(chunk.payload.slice());
    if (chunk.end) this.finish(chunk.id);
    else this.armIdleTimer(chunk.id, stream);
  }

  handleReset(frame: ResetFrame): void {
    this.abort(frame.id, new GhostlyHttpError("reset", frame.e || "Request reset by peer"), false);
  }

  close(): void {
    this.closed = true;
    for (const id of [...this.streams.keys()]) {
      this.abort(id, new GhostlyHttpError("closed", "Data link closed"), false);
    }
    for (const wake of this.waiting.splice(0)) wake();
  }

  private armIdleTimer(id: number, stream: ClientStream): void {
    clearTimeout(stream.idleTimer);
    stream.idleTimer = setTimeout(
      () => this.abort(id, new GhostlyHttpError("timeout", "Response body timed out")),
      LIMITS.bodyIdleTimeoutMs,
    );
  }

  private finish(id: number): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    clearTimeout(stream.headersTimer);
    clearTimeout(stream.idleTimer);
    this.streams.delete(id);
    stream.queue?.finish();
    this.release();
  }

  private abort(id: number, error: Error, notifyPeer = true): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    clearTimeout(stream.headersTimer);
    clearTimeout(stream.idleTimer);
    this.streams.delete(id);
    if (stream.queue) stream.queue.finish(error);
    else stream.reject(error);
    if (notifyPeer) {
      try {
        this.channel.send(encodeControl({ t: "rst", id, d: "q", e: error.message }));
      } catch {
        // channel already closed
      }
    }
    this.release();
  }

  private release(): void {
    this.inFlight--;
    this.waiting.shift()?.();
  }
}
