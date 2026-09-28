import { lookup as dnsLookup } from "node:dns";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { checkPushEndpoint, isPublicAddress, type PushRequest } from "@ghostly/core";

/** An address as bytes (4 or 16), or null when it is not one. */
export function addressBytes(address: string): Uint8Array | null {
  const family = isIP(address);
  if (family === 4) return Uint8Array.from(address.split(".").map(Number));
  if (family !== 6) return null;
  let text = address.replace(/%.*$/, "");
  // An IPv4 tail (::ffff:1.2.3.4) as two groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4[1]!.split(".").map(Number);
    text = text.slice(0, -v4[1]!.length) + ((a! << 8) | b!).toString(16) + ":" + ((c! << 8) | d!).toString(16);
  }
  const [head, tail] = text.includes("::") ? text.split("::") as [string, string] : [text, null];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === null ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, i) => { const n = parseInt(group, 16); bytes[i * 2] = n >> 8; bytes[i * 2 + 1] = n & 0xff; });
  return bytes;
}

/** True when `address` is on the public Internet (see `isPublicAddress`). */
export function isPublicIp(address: string): boolean {
  const bytes = addressBytes(address);
  return bytes !== null && isPublicAddress(bytes);
}

type Resolver = (hostname: string, options: { all: true }, callback: (error: NodeJS.ErrnoException | null, found: { address: string; family: number }[]) => void) => void;

/** `lookup` over `resolve` (`dns.lookup`), refusing a name any of whose addresses is not public. */
export const publicOnly = (resolve: Resolver): LookupFunction => (hostname, options, callback) => {
  resolve(hostname, { ...options, all: true }, (error, found) => {
    if (error) return callback(error, "", 4);
    const addresses = found as unknown as { address: string; family: number }[];
    if (!addresses.length || addresses.some((a) => !isPublicIp(a.address))) {
      return callback(Object.assign(new Error(`${hostname} is not a public address`), { code: "ENOTFOUND" }), "", 4);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof addresses) => void)(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

export const publicOnlyLookup: LookupFunction = publicOnly(dnsLookup as unknown as Resolver);

/**
 * Posts a wake-up (WISP 401 § Wake-up push) the way the Desktop does from Rust: only to a push service's endpoint
 * (`checkPushEndpoint`), whose name must resolve to public addresses only, no redirect followed, no proxy, 10 s at most.
 * Answers the push service's status.
 */
export async function nodePushSend(push: PushRequest, lookup: LookupFunction = publicOnlyLookup): Promise<number> {
  const url = checkPushEndpoint(push.url);
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { ...push.headers, "Content-Length": String(push.body.length) }, lookup, agent: false, timeout: 10_000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => req.destroy(new Error("The push service did not answer")));
    req.on("error", reject);
    req.end(push.body);
  });
}
