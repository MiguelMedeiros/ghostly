import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentity, domainTxtRecord, domainWellKnownFile, type DomainRecord } from '@ghostly/core';
import {
  assertDomainRecord, assertNip05, clearDomainCache, dohQuery, lookupDomain, type DomainFetch,
} from '../src/proofs/domain';
import { answerDoh, queryFromUrl, type Zone } from './helpers/dohZone';
// covers: proofs.domain.dns, proofs.domain.https, proofs.domain.resolver

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const record = (): DomainRecord => ({ key: createIdentity().pubKeyZ32, proof: hex(crypto.getRandomValues(new Uint8Array(32))) });
const mine = record(), other = record();

interface Site { status?: number; body?: string | Uint8Array; contentType?: string; unreachable?: boolean }
/** A fake `ctx.fetch`: DoH resolvers answer from `zone`, sites from `sites`. */
function network(zone: Zone, sites: Record<string, Site> = {}) {
  const calls: { url: string; options?: Parameters<DomainFetch>[1] }[] = [];
  const fetch: DomainFetch = vi.fn(async (url, options) => {
    calls.push({ url, options });
    if (/^https:\/\/(dns\.quad9\.net|cloudflare-dns\.com|dns\.google)\/dns-query\?/.test(url)) {
      const bytes = answerDoh(queryFromUrl(url), zone);
      return { status: 200, contentType: 'application/dns-message', bytes, text: '' };
    }
    const site = sites[url];
    if (!site || site.unreachable) throw new TypeError('Failed to fetch');
    const bytes = typeof site.body === 'string' ? new TextEncoder().encode(site.body) : site.body ?? new Uint8Array();
    if (options?.maxBytes !== undefined && bytes.length > options.maxBytes) throw new Error('Identity check response too large');
    return { status: site.status ?? 200, contentType: site.contentType ?? 'application/json', bytes, text: new TextDecoder().decode(bytes) };
  });
  return { fetch, calls };
}

beforeEach(() => clearDomainCache());

