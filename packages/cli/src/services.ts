import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GhostlyHttpError, type LocalFetch } from "@ghostly/core";
import { bool, chatOf, node, num, state, str, type Method } from "./apiKit";
import { CliError } from "./errors";

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
const open = new Map<string, { server: Server; url: string }>();
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Cookies are not kept apart by port: a browser sends a service opened on 127.0.0.1 every cookie any other app on
 * this machine set for 127.0.0.1 or localhost. Only the ones this service set itself (by name, from its own
 * `Set-Cookie`) go on to the contact; the rest stay here.
 */
export function ownCookies(header: string, names: ReadonlySet<string>): string | null {
  const kept = header.split(";").map((pair) => pair.trim()).filter((pair) => {
    const at = pair.indexOf("=");
    return at > 0 && names.has(pair.slice(0, at).trim());
  });
  return kept.length ? kept.join("; ") : null;
}

/** The cookie a `Set-Cookie` sets, by name. */
export function setCookieName(value: string): string | null {
  const at = value.indexOf("="), end = value.indexOf(";");
  if (at <= 0 || (end !== -1 && end < at)) return null;
  return value.slice(0, at).trim() || null;
}

/** A request's `Host` names this machine's loopback on `port`, as the URL `service.open` gives does. */
export function localHost(host: string | undefined, port: number): boolean {
  return !!host && ["127.0.0.1", "localhost", "[::1]"].some((name) => host.toLowerCase() === `${name}:${port}`);
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
    return { chat: link.id, live: link.textDelivery === "stream", services: link.peerServices ?? [] };
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
    const cookies = new Set<string>();
    const server = createServer((request, response) => {
      // Only a page on this port asks: a name that merely resolves here (DNS rebinding) is not this service.
      if (!localHost(request.headers.host, (server.address() as AddressInfo).port)) { response.writeHead(421, { "content-type": "text/plain; charset=utf-8" }); response.end("Open this service at 127.0.0.1 or localhost"); return; }
      const chunks: Buffer[] = [];
      request.on("data", (c: Buffer) => chunks.push(c));
      request.on("end", () => {
        void (async () => {
          try {
            const headers = Object.entries(request.headers).flatMap(([name, value]) => (Array.isArray(value) ? value.map((v) => [name, v] as [string, string]) : value === undefined ? [] : [[name, value] as [string, string]]))
              .flatMap(([name, value]): [string, string][] => {
                if (name.toLowerCase() !== "cookie") return [[name, value]];
                const own = ownCookies(value, cookies);
                return own ? [[name, own]] : [];
              });
            const answer = await node(ctx).request(link.peerPubKeyZ32, service, { method: request.method ?? "GET", path: request.url ?? "/", headers, body: chunks.length ? new Uint8Array(Buffer.concat(chunks)) : null, maxResponseBytes: MAX_RESPONSE_BYTES });
            for (const [name, value] of answer.headers) {
              const set = name.toLowerCase() === "set-cookie" ? setCookieName(value) : null;
              if (set) cookies.add(set);
            }
            response.writeHead(answer.status, Object.fromEntries(answer.headers.filter(([name]) => !["transfer-encoding", "connection"].includes(name.toLowerCase()))));
            response.end(Buffer.from(await answer.bytes()));
          } catch (error) {
            const gone = error instanceof GhostlyHttpError && ["unreachable", "timeout", "closed", "offline"].includes(error.code);
            response.writeHead(gone ? 503 : 502, { "content-type": "text/plain; charset=utf-8" });
            response.end(gone ? "This service is not reachable. Services exist while their ghost is online." : `The request failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        })();
      });
    });
    const port = num(params, "port", 0, { min: 0, max: 65535 });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve()); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    open.set(key, { server, url });
    return { chat: link.id, service, url };
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
