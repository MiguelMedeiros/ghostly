import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GhostlyHttpError, LIMITS, type ClientRequest, type ClientResponse, type LocalFetch } from "@ghostly/core";
import { bool, chatOf, node, num, state, str, type Method } from "./apiKit";
import { CliError } from "./errors";
import { isLive } from "./views";

/**
 * Shared services (WISP 700/701, WISP 11xx phase 3b): a web app on this machine a contact may open over the chat's live
 * link, and a contact's app opened here on a loopback port. As on the Desktop: only loopback is reached, redirects are
 * handed back rather than followed, and a service is shared with each contact by name, never by default.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The engine's way to reach a shared app: loopback only, no redirect followed, no cookies (Node sends none). */
export const nodeLocalFetch: LocalFetch = async (request) => {
  const url = new URL(request.url);
  if (!["http:", "https:"].includes(url.protocol) || !(LOOPBACK.has(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname))) {
    throw new Error("Shared services are reached on this machine only");
  }
  const response = await fetch(url, { method: request.method, headers: request.headers, body: request.body as BodyInit | null, signal: request.signal, redirect: "manual", ...(request.body ? { duplex: "half" } : {}) } as RequestInit);
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => headers.push([name, value]));
  return {
    status: response.status, headers,
    body: response.body ? (async function* () {
      const reader = response.body!.getReader();
      try { for (;;) { const { done, value } = await reader.read(); if (done) return; if (value?.length) yield value; } } finally { reader.cancel().catch(() => {}); }
    })() : null,
  };
};

/** Contact services open on loopback ports, by `<peer>/<service>`, while this process runs. */
const open = new Map<string, OpenedService>();
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Cookie names an opened service may set and have passed back (browsers keep about 180 per host). */
const MAX_COOKIE_NAMES = 256;

/**
 * The cookie that shows a browser was given this service's link here. It is this machine's, never the contact's:
 * it is not passed on to the contact, and a `Set-Cookie` from the contact by that name is dropped.
 */
export const OPEN_COOKIE = "ghostly_open";
/** The link `service open` prints: it sets `OPEN_COOKIE` and sends the browser on to `/`. */
const OPEN_PATH = "/.ghostly-open/";

/**
 * Only the cookies this service set itself (by name, from its own `Set-Cookie`) go on to the contact; any other a
 * browser sends (one set for localhost by another app here, this machine's `OPEN_COOKIE`) stays here.
 */
export function ownCookies(header: string, names: ReadonlySet<string>): string | null {
  const kept = header.split(";").map((pair) => pair.trim()).filter((pair) => {
    const at = pair.indexOf("=");
    const name = at > 0 ? pair.slice(0, at).trim() : "";
    return !!name && name !== OPEN_COOKIE && names.has(name);
  });
  return kept.length ? kept.join("; ") : null;
}

/** The cookie a `Set-Cookie` sets, by name. */
export function setCookieName(value: string): string | null {
  const at = value.indexOf("="), end = value.indexOf(";");
  if (at <= 0 || (end !== -1 && end < at)) return null;
  return value.slice(0, at).trim() || null;
}

/**
 * A contact's `Set-Cookie` as this machine passes it to the browser: without `Domain`, so the cookie stays on the
 * service's own host name (not every *.localhost). Null for one this machine does not take (`OPEN_COOKIE`, no name).
 */
export function hostOnlyCookie(value: string): string | null {
  const name = setCookieName(value);
  if (!name || name === OPEN_COOKIE) return null;
  return value.split(";").filter((part, i) => i === 0 || !/^\s*domain\s*(=|$)/i.test(part)).join(";");
}

/** A cookie's values in a `Cookie` header, by name (a page may set another by the same name on a narrower path). */
function cookieValues(header: string | undefined, name: string): string[] {
  return (header ?? "").split(";").flatMap((pair) => {
    const at = pair.indexOf("=");
    return at > 0 && pair.slice(0, at).trim() === name ? [pair.slice(at + 1).trim()] : [];
  });
}

