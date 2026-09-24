import { describe, expect, it } from 'vitest';
import { createIdentity } from '../src/identity';
import {
  decodeDnsResponse, domainTxtRecord, domainWellKnownFile, dnsProofName, encodeDnsQuery, isPublicAddress, nip05RootKey,
  normalizeDomain, parseDomainTxt, recordsFromTxt, recordsFromWellKnown, recordsName, txtValue, wellKnownUrl, type DomainRecord,
} from '../src/domainProofs';
// covers: proofs.domain.dns, proofs.domain.https

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const record = (): DomainRecord => ({ key: createIdentity().pubKeyZ32, proof: hex(crypto.getRandomValues(new Uint8Array(32))) });
const mine = record();

describe('domain names', () => {
  it('normalizes what people type into one lowercase ASCII host', () => {
    expect(normalizeDomain(' Example.COM. ')).toBe('example.com');
    expect(normalizeDomain('https://Sub.Example.com/')).toBe('sub.example.com');
    expect(normalizeDomain('bücher.de')).toBe('xn--bcher-kva.de');
    expect(dnsProofName('Example.com')).toBe('_ghostly.example.com');
    expect(wellKnownUrl('example.com')).toBe('https://example.com/.well-known/ghostly.json');
    expect(wellKnownUrl('example.com', 'nip05')).toBe('https://example.com/.well-known/nostr.json?name=_');
  });

  it.each([
    ['', /Enter a domain/], ['example', /full domain/], ['127.0.0.1', /IP address/], ['0x7f.1', /IP address/], ['[::1]', /without a path/],
    ['localhost', /full domain/], ['app.localhost', /private networks/], ['printer.local', /private networks/], ['nas.home.arpa', /private networks/],
    ['x.internal', /private networks/], ['a.onion', /private networks/], ['example.com:8443', /without a path/],
    ['example.com/path', /without a path/], ['http://example.com', /without a path/], ['https://example.com/x', /without a path/],
    ['user@example.com', /without a path/], ['-bad.com', /not a valid/], ['a_b.com', /not a valid/], [`${'a'.repeat(64)}.com`, /not a valid|too long/],
    [`${'abcdefgh.'.repeat(28)}com`, /too long/],
  ])('refuses %j', (input, message) => {
    expect(() => normalizeDomain(input)).toThrow(message);
  });
});

