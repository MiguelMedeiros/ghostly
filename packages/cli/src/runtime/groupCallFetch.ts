import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { isPublicIp, publicOnlyLookup } from "./pushSend";

/**
 * How the CLI asks a group's call node (WISP 602 § The token request, § Moderation) at the origin the group's admin
 * named: an HTTPS POST only at a public address, or at a name whose every address is public, checked when the
 * connection is made, as an identity's proof is read (./publicFetch.ts). No redirect is followed (one is answered as it
 * came: the engine takes only a 2xx), no proxy, no cookie. The engine bounds the time and the size of the reply.
 */
export function nodeGroupCallFetch(lookup: LookupFunction = publicOnlyLookup): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.protocol !== "https:") throw new TypeError("Only HTTPS is sent");
    if ((init?.method ?? "GET").toUpperCase() !== "POST") throw new TypeError("Only POST is sent");
    // Node does not look up an address written in the URL: it is checked here.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !isPublicIp(host)) throw new TypeError(`${host} is not a public address`);
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = { ...Object.fromEntries(new Headers(init?.headers)), "content-length": String(Buffer.byteLength(body)) };
    return new Promise<Response>((resolve, reject) => {
      const req = request(url, { method: "POST", headers, lookup, agent: false, signal: init?.signal ?? undefined }, (res) => {
        const out = new Headers();
        for (const [name, value] of Object.entries(res.headers)) if (typeof value === "string") out.set(name, value);
        const status = res.statusCode ?? 0;
        resolve(new Response(status === 204 || status === 304 ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers: out }));
      });
      req.on("error", reject);
      req.end(body);
    });
  };
}
