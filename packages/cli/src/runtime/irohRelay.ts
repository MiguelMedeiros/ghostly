import { isIP, type LookupFunction } from "node:net";
import { WebSocket as NodeWebSocket } from "ws";
import { isPublicIp, publicOnlyLookup } from "./pushSend";

/**
 * Whether the CLI's Iroh may dial a contact through the relay its descriptor names (irohWeb.ts `publicRelay`): at a
 * public address, or at a name whose every address is public now, as a held item's is (`publicOnlyLookup`). Asked again
 * before each dial. A name it takes is then opened only through that same lookup (`relaySockets`), each time the wasm
 * connects to it, so a name that answers this machine or its network after the check is not reached either.
 */
export function nodePublicRelay(lookup: LookupFunction = publicOnlyLookup): (relay: string) => Promise<boolean> {
  return (relay) => new Promise((resolve) => {
    let url: URL;
    try { url = new URL(relay); } catch { return resolve(false); }
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    if (isIP(host)) return resolve(isPublicIp(host));
    lookup(host, { all: true }, (error) => {
      if (!error) relaySockets(globalThis).set(socketKey(url), lookup);
      resolve(!error);
    });
  });
}

/** A WebSocket URL's host and port, the same for a relay's https:// URL and the wss:// one the wasm opens. */
function socketKey(url: URL): string {
  const port = url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
  return `${url.hostname.replace(/\.$/, "")}:${port}`;
}

const installed = new WeakMap<object, Map<string, LookupFunction>>();

/**
 * The wasm Iroh opens its relays with the global `WebSocket`, which resolves the name again by itself. From the first
 * contact's relay `nodePublicRelay` takes, the global one opens a socket to that relay's host and port with `ws` and
 * that check's lookup instead, so the address it dials is one the lookup took then; every other socket is the global
 * one as before. Answers the host and port → lookup table.
 */
function relaySockets(scope: { WebSocket: typeof WebSocket }): Map<string, LookupFunction> {
  let names = installed.get(scope);
  if (names) return names;
  const checked = names = new Map<string, LookupFunction>();
  installed.set(scope, names);
  scope.WebSocket = new Proxy(scope.WebSocket, {
    construct(target, args: [string | URL, (string | string[])?], newTarget) {
      let lookup: LookupFunction | undefined;
      try { lookup = checked.get(socketKey(new URL(args[0]))); } catch { /* the global one says why */ }
      if (!lookup) return Reflect.construct(target, args, newTarget) as object;
      return new NodeWebSocket(args[0], args[1], { lookup, followRedirects: false, perMessageDeflate: false });
    },
  });
  return names;
}