describe('DNS TXT through DNS over HTTPS', () => {
  it('finds the record at _ghostly.<domain>, asking only the chosen resolver, redirects refused', async () => {
    const net = network({ txt: { '_ghostly.example.com': ['v=spf1 -all', domainTxtRecord(mine)] }, dnssec: true });
    const found = await assertDomainRecord('example.com', 'dns', mine, { fetch: net.fetch });
    expect(found).toMatchObject({ records: [mine], dnssec: true, resolver: 'quad9', found: true });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].url).toMatch(/^https:\/\/dns\.quad9\.net\/dns-query\?dns=[A-Za-z0-9_-]+$/);
    expect(net.calls[0].options).toMatchObject({ redirect: 'error', maxBytes: 16384, headers: { accept: 'application/dns-message' } });
  });

  it('uses the resolver the person picked', async () => {
    const net = network({ txt: { '_ghostly.example.com': [domainTxtRecord(mine)] } });
    await assertDomainRecord('example.com', 'dns', mine, { fetch: net.fetch, resolver: 'cloudflare' });
    expect(net.calls.map(c => new URL(c.url).host)).toEqual(['cloudflare-dns.com']);
  });

  it('says why a record does not confirm the proof', async () => {
    const reused = { ...mine, proof: other.proof };
    const net = network({ txt: { '_ghostly.replaced.com': [domainTxtRecord(other)], '_ghostly.reused.com': [domainTxtRecord(reused)], '_ghostly.empty.com': ['v=spf1 -all'] } });
    await expect(assertDomainRecord('replaced.com', 'dns', mine, { fetch: net.fetch })).rejects.toThrow(/another Ghostly key/);
    await expect(assertDomainRecord('reused.com', 'dns', mine, { fetch: net.fetch })).rejects.toThrow(/another proof of this key/);
    await expect(assertDomainRecord('empty.com', 'dns', mine, { fetch: net.fetch })).rejects.toThrow(/^No Ghostly TXT record at _ghostly.empty.com$/);
    await expect(assertDomainRecord('nowhere.com', 'dns', mine, { fetch: net.fetch })).rejects.toThrow(/take a few minutes/);
  });

  it('shares a lookup for its TTL, at most 30 seconds, so a re-check sees a removed record', async () => {
    const zone: Zone = { txt: { '_ghostly.example.com': [domainTxtRecord(mine)] }, ttl: 3600 };
    const net = network(zone);
    let now = 0;
    const options = { fetch: net.fetch, now: () => now };
    await assertDomainRecord('example.com', 'dns', mine, options);
    zone.txt = {};
    now = 29_000;
    await assertDomainRecord('example.com', 'dns', mine, options);
    expect(net.calls).toHaveLength(1);
    now = 30_000;
    await expect(assertDomainRecord('example.com', 'dns', mine, options)).rejects.toThrow(/No Ghostly TXT record/);
    // A miss is not kept: the record shows up as soon as it is back.
    zone.txt = { '_ghostly.example.com': [domainTxtRecord(mine)] };
    zone.ttl = 1;
    now = 30_500;
    await assertDomainRecord('example.com', 'dns', mine, options);
    // A one-second TTL is kept one second.
    zone.txt = {};
    now = 31_400;
    await assertDomainRecord('example.com', 'dns', mine, options);
    now = 31_500;
    await expect(assertDomainRecord('example.com', 'dns', mine, options)).rejects.toThrow(/No Ghostly TXT record/);
  });

  it('shares one lookup between concurrent checks and forgets a failed one', async () => {
    const net = network({ txt: { '_ghostly.example.com': [domainTxtRecord(mine)] } });
    await Promise.all([1, 2, 3].map(() => lookupDomain('example.com', 'dns', { fetch: net.fetch })));
    expect(net.calls).toHaveLength(1);
    const down: DomainFetch = vi.fn(async () => { throw new TypeError('offline'); });
    await expect(lookupDomain('down.com', 'dns', { fetch: down })).rejects.toThrow(/could not be reached/);
    await expect(lookupDomain('down.com', 'dns', { fetch: down })).rejects.toThrow(/could not be reached/);
    expect(down).toHaveBeenCalledTimes(2);
  });

  it.each<[string, DomainFetch, RegExp]>([
    ['an error status', async () => ({ status: 503, contentType: 'application/dns-message', text: '', bytes: new Uint8Array() }), /refused/],
    ['HTML instead of DNS', async () => ({ status: 200, contentType: 'text/html', text: '<html>', bytes: new Uint8Array() }), /refused/],
    ['garbage', async () => ({ status: 200, contentType: 'application/dns-message', text: '', bytes: new Uint8Array(40) }), /unusable/],
    ['an oversized answer', async () => { throw new Error('Identity check response too large'); }, /too large/],
    ['a time-out', async () => { throw new DOMException('timed out', 'TimeoutError'); }, /could not be reached/],
  ])('fails, never confirms, on %s from the resolver', async (_, fetch, message) => {
    await expect(assertDomainRecord('example.com', 'dns', mine, { fetch })).rejects.toThrow(message);
  });

  it('refuses an answer to another question and a server failure', async () => {
    const evil = answerDoh(queryFromUrl(`https://x/?dns=${btoa(String.fromCharCode(0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 4, 101, 118, 105, 108, 3, 99, 111, 109, 0, 0, 16, 0, 1)).replace(/=+$/, '')}`), {});
    await expect(dohQuery('_ghostly.example.com', 'TXT', { fetch: async () => ({ status: 200, contentType: 'application/dns-message', text: '', bytes: evil }) })).rejects.toThrow(/unusable/);
    const servfail: DomainFetch = async url => { const b = answerDoh(queryFromUrl(url), {}); b[3] = (b[3] & 0xf0) | 2; return { status: 200, contentType: 'application/dns-message', text: '', bytes: b }; };
    await expect(dohQuery('_ghostly.example.com', 'TXT', { fetch: servfail })).rejects.toThrow(/could not resolve/);
  });

  it('refuses a name the prover wrote in a private or non-canonical form before any request', async () => {
    const net = network({});
    await expect(lookupDomain('localhost', 'https', { fetch: net.fetch })).rejects.toThrow(/full domain/);
    await expect(lookupDomain('10.0.0.1', 'dns', { fetch: net.fetch })).rejects.toThrow(/IP address/);
    await expect(lookupDomain('router.home.arpa', 'https', { fetch: net.fetch })).rejects.toThrow(/private networks/);
    expect(net.calls).toHaveLength(0);
  });
});

