/**
 * How Ghostly Desktop reads a held item or manifest (WISP 404) from the address a contact chose. The WebView's `fetch`
 * cannot see what a name resolves to, so a name the contact points at this machine or its network would be reached.
 * Rust reads it instead (`hold_fetch`, apps/desktop/src/hold_fetch.rs): a GET to a name whose every address is public,
 * checked when the connection is made, as the CLI's does. No redirect is followed, no proxy, no credentials. The
 * engine bounds the size and time.
 */
import { HOLD_LIMITS } from "@ghostly/core";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
interface Answer { status: number; bodyB64: string }
/** Rust's refusal of a body past the largest held item (`MAX_BODY`, apps/desktop/src/hold_fetch.rs). */
const TOO_LARGE = "The held item is too large";

export function desktopHoldFetch(invoke: Invoke): typeof fetch {
  return async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const answer = await invoke<Answer>("hold_fetch", { url }).catch((error: unknown) => {
      // Answered as the size it is past, which the engine refuses and moves on from, as the CLI's and the web's are:
      // thrown, it is a network problem, read again at every poll, and the contact's later items wait behind it.
      if (String(error) === TOO_LARGE) return null;
      throw new TypeError(String(error));
    });
    init?.signal?.throwIfAborted();
    if (!answer) return new Response(null, { status: 200, headers: { "content-length": String(HOLD_LIMITS.maxBundleBytes + 1) } });
    // A redirect is answered as it came (not followed): the engine refuses any status but 2xx.
    const body = answer.status === 204 || answer.status === 304 ? null : Uint8Array.from(atob(answer.bodyB64), (c) => c.charCodeAt(0));
    return new Response(body, { status: answer.status });
  };
}
