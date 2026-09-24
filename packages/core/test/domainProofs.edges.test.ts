import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createIdentity } from '../src/identity';
import {
  DOMAIN_FILE_MAX_BYTES, DOMAIN_TXT_MAX_BYTES, decodeDnsResponse, domainTxtRecord, domainWellKnownFile, encodeDnsQuery, isPublicAddress, nip05RootKey,
  normalizeDomain, parseDomainTxt, recordsFromTxt, recordsFromWellKnown, txtValue, type DomainRecord,
} from '../src/domainProofs';

// covers: proofs.domain.dns, proofs.domain.https

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const record = (): DomainRecord => ({ key: createIdentity().pubKeyZ32, proof: hex(crypto.getRandomValues(new Uint8Array(32))) });
const mine = record();

// ---- DNS wire messages, built by hand ----
const NAME = '_ghostly.example.com';
const labels = (n: string) => n.split('.').flatMap(l => { const b = [...new TextEncoder().encode(l)]; return [b.length, ...b]; }).concat(0);
const u16 = (n: number) => [n >> 8, n & 0xff];
const header = (flags: number, qd: number, an: number) => [0, 0, ...u16(flags), ...u16(qd), ...u16(an), 0, 0, 0, 0];
const question = (name = NAME, type = 16) => [...labels(name), ...u16(type), 0, 1];
const rr = (owner: number[], type: number, rdata: number[], ttl = 60) => [...owner, ...u16(type), 0, 1, 0, 0, ...u16(ttl), ...u16(rdata.length), ...rdata];
const txt = (value: string) => { const b = [...new TextEncoder().encode(value)]; return [b.length, ...b]; };
const message = (answers: number[][], flags = 0x8180, q = question()) => Uint8Array.from([...header(flags, 1, answers.length), ...q, ...answers.flat()]);
const decode = (data: Uint8Array, name = NAME) => decodeDnsResponse(data, name, 'TXT');

describe('DNS answers', () => {
  it('reads an owner name compressed to point at the question, as resolvers send it', () => {
    const r = decode(message([rr([0xc0, 12], 16, txt(domainTxtRecord(mine)))]));
    expect(r.answers).toHaveLength(1);
    expect(parseDomainTxt(txtValue(r.answers[0].data))).toEqual(mine);
  });

  it('matches owner names case-insensitively, and reports rcode and DNSSEC as sent', () => {
    const r = decode(message([rr(labels('_GHOSTLY.Example.COM'), 16, txt('x'))], 0x81a2));
    expect(r).toMatchObject({ rcode: 2, authenticated: true });
    expect(r.answers.map(a => a.name)).toEqual([NAME]);
  });

  it('reads a reply that is a view into a larger buffer', () => {
    const data = message([rr([0xc0, 12], 16, txt('hello'))]);
    const padded = new Uint8Array(data.length + 10);
    padded.set(data, 7);
    expect(txtValue(decode(padded.subarray(7, 7 + data.length)).answers[0].data)).toBe('hello');
  });

  it('reads at most 64 records', () => {
    const many = Array.from({ length: 70 }, () => rr([0xc0, 12], 16, txt('x')));
    expect(decode(message(many)).answers).toHaveLength(64);
  });

  it('stops following CNAMEs after eight hops and on a loop', () => {
    const hop = (from: string, to: string) => rr(labels(from), 5, labels(to));
    const chain = Array.from({ length: 10 }, (_, i) => hop(i ? `h${i}.net` : NAME, `h${i + 1}.net`));
    const r = decode(message([...chain, ...Array.from({ length: 11 }, (_, i) => rr(labels(i ? `h${i}.net` : NAME), 16, txt(`at ${i}`)))]));
    expect(r.answers.map(a => a.name)).toEqual([NAME, ...Array.from({ length: 8 }, (_, i) => `h${i + 1}.net`)]);
    const loop = decode(message([hop(NAME, 'a.net'), hop('a.net', NAME), rr(labels('a.net'), 16, txt('y'))]));
    expect(loop.answers.map(a => a.name)).toEqual(['a.net']);
  });

  it('refuses replies too short, for no or several questions, or with a truncation or opcode flag', () => {
    expect(() => decode(new Uint8Array(11))).toThrow('DNS response too short');
    for (const qd of [0, 2]) expect(() => decode(Uint8Array.from([...header(0x8180, qd, 0), ...question()]))).toThrow('DNS response is for another question');
    expect(() => decode(message([], 0x8380))).toThrow('Unusable DNS response');
    expect(() => decode(message([], 0x8980))).toThrow('Unusable DNS response');
  });

  it('refuses names that run out, point out of bounds, use reserved label types or exceed 255 bytes', () => {
    const bare = (q: number[]) => Uint8Array.from([...header(0x8180, 1, 0), ...q]);
    expect(() => decode(bare([8, ...new TextEncoder().encode('_ghostly')]))).toThrow('DNS name out of bounds');
    expect(() => decode(bare([30, 1, 2]))).toThrow('DNS label out of bounds');
    expect(() => decode(bare([0xc0]))).toThrow('DNS pointer out of bounds');
    expect(() => decode(bare([0xc0, 200]))).toThrow('DNS name out of bounds');
    for (const kind of [0x40, 0x80]) expect(() => decode(bare([kind | 1, 0x61, 0]))).toThrow('Unsupported DNS label');
    const long = Array.from({ length: 5 }, () => 'a'.repeat(63)).join('.');
    expect(() => decode(bare(question(long)))).toThrow('DNS name too long');
    // Exactly 255 bytes (three labels of 63 and one of 62, each with its length byte) is still a name.
    const fits = ['a'.repeat(63), 'a'.repeat(63), 'a'.repeat(63), 'a'.repeat(62)].join('.');
    expect(decode(bare(question(fits)), fits).answers).toEqual([]);
  });

  it('refuses records whose header or data run past the reply', () => {
    const answer = rr([0xc0, 12], 16, txt('hello'));
    expect(() => decode(message([answer.slice(0, 8)]))).toThrow('DNS record out of bounds');
    expect(() => decode(message([answer.slice(0, -1)]))).toThrow('DNS record out of bounds');
  });

  it('refuses a label that is not UTF-8 rather than guessing', () => {
    expect(() => decode(message([rr([3, 0xff, 0xfe, 0xfd, 0], 16, txt('x'))]))).toThrow();
  });

  it('never throws anything but an Error on arbitrary bytes after a valid question', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 200 }), fc.integer({ min: 0, max: 80 }), (noise, count) => {
      const data = Uint8Array.from([...header(0x8180, 1, count), ...question(), ...noise]);
      try {
        const r = decode(data);
        expect(r.answers.length).toBeLessThanOrEqual(Math.min(count, 64));
        for (const a of r.answers) expect(a.type).toBe(16);
      } catch (e) { expect(e).toBeInstanceOf(Error); }
    }), { numRuns: 300 });
  });
});

