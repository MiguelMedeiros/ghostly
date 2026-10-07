import { isAppUrl } from "@ghostly/core";

/*
 * Where mini-apps and stores are read from (WISP 1200 § Stores, § Apps sent in a chat): in phase 1 only two hosts,
 * `raw.githubusercontent.com` and `cdn.jsdelivr.net` pinned to a full commit, both readable from a page (CORS `*`).
 * HTTPS only, no user or password, no port, no redirect (one would walk out of the list), no cookies, no referrer, and a
 * cap on the bytes read while the body streams in. Every read of the apps feature goes through `boundedAppFetch`.
 */

/** The hosts phase 1 reads from. A jsDelivr URL must also name a 40-character commit (`isAppUrl`). */
export const APP_FETCH_HOSTS = ["raw.githubusercontent.com", "cdn.jsdelivr.net"] as const;

export const APP_FETCH_LIMITS = {
  /**
   * A store index as read (WISP 1200 § Stores, Privacy): 4 MiB in phase 1, under the format's 16 MiB. Counted on the body
   * as it arrives, after the browser undid any compression, since a page never sees the compressed size.
   */
  storeIndexBytes: 4 * 1024 * 1024,
  /** A store's signature statement, `ghostly-store.sig` (canonical, at most 1 KiB). */
  sigBytes: 1024,
  /** `ghostly-revoke.json`: at most 4096 signed revocations. */
  revocationsBytes: 16 * 1024 * 1024,
  timeoutMs: 30_000,
} as const;

/** A URL this client may read an app, a store or a revocation list from. */
export function isAppFetchUrl(value: unknown): value is string {
  if (!isAppUrl(value)) return false;
  const url = new URL(value);
  return url.port === "" && (APP_FETCH_HOSTS as readonly string[]).includes(url.hostname.toLowerCase());
}

export type AppFetchErrorCode = "host" | "offline" | "status" | "too-large" | "network";

export class AppFetchError extends Error {
  constructor(readonly code: AppFetchErrorCode, message: string, readonly status?: number) {
    // Its code first, as every error of the apps calls (`<code>: words`).
    super(`${code}: ${message}`);
    this.name = "AppFetchError";
  }
}

/**
 * Reads a URL of the list: its bytes, at most `maxBytes`. With `peek`, the first `maxBytes` bytes and no more, the rest
 * left unread (a bundle's manifest, to see whether it is newer before reading all of it).
 */
export type AppFetcher = (url: string, options: { maxBytes: number; peek?: boolean }) => Promise<Uint8Array>;

export function boundedAppFetch(options: { fetcher?: typeof fetch; online?: () => boolean; timeoutMs?: number } = {}): AppFetcher {
  return async (url, { maxBytes, peek = false }) => {
    if (!isAppFetchUrl(url)) throw new AppFetchError("host", "Apps are read only from raw.githubusercontent.com, or from cdn.jsdelivr.net at a commit, over HTTPS");
    if (options.online && !options.online()) throw new AppFetchError("offline", "Offline");
    const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    let response: Response;
    try {
      response = await fetcher(url, {
        signal: AbortSignal.timeout(options.timeoutMs ?? APP_FETCH_LIMITS.timeoutMs),
        credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error",
        ...(peek && { headers: { range: `bytes=0-${maxBytes - 1}` } }),
      });
    } catch (error) {
      throw new AppFetchError("network", error instanceof Error ? error.message : String(error));
    }
    // A redirect a fetcher followed after all (one that ignores `redirect`) still lands only on a host of the list.
    if (response.url && response.url !== url && !isAppFetchUrl(response.url)) throw new AppFetchError("host", "The host sent the request elsewhere");
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AppFetchError("status", `The host answered ${response.status}`, response.status);
    }
    if (!peek && Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new AppFetchError("too-large", "Too large");
    }
    const parts: Uint8Array[] = [];
    let length = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (length + value.length > maxBytes) {
            if (!peek) throw new AppFetchError("too-large", "Too large");
            parts.push(value.subarray(0, maxBytes - length));
            length = maxBytes;
            break;
          }
          parts.push(value);
          length += value.length;
        }
      } catch (error) {
        if (error instanceof AppFetchError) throw error;
        throw new AppFetchError("network", error instanceof Error ? error.message : String(error));
      } finally { await reader.cancel().catch(() => {}); }
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const part of parts) { bytes.set(part, at); at += part.length; }
    return bytes;
  };
}

const NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * The URL a pasted address reads `file` from (WISP 1200 § Paste a URL), or null when it is not one this client reads:
 * - `https://github.com/<owner>/<repo>`, or `/tree/<ref>`: `raw.githubusercontent.com/<owner>/<repo>/<ref or HEAD>/<file>`,
 *   with no request to `github.com` or `api.github.com`;
 * - a file as GitHub shows it, `https://github.com/<owner>/<repo>/blob/<ref>/<path>` (or `/raw/`), naming a `.ghostlyapp`
 *   or `.json` file: `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`, again with no request to `github.com`;
 * - a URL of the list that names a file (`….ghostlyapp`, `….json`): itself;
 * - a URL of the list that names a folder: `<file>` in it.
 */
export function appPasteUrl(input: string, file: "app.ghostlyapp" | "ghostly-store.json"): string | null {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (host === "github.com" || host === "www.github.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0]!, repo = parts[1]!.replace(/\.git$/, "");
    if (!NAME.test(owner) || !NAME.test(repo)) return null;
    let ref = "HEAD";
    if (parts.length > 2) {
      const rest = parts.slice(3);
      if (!rest.length || !rest.every((p) => NAME.test(p) && p !== "." && p !== "..")) return null;
      if (parts[2] === "blob" || parts[2] === "raw") {
        // `<ref>/<path>`: raw.githubusercontent.com takes the two joined the same way github.com does.
        if (rest.length < 2 || !/\.(ghostlyapp|json)$/.test(rest[rest.length - 1]!)) return null;
        const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join("/")}`;
        return isAppFetchUrl(raw) ? raw : null;
      }
      if (parts[2] !== "tree") return null;
      ref = rest.join("/");
    }
    const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${file}`;
    return isAppFetchUrl(raw) ? raw : null;
  }
  const last = url.pathname.split("/").pop() ?? "";
  const named = /\.(ghostlyapp|json)$/.test(last) ? url.href : new URL(`${url.pathname.replace(/\/?$/, "/")}${file}`, url).href;
  return isAppFetchUrl(named) ? named : null;
}

/** A page of github.com (any scheme): a link `appPasteUrl` could not read is still GitHub, and is answered as such. */
export function isGitHubPage(input: string): boolean {
  try {
    const host = new URL(input.trim()).hostname.toLowerCase();
    return host === "github.com" || host === "www.github.com";
  } catch { return false; }
}

/** A file beside another (`ghostly-store.sig` beside the index, `ghostly-revoke.json` beside a bundle). */
export function besideUrl(url: string, name: string): string {
  const target = new URL(url);
  target.search = "";
  target.hash = "";
  return new URL(name, target).href;
}
