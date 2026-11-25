/**
 * How Ghostly Desktop asks a Lightning address or LNURL service (WISP 205 § Transport), its callback included.
 *
 * Another party names that address, and the WebView's `fetch` cannot see what a name resolves to: a name that leads to
 * this machine or its network would be reached. Rust asks instead (`hold_fetch`, apps/desktop/src/hold_fetch.rs): a GET
 * over HTTPS to a name whose every address is public, checked when the connection is made, no redirect followed. A
 * service that redirects is asked again from Rust (`link_preview_fetch`, apps/desktop/src/link_preview.rs), which
 * checks every hop before following it: HTTPS all the way, the default port, no credentials, a name whose every address
 * is public, at most 4 redirects, 64 KiB. The answer comes back with the address it came from, which `fetchLnurlJson`
 * checks as any other. A service the person named on this machine itself (a test server, plain HTTP allowed) is asked
 * from the page, as the CLI's does. Rust reads it within a lookup's own size and time (`LNURL_LIMITS`), not a held
 * item's.
 */
import { LNURL_LIMITS } from "@ghostly/core";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
interface Answer { url: string; contentType: string; bodyB64: string }
interface Read { status: number; contentType: string; bodyB64: string }

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
/** Rust's refusal of a body past `maxBytes` (apps/desktop/src/hold_fetch.rs). */
const TOO_LARGE = "The held item is too large";

export function desktopLnurlFetch(invoke: Invoke, page: typeof fetch = (...args) => globalThis.fetch(...args)): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (LOOPBACK.includes(new URL(url).hostname)) return page(input, init);
    init?.signal?.throwIfAborted();
    // Rust stops at the lookup's size and time; a lookup `fetchLnurlJson` gave up on (cancelled) ends now, and the late
    // answer is dropped, as an identity read's is (identityFetch.ts).
    const asked = invoke<Read>("hold_fetch", { url, headers: [["accept", "application/json"]], maxBytes: LNURL_LIMITS.maxBytes, timeoutMs: LNURL_LIMITS.timeoutMs }).catch((error: unknown) => {
      if (String(error) === TOO_LARGE) return null;
      throw new TypeError(String(error));
    });
    const read = await abortable(asked, init?.signal);
    // Answered past the size, which `fetchLnurlJson` refuses as too large, as it refuses the page's own.
    if (!read) return at(new Response(new Uint8Array(LNURL_LIMITS.maxBytes + 1), { status: 200 }), url);
    if (read.status < 300 || read.status > 399) {
      const body = read.bodyB64 ? Uint8Array.from(atob(read.bodyB64), (c) => c.charCodeAt(0)) : null;
      return at(new Response(body, { status: read.status, headers: read.contentType ? { "content-type": read.contentType } : {} }), url);
    }
    const answer = await abortable(invoke<Answer>("link_preview_fetch", { url, kind: "json" }).catch((error: unknown) => String(error)), init?.signal);
    if (typeof answer === "string") {
      // The service's own refusal keeps its status; anything else (a local address, too many redirects, unreachable) is a failed request.
      const status = /^HTTP (\d{3})$/.exec(answer)?.[1];
      if (!status) throw new TypeError(answer);
      return at(new Response(null, { status: Number(status) }), url);
    }
    return at(new Response(Uint8Array.from(atob(answer.bodyB64), (c) => c.charCodeAt(0)), { status: 200, headers: { "content-type": answer.contentType } }), answer.url);
  };
}

/** What Rust answers, or the signal's reason as soon as it aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** A `Response` made here has no address: it gets the one the answer came from. */
function at(response: Response, url: string): Response {
  Object.defineProperty(response, "url", { value: url });
  return response;
}
