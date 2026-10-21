/**
 * Opening a contact's shared web app in the web app (WISP 701): what the app, the bridge page and the services worker
 * say to each other, and the names of the origins the apps run on. Pure, so it is tested without a browser.
 *
 * A contact's app is their code: run on the app's own origin it could read this profile's keys and wallets. So each
 * one runs on an origin of its own, `https://<label>.<services host>`, on a host the app's server serves only the
 * bridge on (`/_ghostly-svc/` and the worker's script). The app frames the bridge and hands it a MessagePort; the bridge registers the
 * services worker for its origin and frames the contact's app under it. Every request the app makes there reaches
 * the worker, which hands it to the bridge, which hands it over the port to the app's page, which sends it over the
 * contact's data link (the peer lives in that page) and streams the answer back the same way.
 */

/** The bridge's files on a services origin. Nothing else is served there: every other path is the contact's. */
export const BRIDGE_DIR = "/_ghostly-svc/";
export const BRIDGE_PAGE = `${BRIDGE_DIR}bridge.html`;
export const BRIDGE_SCRIPT = `${BRIDGE_DIR}bridge.js`;
/** At the root, so its scope can be the whole origin without a `Service-Worker-Allowed` header. */
export const WORKER_SCRIPT = "/ghostly-services-sw.js";

/** A request body above this is refused before it leaves the device: the data link carries 8 MiB at most (LIMITS). */
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
/** What one answer may weigh, as on Desktop and the CLI. */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** How long the worker waits for an answer's status line: the engine gives up at 60 s, so this only catches a page gone. */
export const HEAD_TIMEOUT_MS = 75_000;

export const LABEL = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{32}$/;

/**
 * The services host, as the build was given it (`VITE_SERVICES_HOST`): `https://*.svc.example` or, for tests,
 * `http://*.localhost:4173`. Null when it is not one: then the web app opens no contact's app.
 */
export interface ServicesHost { protocol: "https:" | "http:"; suffix: string; port: string }

export function parseServicesHost(value: string | undefined): ServicesHost | null {
  const match = /^(https?):\/\/\*\.([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d{1,5}))?\/?$/.exec(value?.trim().toLowerCase() ?? "");
  if (!match) return null;
  const protocol = `${match[1]}:` as ServicesHost["protocol"];
  // Plain HTTP only on this machine: a service worker needs a secure context.
  if (protocol === "http:" && match[2] !== "localhost") return null;
  return { protocol, suffix: match[2]!, port: match[3] ?? "" };
}

export function serviceOrigin(host: ServicesHost, label: string): string {
  return `${host.protocol}//${label}.${host.suffix}${host.port ? `:${host.port}` : ""}`;
}

/** Whether `hostname` is one app's own name under this services host (the bridge and the worker run nowhere else). */
export function isServiceHostname(host: ServicesHost, hostname: string): boolean {
  const dot = hostname.indexOf(".");
  return dot > 0 && LABEL.test(hostname.slice(0, dot)) && hostname.slice(dot + 1) === host.suffix;
}

/**
 * Whether the worker may pass a request on: only from a page framed under the bridge, where the view shows it. A tab
 * or a window on the app's origin (opened by it, or by another site) never reaches the contact.
 */
export function fromView(request: { mode: string; destination: string }, client?: { type?: string; frameType?: string }): boolean {
  if (request.mode === "navigate") return request.destination !== "document";
  return client?.type !== "window" || client.frameType === "nested";
}

/** A request as the worker hands it on. `path` is the path and query on the app's origin, never a full URL. */
export interface ServiceRequestMessage {
  type: "request";
  method: string;
  path: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}

/** What comes back on the request's own port: one `head`, then `chunk`s, then `end`; or `error` at any point. */
export type ServiceReply =
  | { type: "head"; status: number; headers: [string, string][] }
  | { type: "chunk"; bytes: Uint8Array }
  | { type: "end" }
  | { type: "error"; status: number; text: string };

/** The worker tells the app it no longer wants the rest (the page stopped reading). */
export interface ServiceCancel { type: "cancel" }

/** The element a contact's app is shown in over the app, and the event that closes it (the lock screen sends it). */
export const SERVICE_VIEW_ID = "ghostly-service-view";
export const SERVICE_VIEW_CLOSE = "ghostly-close";

/** Closes the contact's app shown over the app, if one is: its requests and its cookies end with it. */
export function closeServiceView(): void {
  document.getElementById(SERVICE_VIEW_ID)?.dispatchEvent(new Event(SERVICE_VIEW_CLOSE));
}

/** The bridge says it loaded; the app answers with the port. */
export const BRIDGE_READY = "ghostly-svc-ready";
export const BRIDGE_PORT = "ghostly-svc-port";

/** A request the app takes from a port: anything else (a page of the contact's posting to it) is dropped. */
export function readRequest(data: unknown): ServiceRequestMessage | null {
  if (!data || typeof data !== "object") return null;
  const { type, method, path, headers, body } = data as Record<string, unknown>;
  if (type !== "request" || typeof method !== "string" || !/^[A-Z]{1,16}$/.test(method)) return null;
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.length > 8192) return null;
  if (!Array.isArray(headers) || headers.length > 128 || !headers.every((h) => Array.isArray(h) && h.length === 2 && typeof h[0] === "string" && typeof h[1] === "string")) return null;
  if (body !== null && !(body instanceof ArrayBuffer && body.byteLength <= MAX_REQUEST_BYTES)) return null;
  return { type, method, path, headers: headers as [string, string][], body: body as ArrayBuffer | null };
}

/** Statuses a Response has no body for. */
export const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** The status the worker answers with: the contact's, when a Response may carry it. */
export function answerStatus(status: number): number {
  return Number.isInteger(status) && status >= 200 && status <= 599 ? status : 502;
}
