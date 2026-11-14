import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { isPublicIp, publicOnlyLookup } from "./pushSend";

const MAX_REDIRECTS = 5;

/**
 * How the CLI reads an identity's proof and public data (WISP 300, PUBLIC-PROFILES.md) at the address a contact named:
 * HTTPS GET only at a public address, or at a name whose every address is public, checked when the connection is made
 * (so a name that changes its answer after the engine's own check is refused too). No proxy. A redirect is refused
 * unless asked for, and each hop is checked the same way. The engine bounds the size and time (`boundedIdentityFetch`).
 */
export function nodePublicFetch(lookup: LookupFunction = publicOnlyLookup): typeof fetch {
  const get = (url: URL, headers: Headers, signal: AbortSignal | undefined) => new Promise<Response>((resolve, reject) => {
    if (url.protocol !== "https:") return reject(new TypeError("Only HTTPS is read"));
    // Node does not look up an address written in the URL: it is checked here.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !isPublicIp(host)) return reject(new TypeError(`${host} is not a public address`));
    const req = request(url, { method: "GET", headers: Object.fromEntries(headers), lookup, agent: false, signal }, (res) => {
      const out = new Headers();
      for (const [name, value] of Object.entries(res.headers)) if (typeof value === "string") out.set(name, value);
      const status = res.statusCode ?? 0;
      resolve(new Response(status === 204 || status === 304 ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers: out }));
    });
    req.on("error", reject);
    req.end();
  });
  return async (input, init) => {
    let url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if ((init?.method ?? "GET").toUpperCase() !== "GET") throw new TypeError("Only GET is sent");
    const headers = new Headers(init?.headers);
    const signal = init?.signal ?? undefined;
    for (let hops = 0; ; hops++) {
      const response = await get(url, headers, signal);
      const location = response.headers.get("location");
      if (response.status < 300 || response.status > 399 || !location || init?.redirect === "manual") {
        if (hops) Object.defineProperties(response, { url: { value: url.href }, redirected: { value: true } });
        return response;
      }
      await response.body?.cancel();
      if (init?.redirect !== "follow" || hops >= MAX_REDIRECTS) throw new TypeError("Redirect refused");
      url = new URL(location, url);
    }
  };
}
