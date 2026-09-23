import {
  DOMAIN_FILE_MAX_BYTES, decodeDnsResponse, dnsProofName, encodeDnsQuery, isPublicAddress, nip05RootKey, normalizeDomain,
  recordsFromTxt, recordsFromWellKnown, recordsName, toBase64Url, txtValue, wellKnownUrl,
  type DnsResponse, type DnsType, type DomainMethod, type DomainRecord,
} from '@ghostly/core';
import type { IdentityFetch } from './contract';

/**
 * Network side of domain proofs: DNS TXT through DNS over HTTPS and the
 * `/.well-known/` files, under strict limits. Nothing here trusts the prover:
 * the domain comes from the signed binding, the URLs are built here, every
 * answer is bounded and parsed strictly, and lookups are cached only briefly.
 *
 * What a check reveals, and to whom:
 *  - DNS: the chosen resolver learns that this device looked up `_ghostly.<domain>`.
 *    The domain's own servers see only the resolver.
 *  - HTTPS / NIP-05: the resolver learns the domain (its addresses are looked up
 *    first, to refuse private networks), and the domain's web server — run by
 *    the person being checked — sees this device's IP address and when.
 */

export type DohResolverId = 'quad9' | 'cloudflare' | 'google';
export interface DohResolver { id: DohResolverId; name: string; url: string }
/** Public resolvers that answer RFC 8484 wire-format GETs with CORS (checked 2026-09-23). */
export const DOH_RESOLVERS: readonly DohResolver[] = [
  { id: 'quad9', name: 'Quad9', url: 'https://dns.quad9.net/dns-query' },
  { id: 'cloudflare', name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { id: 'google', name: 'Google', url: 'https://dns.google/dns-query' },
];
export const DEFAULT_RESOLVER: DohResolverId = 'quad9';
export const resolverById = (id: string | null | undefined): DohResolver =>
  DOH_RESOLVERS.find(r => r.id === id) ?? DOH_RESOLVERS.find(r => r.id === DEFAULT_RESOLVER)!;

/** The person's resolver choice, per browser profile (UI and engine share the origin). */
export const RESOLVER_SETTING = 'ghostly-doh-resolver';
export function chosenResolver(): DohResolver {
  try { return resolverById(globalThis.localStorage?.getItem(RESOLVER_SETTING)); } catch { return resolverById(undefined); }
}
export function chooseResolver(id: DohResolverId): void {
  try { globalThis.localStorage?.setItem(RESOLVER_SETTING, resolverById(id).id); } catch { /* not persisted: the default stays */ }
}

export const DNS_MAX_BYTES = 16 * 1024;
/**
 * Lookups are shared between checks for the DNS TTL, capped: never staler than the resolver itself would
 * be, so a re-check sees a removal as soon as DNS does. Files have no TTL and are only shared in flight.
 */
const CACHE_MAX_MS = 30_000, CACHE_FILE_MS = 0;

/** The contract's `ctx.fetch`: HTTPS GET, no credentials, bounded, redirects refused unless asked, with raw bytes. */
export type DomainFetch = IdentityFetch;

export interface DomainLookupOptions {
  fetch: DomainFetch;
  resolver?: DohResolverId;
  signal?: AbortSignal;
  /** Milliseconds. */
  now?: () => number;
}

/** A check that did not confirm the record, with a message for people. */
export class DomainCheckError extends Error {}

/** One RFC 8484 GET. The query has ID 0 and no client subnet, so it carries only the name. */
export async function dohQuery(name: string, type: DnsType, options: DomainLookupOptions): Promise<DnsResponse> {
  const resolver = resolverById(options.resolver);
  let response: Awaited<ReturnType<DomainFetch>>;
  try {
    response = await options.fetch(`${resolver.url}?dns=${toBase64Url(encodeDnsQuery(name, type))}`, {
      headers: { accept: 'application/dns-message' }, maxBytes: DNS_MAX_BYTES, signal: options.signal, redirect: 'error' });
  } catch (e) {
    throw new DomainCheckError(/too large/i.test(String(e)) ? `${resolver.name} sent an answer that is too large` : `${resolver.name} could not be reached`);
  }
  if (response.status !== 200 || !/^application\/dns-message\b/i.test(response.contentType))
    throw new DomainCheckError(`${resolver.name} refused the lookup`);
  let answer: DnsResponse;
  try { answer = decodeDnsResponse(response.bytes, name, type); } catch { throw new DomainCheckError(`${resolver.name} sent an unusable answer`); }
  if (answer.rcode !== 0 && answer.rcode !== 3) throw new DomainCheckError(`${resolver.name} could not resolve ${name}`);
  return answer;
}

/**
 * Refuses a domain whose addresses are not all public before its web server is
 * contacted, so a proof cannot make a contact's app probe their own network.
 * The browser resolves again when it fetches; a name that changes its answer in
 * between (rebinding) is not fully excluded by this check — see the draft.
 */
export async function assertPublicHost(domain: string, options: DomainLookupOptions): Promise<void> {
  const [v4, v6] = await Promise.all([dohQuery(domain, 'A', options), dohQuery(domain, 'AAAA', options)]);
  const addresses = [...v4.answers, ...v6.answers].map(a => a.data);
  if (!addresses.length) throw new DomainCheckError(`${domain} has no address`);
  if (!addresses.every(isPublicAddress)) throw new DomainCheckError(`${domain} points to a private network address, so it was not contacted`);
}

/** A well-known file: https only, no redirects, bounded. `undefined` when the server says it is not there. */
export async function fetchWellKnown(domain: string, method: 'https' | 'nip05', options: DomainLookupOptions): Promise<string | undefined> {
  await assertPublicHost(domain, options);
  const url = wellKnownUrl(domain, method);
  let response: Awaited<ReturnType<DomainFetch>>;
  try {
    response = await options.fetch(url, { headers: { accept: 'application/json' }, maxBytes: DOMAIN_FILE_MAX_BYTES, signal: options.signal, redirect: 'error' });
  } catch (e) {
    throw new DomainCheckError(/too large/i.test(String(e)) ? `${url} is too large`
      : `${domain} could not be reached. The file must be served at exactly this address, without a redirect, with the header Access-Control-Allow-Origin: *`);
  }
  if (response.status === 404 || response.status === 410) return;
  if (response.status >= 300 && response.status < 400) throw new DomainCheckError(`${domain} answered with a redirect; the file must be served at exactly ${url}`);
  if (response.status !== 200) throw new DomainCheckError(`${domain} answered ${response.status}`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(response.bytes); } catch { throw new DomainCheckError(`${url} is not text`); }
}

export interface DomainLookup {
  domain: string;
  method: DomainMethod;
  /** DNS / HTTPS: the Ghostly records found. */
  records: DomainRecord[];
  /** NIP-05: the Nostr key named for the domain itself. */
  nostrKey?: string;
  /** A record or file exists at all (as opposed to nothing there). */
  found: boolean;
  /** The resolver reported DNSSEC validation of the TXT answer. */
  dnssec: boolean;
  resolver: DohResolverId;
}

async function lookup(domain: string, method: DomainMethod, options: DomainLookupOptions): Promise<DomainLookup & { ttlMs: number }> {
  const resolver = resolverById(options.resolver).id;
  if (method === 'dns') {
    const answer = await dohQuery(dnsProofName(domain), 'TXT', options);
    const values: string[] = [];
    for (const record of answer.answers.slice(0, 32)) { try { values.push(txtValue(record.data)); } catch { /* not text: not ours */ } }
    const ttlMs = answer.answers.length ? Math.min(...answer.answers.map(a => a.ttl)) * 1000 : 0;
    return { domain, method, resolver, records: recordsFromTxt(values), found: answer.answers.length > 0, dnssec: answer.authenticated, ttlMs };
  }
  const text = await fetchWellKnown(domain, method, options);
  const base = { domain, method, resolver, dnssec: false, records: [] as DomainRecord[], ttlMs: CACHE_FILE_MS };
  if (text === undefined) return { ...base, found: false };
  try {
    return method === 'nip05' ? { ...base, found: true, nostrKey: nip05RootKey(text) } : { ...base, found: true, records: recordsFromWellKnown(text) };
  } catch { throw new DomainCheckError(`${wellKnownUrl(domain, method)} is not a valid ${method === 'nip05' ? 'NIP-05' : 'Ghostly'} file`); }
}

const cache = new Map<string, { until: number; result: Promise<DomainLookup & { ttlMs: number }> }>();
/** Tests only. */
export function clearDomainCache(): void { cache.clear(); }

/** What a domain publishes by one method. Concurrent and back-to-back checks share one lookup. */
export async function lookupDomain(domainInput: string, method: DomainMethod, options: DomainLookupOptions): Promise<DomainLookup> {
  const domain = normalizeDomain(domainInput), now = options.now ?? Date.now, resolver = resolverById(options.resolver).id;
  const id = `${resolver}|${method}|${domain}`;
  const hit = cache.get(id);
  if (hit && hit.until > now()) { const { ttlMs: _ttl, ...result } = await hit.result; return result; }
  const started = now();
  const entry = { until: started + CACHE_MAX_MS, result: lookup(domain, method, { ...options, resolver }) };
  cache.set(id, entry);
  if (cache.size > 128) cache.delete(cache.keys().next().value!);
  try {
    const { ttlMs, ...result } = await entry.result;
    entry.until = started + Math.min(CACHE_MAX_MS, ttlMs);
    return result;
  } catch (e) {
    if (cache.get(id) === entry) cache.delete(id);
    throw e;
  }
}

/** Throws unless `domain` publishes `record` by `method` (DNS or HTTPS). Returns what was found. */
export async function assertDomainRecord(domain: string, method: 'dns' | 'https', record: DomainRecord, options: DomainLookupOptions): Promise<DomainLookup> {
  const found = await lookupDomain(domain, method, options);
  if (recordsName(found.records, record)) return found;
  const where = method === 'dns' ? `The TXT record at ${dnsProofName(domain)}` : wellKnownUrl(domain);
  if (found.records.some(r => r.key === record.key)) throw new DomainCheckError(`${where} is for another proof of this key`);
  if (found.records.length) throw new DomainCheckError(`${where} names another Ghostly key: this proof was replaced or removed`);
  throw new DomainCheckError(method === 'dns'
    ? `No Ghostly TXT record at ${dnsProofName(domain)}${found.found ? '' : ' (DNS changes can take a few minutes)'}`
    : found.found ? `${wellKnownUrl(domain)} names no Ghostly proof` : `${wellKnownUrl(domain)} was not found`);
}

/** Throws unless the domain's NIP-05 root name is `nostrKey`. */
export async function assertNip05(domain: string, nostrKey: string, options: DomainLookupOptions): Promise<DomainLookup> {
  const found = await lookupDomain(domain, 'nip05', options);
  if (found.nostrKey === nostrKey) return found;
  const url = wellKnownUrl(domain, 'nip05');
  throw new DomainCheckError(!found.found ? `${url} was not found` : found.nostrKey
    ? `${url} names another Nostr key for ${domain}` : `${url} has no root name "_" for ${domain}`);
}
