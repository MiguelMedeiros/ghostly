/**
 * How Ghostly Desktop reads a contact's identity proof and public data (WISP 300, PUBLIC-PROFILES.md) at the addresses
 * the proof names. The WebView's `fetch` cannot see what a name resolves to: a name a public resolver answered as public
 * may still lead to this machine or its network here. Rust reads it instead (`hold_fetch`, apps/desktop/src/hold_fetch.rs):
 * a GET to a name whose every address is public, checked when the connection is made, as the CLI's does. No redirect is
 * followed, no proxy, no credentials. The engine bounds the size and time (`boundedIdentityFetch`).
 */

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
interface Answer { status: number; contentType: string; bodyB64: string }

export function desktopIdentityFetch(invoke: Invoke): typeof fetch {
  return async (input, init) => {
    init?.signal?.throwIfAborted();
    if ((init?.method ?? "GET").toUpperCase() !== "GET") throw new TypeError("Only GET is sent");
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = [...new Headers(init?.headers)];
    const asked = invoke<Answer>("hold_fetch", { url, headers }).catch((error: unknown) => { throw new TypeError(String(error)); });
    // Rust waits up to its own 150 s (held items are large): a read the engine gave up on (`boundedIdentityFetch`'s
    // 10 s, a cancelled check) ends now, and its late answer is dropped.
    const answer = await (init?.signal ? abortable(asked, init.signal) : asked);
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