function sameSecret(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** How an opened service reaches the contact's app: the engine's `request` for that contact and service. */
export type ServiceSend = (request: ClientRequest) => Promise<ClientResponse>;

export interface OpenedService {
  server: Server;
  /** The link to open: it hands the browser this service's cookie, then shows `/`. */
  url: string;
  /** The service's own host name, `<random>.localhost:<port>`: any other `Host` is not this service. */
  host: string;
}

function plain(response: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(text);
}

/**
 * A contact's app on a loopback port of this machine, under a host name of its own (`<random>.localhost`): its
 * cookies and storage are its own, apart from any other app on 127.0.0.1 or localhost, and a name that merely
 * resolves here (DNS rebinding) is not it. Only a browser given the link (which sets `OPEN_COOKIE`) is served; anyone
 * else on this machine who finds the port gets 404. The body streams through, bounded by `MAX_RESPONSE_BYTES`.
 */
export async function openServiceServer(send: ServiceSend, port = 0): Promise<OpenedService> {
  const name = `${randomBytes(16).toString("hex")}.localhost`;
  const token = randomBytes(32).toString("hex");
  const cookies = new Set<string>();
  let host = "";
  const server = createServer((request, response) => {
    if (request.headers.host?.toLowerCase() !== host) return plain(response, 404, "Not found");
    const path = request.url ?? "/";
    if (path.startsWith(OPEN_PATH)) {
      if (!sameSecret(path.slice(OPEN_PATH.length), token)) return plain(response, 404, "Not found");
      return plain(response, 303, "", { location: "/", "referrer-policy": "no-referrer", "set-cookie": `${OPEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (!cookieValues(request.headers.cookie, OPEN_COOKIE).some((value) => sameSecret(value, token))) return plain(response, 404, "Not found");
    const chunks: Buffer[] = [];
    let size = 0, refused = false;
    request.on("data", (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > LIMITS.maxRequestBodyBytes) {
        refused = true;
        chunks.length = 0;
        plain(response, 413, "The request body is too large", { connection: "close" });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => { if (!refused) void proxy(request, response, chunks, send, cookies); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  host = `${name}:${(server.address() as AddressInfo).port}`;
  return { server, host, url: `http://${host}${OPEN_PATH}${token}` };
}

async function proxy(request: IncomingMessage, response: ServerResponse, chunks: Buffer[], send: ServiceSend, cookies: Set<string>): Promise<void> {
  // A browser that goes away stops the contact's answer too.
  const stop = new AbortController();
  response.on("close", () => { if (!response.writableFinished) stop.abort(); });
  try {
    const headers = Object.entries(request.headers).flatMap(([name, value]) => (Array.isArray(value) ? value.map((v) => [name, v] as [string, string]) : value === undefined ? [] : [[name, value] as [string, string]]))
      .flatMap(([name, value]): [string, string][] => {
        if (name.toLowerCase() !== "cookie") return [[name, value]];
        const own = ownCookies(value, cookies);
        return own ? [[name, own]] : [];
      });
    const answer = await send({ method: request.method ?? "GET", path: request.url ?? "/", headers, body: chunks.length ? new Uint8Array(Buffer.concat(chunks)) : null, maxResponseBytes: MAX_RESPONSE_BYTES, signal: stop.signal });
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of answer.headers) {
      const lower = name.toLowerCase();
      if (lower === "transfer-encoding" || lower === "connection") continue;
      if (lower === "set-cookie") {
        const cookie = hostOnlyCookie(value);
        if (!cookie) continue;
        if (cookies.size < MAX_COOKIE_NAMES) cookies.add(setCookieName(cookie)!);
        out[lower] = [...((out[lower] as string[] | undefined) ?? []), cookie];
      } else out[lower] = value;
    }
    response.writeHead(answer.status, out);
    // Streamed, not gathered: past the cap (or when the contact drops it) the body stops and the connection closes.
    await pipeline(Readable.from(answer.body, { objectMode: false }), response);
  } catch (error) {
    // Once the status line is out, a second one cannot follow: the response is cut, and the browser sees it end short.
    if (response.headersSent) { response.destroy(); return; }
    const gone = error instanceof GhostlyHttpError && ["unreachable", "timeout", "closed", "offline"].includes(error.code);
    plain(response, gone ? 503 : 502, gone ? "This service is not reachable. Services exist while their ghost is online." : `The request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const SERVICE_METHODS: Record<string, Method> = {
  async "service.list"(ctx) {
    return { services: state(ctx).services.map((s) => ({ id: s.id, name: s.name, target: s.target, enabled: s.enabled, sharedWith: s.sharedWith ?? [], requests: s.requests })) };
  },
  async "service.add"(ctx, params) {
    const target = str(params, "target", true);
    let url: URL;
    try { url = new URL(target); } catch { throw new CliError("bad_request", `Not a URL: ${target}`); }
    if (!(LOOPBACK.has(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname))) throw new CliError("refused", "Only a web app on this machine (127.0.0.1, localhost) can be shared");
    return node(ctx).addService({ name: str(params, "name", true), target });
  },
  async "service.remove"(ctx, params) {
    await node(ctx).removeService({ serviceId: str(params, "service", true) });
    return { removed: str(params, "service", true) };
  },
  async "service.enable"(ctx, params) {
    await node(ctx).setServiceEnabled({ serviceId: str(params, "service", true), enabled: !bool(params, "off") });
    return { service: str(params, "service", true), enabled: !bool(params, "off") };
  },
  async "service.share"(ctx, params) {
    const link = chatOf(ctx, params);
    const shared = !bool(params, "off");
    await node(ctx).setServiceShared({ serviceId: str(params, "service", true), peerPubKeyZ32: link.peerPubKeyZ32, shared });
    return { service: str(params, "service", true), chat: link.id, shared };
  },
  /** What a contact shares with this profile (while its app is live). */
  async "service.peer"(ctx, params) {
    const link = chatOf(ctx, params);
    return { chat: link.id, live: isLive(link), services: link.peerServices ?? [] };
  },
  /** A contact's shared app on a loopback port of this machine, as the Desktop opens it in a window. */
  async "service.open"(ctx, params) {
    if (ctx.mode !== "daemon") throw new CliError("unavailable", "An opened service lives in the daemon: start `ghostly daemon --detach` first");
    const link = chatOf(ctx, params);
    const service = str(params, "service", true);
    const key = `${link.peerPubKeyZ32}/${service}`;
    const already = open.get(key);
    if (already) return { chat: link.id, service, url: already.url };
    if (!link.peerServices?.some((s) => s.id === service)) throw new CliError("not_found", `The contact shares no service ${service} (or is not live)`);
    const peer = link.peerPubKeyZ32;
    const opened = await openServiceServer((request) => node(ctx).request(peer, service, request), num(params, "port", 0, { min: 0, max: 65535 }));
    open.set(key, opened);
    return { chat: link.id, service, url: opened.url };
  },
  async "service.close"(ctx, params) {
    const link = chatOf(ctx, params);
    const key = `${link.peerPubKeyZ32}/${str(params, "service", true)}`;
    const entry = open.get(key);
    if (!entry) throw new CliError("not_found", "That service is not open here");
    open.delete(key);
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
    return { closed: key };
  },
};