describe('DNS queries and TXT data', () => {
  it('encodes each type, and refuses empty or over-long labels', () => {
    for (const [type, code] of [['A', 1], ['CNAME', 5], ['TXT', 16], ['AAAA', 28]] as const)
      expect([...encodeDnsQuery('example.com.', type).slice(-4)]).toEqual([0, code, 0, 1]);
    expect(encodeDnsQuery(`${'a'.repeat(63)}.com`, 'TXT')[12]).toBe(63);
    expect(() => encodeDnsQuery(`${'a'.repeat(64)}.com`, 'TXT')).toThrow('Invalid DNS name');
    expect(() => encodeDnsQuery('a..com', 'TXT')).toThrow('Invalid DNS name');
    expect(() => encodeDnsQuery('', 'TXT')).toThrow('Invalid DNS name');
  });

  it('joins character-strings, empty ones included, and refuses one that runs past the data', () => {
    expect(txtValue(new Uint8Array())).toBe('');
    expect(txtValue(Uint8Array.of(0, 2, 0x68, 0x69, 0, 1, 0x21))).toBe('hi!');
    expect(() => txtValue(Uint8Array.of(3, 0x61, 0x62))).toThrow('DNS text out of bounds');
    expect(() => txtValue(Uint8Array.of(2, 0xc3, 0x28))).toThrow();
  });
});

