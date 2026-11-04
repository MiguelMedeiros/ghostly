import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { publicOnlyLookup } from "./pushSend";

/**
 * How the CLI reads a held item or manifest (WISP 404): a GET to the address the contact chose, only
 * at a name whose every address is public, checked when the connection is made (so a name that changes its answer
 * in between is refused too). No redirect is followed, no proxy, no credentials. The engine bounds the size and time.
 */
export function nodeHoldFetch(lookup: LookupFunction = publicOnlyLookup): typeof fetch {
  return (input, init) => new Promise<Response>((resolve, reject) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const req = request(url, { method: "GET", lookup, agent: false, signal: init?.signal ?? undefined }, (res) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) if (typeof value === "string") headers.set(name, value);
      const status = res.statusCode ?? 0;
      // A redirect is answered as it came (not followed): the engine refuses any status but 2xx.
      resolve(new Response(status === 204 || status === 304 ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers }));
    });
    req.on("error", reject);
    req.end();
  });
}