describe('record formats', () => {
  it('writes and reads back the TXT record', () => {
    const txt = domainTxtRecord(mine);
    expect(txt).toBe(`v=ghostly1; key=${mine.key}; proof=${mine.proof}`);
    expect(txt.length).toBeLessThan(255);
    expect(parseDomainTxt(txt)).toEqual(mine);
    expect(parseDomainTxt(`v=ghostly1;proof=${mine.proof};key=${mine.key};future=1`)).toEqual(mine);
    expect(parseDomainTxt(`V=ghostly1; KEY=${mine.key}; Proof=${mine.proof}`)).toEqual(mine);
  });

  it.each([
    ['another service', 'v=spf1 -all'],
    ['v not first', `key=${mine.key}; v=ghostly1; proof=${mine.proof}`],
    ['another version', `v=ghostly2; key=${mine.key}; proof=${mine.proof}`],
    ['no statement id', `v=ghostly1; key=${mine.key}`],
    ['no key', `v=ghostly1; proof=${mine.proof}`],
    ['a duplicated tag', `v=ghostly1; key=${mine.key}; proof=${mine.proof}; proof=${mine.proof}`],
    ['a non-canonical key', `v=ghostly1; key=${mine.key.slice(0, 51)}9; proof=${mine.proof}`],
    ['an uppercase statement id', `v=ghostly1; key=${mine.key}; proof=${mine.proof.toUpperCase()}`],
    ['a short statement id', `v=ghostly1; key=${mine.key}; proof=${mine.proof.slice(1)}`],
    ['a bare word', `v=ghostly1; key=${mine.key}; proof=${mine.proof}; junk`],
    ['an oversized string', `v=ghostly1; key=${mine.key}; proof=${mine.proof}; x=${'y'.repeat(1100)}`],
  ])('ignores a TXT string with %s', (_, value) => {
    expect(parseDomainTxt(value)).toBeUndefined();
  });

  it('collects distinct records from every TXT string at the name, bounded', () => {
    const other = record();
    expect(recordsFromTxt(['v=spf1 -all', domainTxtRecord(mine), domainTxtRecord(other), domainTxtRecord(mine)])).toEqual([mine, other]);
    expect(recordsFromTxt(Array.from({ length: 40 }, () => domainTxtRecord(record())))).toHaveLength(8);
  });

  it('writes and reads back ghostly.json, skipping entries it does not understand', () => {
    const file = domainWellKnownFile([mine]);
    expect(JSON.parse(file)).toEqual({ ghostly: 1, proofs: [{ key: mine.key, proof: mine.proof }] });
    expect(recordsFromWellKnown(file)).toEqual([mine]);
    expect(recordsFromWellKnown(JSON.stringify({ ghostly: 1, proofs: [{ key: 'x', proof: 'y' }, null, 5, { ...mine, note: 1 }], note: 'hi' }))).toEqual([mine]);
    expect(recordsFromWellKnown(JSON.stringify({ ghostly: 1, proofs: [] }))).toEqual([]);
  });

  it.each([
    ['not JSON', '<html>'], ['without a version', JSON.stringify({ proofs: [] })], ['an array', '[]'],
    ['another version', JSON.stringify({ ghostly: 2, proofs: [] })], ['a file whose proofs are not a list', JSON.stringify({ ghostly: 1, proofs: {} })],
    ['too large', JSON.stringify({ ghostly: 1, proofs: [], pad: 'x'.repeat(17000) })],
  ])('refuses a ghostly.json that is %s', (_, text) => {
    expect(() => recordsFromWellKnown(text)).toThrow();
  });

  it('reads only the root name of a NIP-05 file', () => {
    const nostr = 'd'.repeat(64);
    expect(nip05RootKey(JSON.stringify({ names: { _: nostr, bob: 'e'.repeat(64) }, relays: {} }))).toBe(nostr);
    expect(nip05RootKey(JSON.stringify({ names: { bob: nostr } }))).toBeUndefined();
    expect(nip05RootKey(JSON.stringify({ names: { _: 'D'.repeat(64) } }))).toBeUndefined();
    expect(() => nip05RootKey(JSON.stringify({ names: [] }))).toThrow();
    expect(() => nip05RootKey('nope')).toThrow();
  });

  it('matches only a record naming both the key and the statement', () => {
    expect(recordsName([mine], mine)).toBe(true);
    expect(recordsName([mine], { ...mine, proof: record().proof })).toBe(false);
    expect(recordsName([mine], { ...mine, key: record().key })).toBe(false);
  });
});

