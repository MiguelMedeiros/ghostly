import { isIP, type LookupFunction } from "node:net";
import { isPublicIp, publicOnlyLookup } from "./pushSend";

/**
 * Whether the CLI's Iroh may dial a contact through the relay its descriptor names (irohWeb.ts `publicRelay`): at a
 * public address, or at a name whose every address is public now, as a held item's is (`publicOnlyLookup`). Asked again
 * before each dial. The wasm resolves the name once more when it connects, so a name that changes its answer in
 * between is not caught here.
 */
export function nodePublicRelay(lookup: LookupFunction = publicOnlyLookup): (relay: string) => Promise<boolean> {
  return (relay) => new Promise((resolve) => {
    let host: string;
    try { host = new URL(relay).hostname.replace(/^\[(.*)\]$/, "$1"); } catch { return resolve(false); }
    if (isIP(host)) return resolve(isPublicIp(host));
    lookup(host, { all: true }, (error) => resolve(!error));
  });
}
