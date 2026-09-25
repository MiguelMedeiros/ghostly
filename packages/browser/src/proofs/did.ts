import {
  DidError, DID_DOCUMENT_MAX_BYTES, DID_FILE_MAX_BYTES, didWebDocumentUrl, didWebFileUrl, didWebHost, parseDid, parseDidDocument, staticDidDocument,
  type DidDocumentView, type DidMethod,
} from "@ghostly/core";
import type { IdentityFetch } from "./contract";
import { assertPublicHost, chosenResolver, DomainCheckError, type DohResolverId } from "./domain";
import { resolveDidDht } from "./didDhtStandIn";

/**
 * Network side of DID proofs: resolving a DID to the keys its document lists, under the same limits as the
 * other providers. did:key and did:jwk need no network. did:web is one HTTPS GET of its did.json (bounded,
 * no redirect, after checking that the domain's addresses are public, like the domain proof). did:dht is a
 * signed Pkarr record read from a relay.
 *
 * What a check reveals, and to whom:
 *  - did:web: the DNS-over-HTTPS resolver learns the domain; the domain's web server, run by the person
 *    being checked, sees this device's IP address and when.
 *  - did:dht: the Pkarr relay learns which DID was looked up, from which IP address.
 */

export interface DidResolution {
  method: DidMethod;
  document: DidDocumentView;
  /** did:web: the host, and where its did.json was read. */
  host?: string;
  documentUrl?: string;
  /** did:dht: the relay that answered. */
  relay?: string;
}

export interface DidResolveOptions {
  fetch: IdentityFetch;
  signal?: AbortSignal;
  /** Milliseconds. */
  now?: () => number;
  resolver?: DohResolverId;
  /** did:dht resolution; tests pass their own. */
  dht?: typeof resolveDidDht;
}

/** Resolutions are shared for this long: back-to-back checks and the add dialog's preview, never a stale key for long. */
const CACHE_MS = 30_000;
const cache = new Map<string, { until: number; result: Promise<DidResolution> }>();
/** The last document seen per DID, without expiry, for the signer's instructions (which cannot wait). */
const seen = new Map<string, DidResolution>();

/** Tests only. */
export function clearDidCache(): void { cache.clear(); seen.clear(); }

/** What this app last resolved for `did`, if anything: the add dialog's instructions name its keys. */
export const lastDidResolution = (did: string): DidResolution | undefined => seen.get(did);

async function fetchDidWeb(did: string, url: string, maxBytes: number, options: DidResolveOptions): Promise<string | undefined> {
  const host = didWebHost(did);
  try {
    await assertPublicHost(host, { fetch: options.fetch, signal: options.signal, resolver: options.resolver ?? chosenResolver().id, now: options.now });
  } catch (e) { throw e instanceof DomainCheckError ? new DidError(e.message) : e; }
  let response: Awaited<ReturnType<IdentityFetch>>;
  try {
    response = await options.fetch(url, { headers: { accept: "application/did+json, application/json" }, maxBytes, signal: options.signal, redirect: "error" });
  } catch (e) {
    if (options.signal?.aborted) throw e;
    throw new DidError(/too large/i.test(String(e)) ? `${url} is too large`
      : `${host} could not be reached. It must serve ${url} over HTTPS, without a redirect, with the header Access-Control-Allow-Origin: *`);
  }
  if (response.status === 404 || response.status === 410) return undefined;
  if (response.status >= 300 && response.status < 400) throw new DidError(`${host} answered with a redirect; it must serve exactly ${url}`);
  if (response.status !== 200) throw new DidError(`${host} answered ${response.status} for ${url}`);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(response.bytes); } catch { throw new DidError(`${url} is not text`); }
}

async function resolve(did: string, method: DidMethod, options: DidResolveOptions): Promise<DidResolution> {
  if (method === "key" || method === "jwk") return { method, document: staticDidDocument(did) };
  if (method === "web") {
    const documentUrl = didWebDocumentUrl(did);
    const text = await fetchDidWeb(did, documentUrl, DID_DOCUMENT_MAX_BYTES, options);
    if (text === undefined) throw new DidError(`No DID document at ${documentUrl}`);
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new DidError(`${documentUrl} is not JSON`); }
    return { method, document: parseDidDocument(did, raw), host: didWebHost(did), documentUrl };
  }
  const found = await (options.dht ?? resolveDidDht)(did, { fetch: options.fetch, signal: options.signal });
  if (found.metadata.deactivated) throw new DidError("This DID is deactivated: its owner retired it");
  return { method, document: parseDidDocument(did, found.document), relay: found.relay };
}

/** A DID's document as far as Ghostly uses it. Concurrent and back-to-back resolutions share one lookup. */
export async function resolveDid(input: string, options: DidResolveOptions): Promise<DidResolution> {
  const { did, method } = parseDid(input);
  const now = options.now ?? Date.now;
  const hit = cache.get(did);
  if (hit && hit.until > now()) return hit.result;
  const entry = { until: now() + CACHE_MS, result: resolve(did, method, options) };
  cache.set(did, entry);
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  try {
    const result = await entry.result;
    seen.delete(did);
    seen.set(did, result);
    if (seen.size > 16) seen.delete(seen.keys().next().value!);
    return result;
  } catch (e) {
    if (cache.get(did) === entry) cache.delete(did);
    throw e;
  }
}

/** The statement file a did:web publishes for proof `proofId`; undefined when the server says it is not there. */
export async function fetchDidWebFile(did: string, proofId: string, options: DidResolveOptions): Promise<string | undefined> {
  return fetchDidWeb(did, didWebFileUrl(did, proofId), DID_FILE_MAX_BYTES, options);
}