describe('/.well-known/ghostly.json and NIP-05', () => {
  const url = 'https://example.com/.well-known/ghostly.json';
  const publicZone: Zone = { a: { 'example.com': ['203.0.113.7'] } };

  it('reads the record from the file after checking every address is public', async () => {
    const net = network(publicZone, { [url]: { body: domainWellKnownFile([other, mine]) } });
    expect(await assertDomainRecord('example.com', 'https', mine, { fetch: net.fetch })).toMatchObject({ found: true, dnssec: false, records: [other, mine] });
    expect(net.calls.find(c => c.url === url)!.options).toMatchObject({ redirect: 'error', maxBytes: 16384 });
    expect(net.calls.filter(c => c.url.includes('dns-query'))).toHaveLength(2);
  });

  it.each([
    ['loopback', { a: { 'example.com': ['127.0.0.1'] } }],
    ['a private network among public addresses', { a: { 'example.com': ['203.0.113.7', '192.168.1.10'] } }],
    ['cloud metadata', { a: { 'example.com': ['169.254.169.254'] } }],
    ['IPv6 loopback', { aaaa: { 'example.com': [Uint8Array.from([...new Array(15).fill(0), 1])] } }],
  ] as [string, Zone][])('never contacts a domain that points to %s', async (_, zone) => {
    const net = network(zone, { [url]: { body: domainWellKnownFile([mine]) } });
    await expect(assertDomainRecord('example.com', 'https', mine, { fetch: net.fetch })).rejects.toThrow(/private network/);
    expect(net.calls.some(c => c.url === url)).toBe(false);
  });

  it('never contacts a domain without an address', async () => {
    const net = network({}, { [url]: { body: domainWellKnownFile([mine]) } });
    await expect(assertDomainRecord('example.com', 'https', mine, { fetch: net.fetch })).rejects.toThrow('example.com has no address');
    expect(net.calls.some(c => c.url === url)).toBe(false);
  });

  it.each<[string, Site, RegExp]>([
    ['unreachable (a redirect refused, or no CORS header)', { unreachable: true }, /without a redirect.*Access-Control-Allow-Origin/],
    ['a redirect status', { status: 301 }, /redirect/],
    ['too large', { body: JSON.stringify({ ghostly: 1, proofs: [], pad: 'x'.repeat(17_000) }) }, /too large/],
    ['not UTF-8', { body: Uint8Array.of(0xff, 0xfe, 0x7b) }, /not text/],
    ['HTML', { body: '<html>hi</html>' }, /not a valid Ghostly file/],
    ['a server error', { status: 500 }, /answered 500/],
    ['absent', { status: 404 }, /was not found/],
    ['empty', { body: '{"ghostly":1,"proofs":[]}' }, /names no Ghostly proof/],
    ['for another key', { body: domainWellKnownFile([other]) }, /another Ghostly key/],
  ])('does not confirm a file that is %s', async (_, site, message) => {
    const net = network(publicZone, { [url]: site });
    await expect(assertDomainRecord('example.com', 'https', mine, { fetch: net.fetch })).rejects.toThrow(message);
  });

  it('reads the NIP-05 root name only, and only for the same Nostr key', async () => {
    const nostr = 'a'.repeat(64), nip = 'https://example.com/.well-known/nostr.json?name=_';
    const net = network(publicZone, { [nip]: { body: JSON.stringify({ names: { _: nostr, bob: 'b'.repeat(64) } }) } });
    expect((await assertNip05('example.com', nostr, { fetch: net.fetch })).nostrKey).toBe(nostr);
    await expect(assertNip05('example.com', 'b'.repeat(64), { fetch: net.fetch })).rejects.toThrow(/another Nostr key/);
    clearDomainCache();
    const none = network(publicZone, { [nip]: { body: JSON.stringify({ names: { bob: nostr } }) } });
    await expect(assertNip05('example.com', nostr, { fetch: none.fetch })).rejects.toThrow(/no root name/);
  });
});
