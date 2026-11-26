/**
 * How Ghostly Desktop reads a contact's identity proof and public data (WISP 300, PUBLIC-PROFILES.md) at the addresses
 * the proof names. The WebView's `fetch` cannot see what a name resolves to: a name a public resolver answered as public
 * may still lead to this machine or its network here. Rust reads it instead (`hold_fetch`, apps/desktop/src/hold_fetch.rs):
 * a GET to a name whose every address is public, checked when the connection is made, as the CLI's does. No redirect is
 * followed, no proxy, no credentials. The engine bounds the size and time (`boundedIdentityFetch`), and says them:
 * Rust stops at the same ones, not at a held item's 8 MiB and 150 s.
 */

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
interface Answer { status: number; contentType: string; bodyB64: string }
/** What `boundedIdentityFetch` asks for besides a `fetch` request: the most it takes, and for how long. */
type Bounded = RequestInit & { maxBytes?: number; timeoutMs?: number };
/** Rust's refusal of a body past `maxBytes` (apps/desktop/src/hold_fetch.rs). */
const TOO_LARGE = "The held item is too large";

export function desktopIdentityFetch(invoke: Invoke): typeof fetch {
  return async (input, init?: Bounded) => {
    init?.signal?.throwIfAborted();
    if ((init?.method ?? "GET").toUpperCase() !== "GET") throw new TypeError("Only GET is sent");
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = [...new Headers(init?.headers)];
    const maxBytes = init?.maxBytes ?? 64 * 1024;
    const asked = invoke<Answer>("hold_fetch", { url, headers, maxBytes, timeoutMs: init?.timeoutMs ?? 10_000 }).catch((error: unknown) => {
      // Answered as the size it is past, which the engine refuses as too large, as it refuses the page's own.
      if (String(error) === TOO_LARGE) return null;
      throw new TypeError(String(error));
    });
    // A read the engine gave up on (a cancelled check) ends now, and its late answer is dropped.
    const answer = await (init?.signal ? abortable(asked, init.signal) : asked);
    if (!answer) return new Response(null, { status: 200, headers: { "content-length": String(maxBytes + 1) } });
    // A redirect is refused, as the WebView's `fetch` refuses it under `redirect: "error"`, the engine's default here.
    if (answer.status >= 300 && answer.status < 400 && init?.redirect !== "manual") throw new TypeError("Redirect refused");
    const body = answer.bodyB64 ? Uint8Array.from(atob(answer.bodyB64), (c) => c.charCodeAt(0)) : null;
    return new Response(body, { status: answer.status, headers: answer.contentType ? { "content-type": answer.contentType } : {} });
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
