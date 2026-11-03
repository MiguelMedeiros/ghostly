/**
 * How Ghostly Desktop reads a held item or manifest (WISP 404) from the address a contact chose. The WebView's `fetch`
 * cannot see what a name resolves to, so a name the contact points at this machine or its network would be reached.
 * Rust reads it instead (`hold_fetch`, apps/desktop/src/hold_fetch.rs): a GET to a name whose every address is public,
 * checked when the connection is made, as the CLI's does. No redirect is followed, no proxy, no credentials. The
 * engine bounds the size and time.
 */

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
interface Answer { status: number; bodyB64: string }

export function desktopHoldFetch(invoke: Invoke): typeof fetch {
  return async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const answer = await invoke<Answer>("hold_fetch", { url }).catch((error: unknown) => { throw new TypeError(String(error)); });
    init?.signal?.throwIfAborted();
    // A redirect is answered as it came (not followed): the engine refuses any status but 2xx.
    const body = answer.status === 204 || answer.status === 304 ? null : Uint8Array.from(atob(answer.bodyB64), (c) => c.charCodeAt(0));
    return new Response(body, { status: answer.status });
  };
}