describe('DNS over HTTPS messages', () => {
  const reply = (question: Uint8Array, answers: Uint8Array, count: number, flags = 0x8180) => {
    const out = new Uint8Array(question.length + answers.length);
    out.set(question); out.set(answers, question.length);
    out[2] = flags >> 8; out[3] = flags & 0xff; out[6] = 0; out[7] = count;
    return out;
  };
  const name = (n: string) => n.split('.').flatMap(l => [l.length, ...new TextEncoder().encode(l)]).concat(0);
  const answersOf = (records: { name: string; value: string; ttl: number }[]) => Uint8Array.from(records.flatMap(r => {
    const bytes = [...new TextEncoder().encode(r.value)], strings: number[] = [];
    for (let i = 0; i < bytes.length; i += 255) { const chunk = bytes.slice(i, i + 255); strings.push(chunk.length, ...chunk); }
    return [...name(r.name), 0, 16, 0, 1, r.ttl >>> 24, (r.ttl >> 16) & 0xff, (r.ttl >> 8) & 0xff, r.ttl & 0xff, strings.length >> 8, strings.length & 0xff, ...strings];
  }));

  it('encodes a recursive query asking for DNSSEC status', () => {
    const q = encodeDnsQuery('_ghostly.example.com', 'TXT');
    expect(hex(q.subarray(0, 12))).toBe('000001200001000000000000');
    expect(decodeDnsResponse(reply(q, new Uint8Array(), 0, 0x81a0), '_ghostly.example.com', 'TXT')).toEqual({ rcode: 0, authenticated: true, answers: [] });
  });

  it('keeps the TXT answers for the name, joining split strings', () => {
    const q = encodeDnsQuery('_ghostly.example.com', 'TXT'), value = domainTxtRecord(mine) + '; pad=' + 'x'.repeat(300);
    const r = decodeDnsResponse(reply(q, answersOf([{ name: '_ghostly.example.com', value, ttl: 300 }, { name: 'other.com', value: 'nope', ttl: 1 }]), 2), '_ghostly.example.com', 'TXT');
    expect(r.answers).toHaveLength(1);
    expect(r.answers[0].ttl).toBe(300);
    expect(txtValue(r.answers[0].data)).toBe(value);
    expect(parseDomainTxt(txtValue(r.answers[0].data))).toEqual(mine);
  });

  it('reports NXDOMAIN and refuses truncated, mismatched and malformed replies', () => {
    const q = encodeDnsQuery('_ghostly.example.com', 'TXT');
    expect(decodeDnsResponse(reply(q, new Uint8Array(), 0, 0x8183), '_ghostly.example.com', 'TXT').rcode).toBe(3);
    expect(() => decodeDnsResponse(reply(q, new Uint8Array(), 0, 0x8380), '_ghostly.example.com', 'TXT')).toThrow(/Unusable/);
    expect(() => decodeDnsResponse(q, '_ghostly.example.com', 'TXT')).toThrow(/Unusable/);
    expect(() => decodeDnsResponse(reply(q, new Uint8Array(), 0), '_ghostly.evil.com', 'TXT')).toThrow(/another question/);
    expect(() => decodeDnsResponse(reply(q, new Uint8Array(), 0), '_ghostly.example.com', 'A')).toThrow(/another question/);
    expect(() => decodeDnsResponse(reply(q, answersOf([{ name: '_ghostly.example.com', value: 'x', ttl: 1 }]).subarray(0, 20), 1), '_ghostly.example.com', 'TXT')).toThrow(/bounds/);
    const loop = reply(q, Uint8Array.of(0xc0, q.length, 0, 16, 0, 1, 0, 0, 0, 1, 0, 0), 1);
    expect(() => decodeDnsResponse(loop, '_ghostly.example.com', 'TXT')).toThrow(/loops|bounds/);
  });

  it('follows the CNAME chain the answer itself gives, and nothing else', () => {
    const q = encodeDnsQuery('_ghostly.example.com', 'TXT');
    const target = name('proofs.host.net');
    const cname = new Uint8Array([...name('_ghostly.example.com'), 0, 5, 0, 1, 0, 0, 0, 60, 0, target.length, ...target]);
    const txt = answersOf([{ name: 'proofs.host.net', value: domainTxtRecord(mine), ttl: 60 }, { name: 'unrelated.net', value: domainTxtRecord(mine), ttl: 60 }]);
    const r = decodeDnsResponse(reply(q, new Uint8Array([...cname, ...txt]), 3), '_ghostly.example.com', 'TXT');
    expect(r.answers.map(a => a.name)).toEqual(['proofs.host.net']);
  });
});

describe('public addresses only', () => {
  const v6 = (s: string) => {
    const [head, tail = ''] = s.split('::');
    const parse = (p: string) => p ? p.split(':').flatMap(x => { const n = parseInt(x, 16); return [n >> 8, n & 0xff]; }) : [];
    const h = parse(head), t = parse(tail);
    return Uint8Array.from([...h, ...new Array(16 - h.length - t.length).fill(0), ...t]);
  };
  it.each(['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '192.0.0.8', '198.18.0.1', '224.0.0.1', '255.255.255.255'])('refuses %s', a => {
    expect(isPublicAddress(Uint8Array.from(a.split('.').map(Number)))).toBe(false);
  });
  it.each(['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '203.0.113.7'])('allows %s', a => {
    expect(isPublicAddress(Uint8Array.from(a.split('.').map(Number)))).toBe(true);
  });
  it.each(['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1', '::ffff:7f00:1', '::ffff:c0a8:101', '64:ff9b::a00:1', '::a00:1', '100::1'])('refuses %s', a => {
    expect(isPublicAddress(v6(a))).toBe(false);
  });
  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:808:808', '64:ff9b::808:808'])('allows %s', a => {
    expect(isPublicAddress(v6(a))).toBe(true);
  });
  it('refuses anything that is not an address', () => expect(isPublicAddress(new Uint8Array(5))).toBe(false));
});
