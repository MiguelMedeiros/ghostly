/**
 * What the service worker does with a request. Pure, so it is tested without a worker (src/test/pwa/).
 *
 * An allowlist: the worker answers from its cache only what the build made (the app shell and the hashed
 * files under `/assets/`), and the share target's POST. Everything else goes to the network as if there were
 * no worker, and nothing it fetches is ever stored: messages, relay and DHT traffic, wallet and API calls,
 * other origins, the update check, the sign-in callback. An invite's keys ride in the address's fragment,
 * which never reaches a worker at all; the shell is the same file for every address.
 */

/** Where the operating system posts what is shared into the installed app (manifest `share_target`). */
export const SHARE_TARGET_PATH = "/share-target";

/** Where the app picks a shared item up once the worker has it. */
export const SHARED_ROUTE = "/#/shared";

/** The prefix of every cache this worker owns; the build id follows it. */
export const CACHE_PREFIX = "ghostly-shell-";

export type Route =
  /** The app's page, from the cache (the version this worker was built with). */
  | "shell"
  /** A file of the build, precached at install. */
  | "precache"
  /** A hashed file of the build that was not precached (wallet wasm, …): cached the first time it is fetched. */
  | "asset"
  /** Something shared into the app from another one. */
  | "share"
  /** Not the worker's business: the network, uncached. */
  | "pass";

export interface RequestLike {
  method: string;
  url: string;
  mode?: string;
  /** Whether it asks for part of a file (a media element does): answered by the server, which answers 206. */
  range?: boolean;
}

/**
 * Paths of this origin that always go to the network, whatever else would match. `/version.json` is how a
 * tab learns about a deploy, so a cached answer would hide every update; the sign-in callback carries a
 * provider's answer; the worker's own script is the browser's to fetch.
 */
const NEVER = new Set(["/version.json", "/oidc-callback.html", "/sw.js"]);

/** Pages that are the app: its root and its file. Any other path is a static file, or nothing. */
const APP_PAGES = new Set(["/", "/index.html"]);

export function classify(request: RequestLike, origin: string, precached: ReadonlySet<string>): Route {
  let url: URL;
  try { url = new URL(request.url); } catch { return "pass"; }
  if (url.origin !== origin) return "pass";
  const path = url.pathname;

  if (request.method === "POST") return path === SHARE_TARGET_PATH ? "share" : "pass";
  if (request.method !== "GET") return "pass";
  if (NEVER.has(path) || request.range) return "pass";

  // A page load of the app (the router lives in the fragment, so every screen is `/`). A query on it is not the
  // app's (the app puts nothing there), so it goes to the server as it is.
  if (request.mode === "navigate") return APP_PAGES.has(path) && !url.search ? "shell" : "pass";

  // Precached files are stored under their bare path; a query string makes it another request.
  if (url.search) return "pass";
  if (precached.has(path)) return "precache";
  if (path.startsWith("/assets/") && !path.includes("..")) return "asset";
  return "pass";
}

/**
 * What the build precaches: the app's page, its hashed files except the WebAssembly (wallets load theirs when
 * one is used, and they are most of the build's weight), and the static files beside it. Never the update
 * check, the sign-in callback or the worker itself.
 */
export function precacheList(files: readonly string[]): string[] {
  const paths = files
    .map((file) => "/" + file.replace(/^\/+/, ""))
    .filter((path) => !NEVER.has(path))
    .filter((path) => !/\.(wasm|map)$/.test(path))
    .filter((path) => path !== "/index.html");
  return ["/", ...new Set(paths)].sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
}

/** A shared item as the manifest's `share_target` params name it. */
export interface SharedItem {
  title: string;
  text: string;
  url: string;
  files: File[];
}

/** Most files one share brings; larger shares keep their first ones. */
export const MAX_SHARED_FILES = 32;

/** What a share target POST carries, bounded: strings of a sane length, files that are files. */
export function readShare(form: FormData): SharedItem {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value.slice(0, 64 * 1024) : "";
  };
  const files = form.getAll("files").filter((value): value is File => typeof value !== "string" && value.size >= 0).slice(0, MAX_SHARED_FILES);
  return { title: text("title"), text: text("text"), url: text("url"), files };
}

/** Where a profile's push-only worker is registered: its own scope, so each profile has its own subscription. */
export const PUSH_SCOPE_PREFIX = "/push/";

/** The scope of a profile's push worker (`""` is the default profile). */
export function pushScope(profile: string): string {
  return `${PUSH_SCOPE_PREFIX}${encodeURIComponent(profile || "default")}/`;
}

/** The profile a worker's scope is for, or null for the app's own worker (scope `/`). */
export function pushScopeProfile(scope: string): string | null {
  let path: string;
  try { path = new URL(scope).pathname; } catch { return null; }
  const match = path.match(/^\/push\/([^/]+)\/$/);
  if (!match) return null;
  const profile = decodeURIComponent(match[1]!);
  return profile === "default" ? "" : profile;
}

/**
 * What a wake-up shows (WISP 401 § Wake-up push): "New message" for a chat the token names, or nothing at all
 * for a token this profile no longer knows (a contact it stopped sharing with), for a muted chat, and while the
 * app is on screen (it is live, and the message arrives by itself). Never a sender or any text of the message.
 */
export function wakeNotice(found: { entry: { path: string; mutedUntil?: number | "forever" }; text: { title: string; body: string } } | undefined, options: { now: number; appVisible: boolean; profile: string }):
  { title: string; body: string; tag: string; data: { path: string; profile: string } } | null {
  if (!found || options.appVisible) return null;
  const { entry, text } = found;
  if (entry.mutedUntil === "forever" || (typeof entry.mutedUntil === "number" && entry.mutedUntil > options.now)) return null;
  if (!/^\/(chat|group)\/[^/?#]+$/.test(entry.path)) return null;
  return { title: text.title, body: text.body, tag: `wake:${options.profile}:${entry.path}`, data: { path: entry.path, profile: options.profile } };
}
