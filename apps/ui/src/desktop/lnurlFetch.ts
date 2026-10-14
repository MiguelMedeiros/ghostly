/**
 * How Ghostly Desktop asks a Lightning address or LNURL service (WISP 205 § Transport).
 *
 * The WebView's `fetch` asks first, without following redirects. It cannot read where a redirect leads (the answer
 * is opaque: no status, no `Location`), so a service that redirects is asked again from Rust (`link_preview_fetch`,
 * apps/desktop/src/link_preview.rs), which checks every hop before following it: HTTPS all the way, the default port,
 * no credentials, a name whose every address is public, at most 4 redirects, 64 KiB. The answer comes back with the
 * address it came from, which `fetchLnurlJson` checks as any other.
 */

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
interface Answer { url: string; contentType: string; bodyB64: string }

export function desktopLnurlFetch(invoke: Invoke, page: typeof fetch = (...args) => globalThis.fetch(...args)): typeof fetch {
  return async (input, init) => {
    const first = await page(input, init);
    if (first.type !== "opaqueredirect") return first;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Rust also reads plain HTTP for link previews: a redirect is only ever followed from an HTTPS address.
    if (new URL(url).protocol !== "https:") return first;
    init?.signal?.throwIfAborted();
    const answer = await invoke<Answer>("link_preview_fetch", { url, kind: "json" }).catch((error: unknown) => String(error));
    if (typeof answer === "string") {
      // The service's own refusal keeps its status; anything else (a local address, too many redirects, unreachable) is a failed request.
      const status = /^HTTP (\d{3})$/.exec(answer)?.[1];
      if (!status) throw new TypeError(answer);
      return at(new Response(null, { status: Number(status) }), url);
    }
    init?.signal?.throwIfAborted();
    return at(new Response(Uint8Array.from(atob(answer.bodyB64), (c) => c.charCodeAt(0)), { status: 200, headers: { "content-type": answer.contentType } }), answer.url);
  };
}

/** A `Response` made here has no address: it gets the one the answer came from. */
function at(response: Response, url: string): Response {
  Object.defineProperty(response, "url", { value: url });
  return response;
}