describe('records', () => {
  it('refuses to write an invalid TXT record or file', () => {
    expect(() => domainTxtRecord({ ...mine, key: 'nope' })).toThrow('Invalid domain record');
    expect(() => domainTxtRecord(null as unknown as DomainRecord)).toThrow('Invalid domain record');
    expect(() => domainWellKnownFile([])).toThrow('Invalid domain records');
    expect(() => domainWellKnownFile(Array.from({ length: 9 }, record))).toThrow('Invalid domain records');
    expect(() => domainWellKnownFile([mine, { ...mine, proof: 'x' }])).toThrow('Invalid domain records');
    expect(recordsFromWellKnown(domainWellKnownFile(Array.from({ length: 8 }, record)))).toHaveLength(8);
  });

  it('bounds a TXT string in bytes: 1024 read, one more ignored', () => {
    const base = `${domainTxtRecord(mine)}; pad=`;
    const at = base + 'x'.repeat(DOMAIN_TXT_MAX_BYTES - base.length);
    expect(parseDomainTxt(at)).toEqual(mine);
    expect(parseDomainTxt(`${at}x`)).toBeUndefined();
    // Multi-byte characters count as bytes, not characters.
    expect(parseDomainTxt(base + '\u00e9'.repeat((DOMAIN_TXT_MAX_BYTES - base.length) / 2 + 1))).toBeUndefined();
    expect(parseDomainTxt(42 as unknown as string)).toBeUndefined();
    expect(parseDomainTxt(`=x; ${domainTxtRecord(mine)}`)).toBeUndefined();
  });

  it('looks at the first 32 TXT strings and the first 32 file entries only', () => {
    const noise = Array.from({ length: 32 }, () => 'v=spf1 -all');
    expect(recordsFromTxt([...noise, domainTxtRecord(mine)])).toEqual([]);
    expect(recordsFromTxt([...noise.slice(1), domainTxtRecord(mine)])).toEqual([mine]);
    const entries = [...Array.from({ length: 32 }, () => ({ key: 'x', proof: 'y' })), mine];
    expect(recordsFromWellKnown(JSON.stringify({ ghostly: 1, proofs: entries }))).toEqual([]);
    expect(recordsFromWellKnown(JSON.stringify({ ghostly: 1, proofs: [mine, mine, { ...mine }] }))).toEqual([mine]);
  });

  it('bounds a domain file in bytes', () => {
    const file = (pad: string) => JSON.stringify({ ghostly: 1, proofs: [mine], pad });
    const fixed = file('').length;
    expect(recordsFromWellKnown(file('x'.repeat(DOMAIN_FILE_MAX_BYTES - fixed)))).toEqual([mine]);
    expect(() => recordsFromWellKnown(file('x'.repeat(DOMAIN_FILE_MAX_BYTES - fixed + 1)))).toThrow('File too large');
    expect(() => nip05RootKey(JSON.stringify({ names: { _: 'd'.repeat(64) }, pad: '\u00e9'.repeat(DOMAIN_FILE_MAX_BYTES / 2) }))).toThrow('File too large');
    expect(() => recordsFromWellKnown(null as unknown as string)).toThrow('File too large');
  });

  it('refuses a NIP-05 file without a names map', () => {
    for (const text of ['null', '{}', '{"names":null}', '{"names":"_"}']) expect(() => nip05RootKey(text), text).toThrow('Not a NIP-05 file');
    expect(nip05RootKey('{"names":{"_":5}}')).toBeUndefined();
  });

  it('refuses a domain that is not text', () => {
    expect(() => normalizeDomain(undefined as unknown as string)).toThrow('Enter a domain name, like example.com');
    expect(() => normalizeDomain('x'.repeat(301))).toThrow('Enter a domain name, like example.com');
    expect(() => normalizeDomain('https://')).toThrow();
  });
});

describe('public addresses', () => {
  it('refuses all of 198.18.0.0/15 and nothing either side of it', () => {
    for (const a of [[198, 18, 0, 0], [198, 19, 255, 255]]) expect(isPublicAddress(Uint8Array.from(a))).toBe(false);
    for (const a of [[198, 17, 255, 255], [198, 20, 0, 0]]) expect(isPublicAddress(Uint8Array.from(a))).toBe(true);
  });

  it('refuses the edges of every private IPv4 range, and allows just outside them', () => {
    for (const a of [[10, 255, 255, 255], [100, 127, 255, 255], [169, 254, 0, 0], [172, 31, 0, 0], [192, 168, 255, 255], [192, 0, 0, 255], [224, 0, 0, 0], [127, 255, 255, 255], [0, 1, 2, 3]])
      expect(isPublicAddress(Uint8Array.from(a)), a.join('.')).toBe(false);
    for (const a of [[11, 0, 0, 0], [100, 63, 255, 255], [169, 253, 0, 0], [172, 15, 255, 255], [192, 169, 0, 0], [192, 0, 1, 0], [223, 255, 255, 255], [126, 255, 255, 255]])
      expect(isPublicAddress(Uint8Array.from(a)), a.join('.')).toBe(true);
  });

  it('decides every IPv4-mapped IPv6 address as its IPv4 address', () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 4, maxLength: 4 }), v4 => {
      const mapped = Uint8Array.from([...new Array(10).fill(0), 0xff, 0xff, ...v4]);
      const nat64 = Uint8Array.from([0, 0x64, 0xff, 0x9b, ...new Array(8).fill(0), ...v4]);
      expect(isPublicAddress(mapped)).toBe(isPublicAddress(v4));
      expect(isPublicAddress(nat64)).toBe(isPublicAddress(v4));
    }), { numRuns: 300 });
  });

  it('allows only global unicast IPv6 outside the embedded forms', () => {
    const embedded = (a: Uint8Array) => a.subarray(0, 10).every(x => x === 0) && a[10] === 0xff && a[11] === 0xff ||
      a[0] === 0 && a[1] === 0x64 && a[2] === 0xff && a[3] === 0x9b && a.subarray(4, 12).every(x => x === 0);
    fc.assert(fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), a => {
      if (isPublicAddress(a) && !embedded(a)) expect(a[0] & 0xe0).toBe(0x20);
    }), { numRuns: 300 });
    for (const length of [0, 3, 5, 15, 17]) expect(isPublicAddress(new Uint8Array(length))).toBe(false);
  });
});
