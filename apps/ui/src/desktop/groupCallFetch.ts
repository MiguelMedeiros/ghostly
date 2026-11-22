/**
 * How Ghostly Desktop asks a group's call node (WISP 602 § The token request, § Moderation) at the origin the group's
 * admin named. The WebView's `fetch` cannot see what a name resolves to, and takes any `https` origin, a local one
 * included: the member's key, name and signed request would go to this machine or its network. Rust sends it instead
 * (`group_call_fetch`, apps/desktop/src/hold_fetch.rs): an HTTPS POST to a name whose every address is public, checked
 * when the connection is made, as the CLI's does. No redirect is followed (one is answered as it came: the engine takes
 * only a 2xx), no proxy, no credentials. The engine bounds the time and the size of the reply.
 */

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
interface Answer { status: number; contentType: string; bodyB64: string; retryAfter: string }

export function desktopGroupCallFetch(invoke: Invoke): typeof fetch {
  return async (input, init) => {
    init?.signal?.throwIfAborted();
    if ((init?.method ?? "GET").toUpperCase() !== "POST") throw new TypeError("Only POST is sent");
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    const asked = invoke<Answer>("group_call_fetch", { url, body }).catch((error: unknown) => { throw new TypeError(String(error)); });
    // Rust is not told to stop: the engine's timeout ends the wait here.
    const answer = await (init?.signal ? Promise.race([asked, aborted(init.signal)]) : asked);
    const headers: Record<string, string> = {};
    if (answer.contentType) headers["content-type"] = answer.contentType;
    if (answer.retryAfter) headers["retry-after"] = answer.retryAfter;
    const bytes = answer.bodyB64 ? Uint8Array.from(atob(answer.bodyB64), (c) => c.charCodeAt(0)) : null;
    return new Response(bytes, { status: answer.status, headers });
  };
}

const aborted = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});
