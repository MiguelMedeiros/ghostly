import { concatBytes, fromZ32, toZ32, utf8Decode, utf8Encode } from './bytes';

/**
 * Domain identity proofs (draft WISP 3xx, docs/wisps/3xx-domain.md), the pure half.
 *
 * Under WISP 300 a proof authorizes a fresh Ed25519 *proof key* that only this
 * profile holds, through a statement the external identity vouches for. A
 * domain vouches by publishing: a DNS TXT record at `_ghostly.<domain>` or a
 * `/.well-known/ghostly.json` file names the proof key **and the statement id**
 * (SHA-256 of the statement), so the record commits to the exact binding —
 * subject, key, dates and nonce — not just to a key. Sharing with a contact is
 * then the contract's per-contact presentation, signed by the proof key.
 *
 * People who already run NIP-05 can use `/.well-known/nostr.json` instead: its
 * root name `_` must be the very Nostr key that signed the statement.
 *
 * The record names no participation key and no contact. Fetching, DNS over
 * HTTPS and caching live in `@ghostly/browser/proofs/domain`.
 */

export type DomainMethod = 'dns' | 'https' | 'nip05';
/** What a record says: this Ghostly proof key, for this statement. */
export interface DomainRecord { key: string; proof: string }

export const DOMAIN_METHODS: readonly DomainMethod[] = ['dns', 'https', 'nip05'];
export const DNS_LABEL = '_ghostly';
export const WELL_KNOWN_PATH = '/.well-known/ghostly.json';
export const NIP05_PATH = '/.well-known/nostr.json?name=_';
/** Everything read from a domain is bounded; these match the fetch limits. */
export const DOMAIN_FILE_MAX_BYTES = 16 * 1024;
export const DOMAIN_TXT_MAX_BYTES = 1024;
export const DOMAIN_MAX_RECORDS = 8;

const z32 = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;
const hex64 = /^[a-f0-9]{64}$/;

// ---------------------------------------------------------------------------
// Domain names

/** Names that never resolve publicly (RFC 6761, 6762, 7686, 8375, 9476) or that
 * only ever mean a private network. A proof for them could only point inward. */
const SPECIAL_USE = ['localhost', 'local', 'internal', 'lan', 'home', 'corp', 'intranet', 'private',
  'test', 'example', 'invalid', 'onion', 'alt', 'arpa'];

/**
 * Normalizes what a person typed ("Example.COM.", "https://example.com/") into
 * a lowercase ASCII host name, or throws with a message fit for the UI.
 * Internationalized names become punycode (xn--), the form DNS carries.
 */
export function normalizeDomain(input: string): string {
  if (typeof input !== 'string') throw new Error('Enter a domain name, like example.com');
  let value = input.trim();
  if (!value || value.length > 300) throw new Error('Enter a domain name, like example.com');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('Enter a domain name, like example.com'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
      throw new Error('Enter only the domain name, without a path or port');
    value = url.hostname;
  } else {
    if (/[/:@?#\s\\]/.test(value)) throw new Error('Enter only the domain name, without a path or port');
    try { value = new URL(`https://${value}`).hostname; } catch { throw new Error('That is not a valid domain name'); }
  }
  value = value.toLowerCase().replace(/\.$/, '');
  if (value.length > 253 - DNS_LABEL.length - 1) throw new Error('That domain name is too long');
  const labels = value.split('.');
  if (labels.length < 2) throw new Error('Use a full domain name, like example.com');
  for (const label of labels) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) throw new Error('That is not a valid domain name');
  }
  const tld = labels[labels.length - 1];
  if (/^[0-9]+$/.test(tld) || /^\[/.test(value)) throw new Error('Use a domain name, not an IP address');
  if (SPECIAL_USE.includes(tld) || (labels.length >= 2 && labels.slice(-2).join('.') === 'home.arpa'))
    throw new Error('That name only works on private networks');
  return value;
}

export const dnsProofName = (domain: string) => `${DNS_LABEL}.${normalizeDomain(domain)}`;
export const wellKnownUrl = (domain: string, method: 'https' | 'nip05' = 'https') =>
  `https://${normalizeDomain(domain)}${method === 'nip05' ? NIP05_PATH : WELL_KNOWN_PATH}`;

// ---------------------------------------------------------------------------
// Records

export function validDomainRecord(r: DomainRecord): boolean {
  if (!r || typeof r.key !== 'string' || typeof r.proof !== 'string' || !z32.test(r.key) || !hex64.test(r.proof)) return false;
  try { return toZ32(fromZ32(r.key)) === r.key; } catch { return false; }
}

/** The TXT record value, in the `tag=value; …` style people know from DKIM. */
export function domainTxtRecord(r: DomainRecord): string {
  if (!validDomainRecord(r)) throw new Error('Invalid domain record');
  return `v=ghostly1; key=${r.key}; proof=${r.proof}`;
}

/** Parses one TXT string. Undefined for anything that is not ours or not exactly
 * well-formed; unknown extra tags are ignored for forward compatibility. */
export function parseDomainTxt(value: string): DomainRecord | undefined {
  if (typeof value !== 'string' || utf8Encode(value).length > DOMAIN_TXT_MAX_BYTES) return;
  const tags = new Map<string, string>();
  const parts = value.split(';').map(p => p.trim()).filter(Boolean);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 1) return;
    const name = part.slice(0, eq).trim().toLowerCase();
    if (tags.has(name)) return;
    tags.set(name, part.slice(eq + 1).trim());
  }
  if (!parts[0]?.toLowerCase().startsWith('v=') || tags.get('v') !== 'ghostly1') return;
  const r = { key: tags.get('key'), proof: tags.get('proof') } as DomainRecord;
  return validDomainRecord(r) ? r : undefined;
}

const addRecord = (list: DomainRecord[], r: DomainRecord) => {
  if (!list.some(x => x.key === r.key && x.proof === r.proof)) list.push(r);
};

/** All records among the TXT strings of `_ghostly.<domain>`; other strings are skipped. */
export function recordsFromTxt(values: string[]): DomainRecord[] {
  const out: DomainRecord[] = [];
  for (const value of values.slice(0, 32)) { const r = parseDomainTxt(value); if (r) addRecord(out, r); }
  return out.slice(0, DOMAIN_MAX_RECORDS);
}

/** The body of `/.well-known/ghostly.json`. */
export function domainWellKnownFile(records: DomainRecord[]): string {
  if (!records.length || records.length > DOMAIN_MAX_RECORDS || !records.every(validDomainRecord)) throw new Error('Invalid domain records');
  return JSON.stringify({ ghostly: 1, proofs: records.map(r => ({ key: r.key, proof: r.proof })) }, null, 2) + '\n';
}

function parseJson(text: string): unknown {
  if (typeof text !== 'string' || utf8Encode(text).length > DOMAIN_FILE_MAX_BYTES) throw new Error('File too large');
  return JSON.parse(text);
}

/** Records from `ghostly.json`. Throws on a malformed file; [] when it names none. */
export function recordsFromWellKnown(text: string): DomainRecord[] {
  const body = parseJson(text) as { ghostly?: unknown; proofs?: unknown };
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.ghostly !== 1 || !Array.isArray(body.proofs))
    throw new Error('Not a Ghostly domain file');
  const out: DomainRecord[] = [];
  for (const entry of body.proofs.slice(0, 32) as { key?: unknown; proof?: unknown }[]) {
    if (!entry || typeof entry !== 'object') continue;
    const r = { key: entry.key, proof: entry.proof } as DomainRecord;
    if (validDomainRecord(r)) addRecord(out, r);
  }
  return out.slice(0, DOMAIN_MAX_RECORDS);
}

/** NIP-05: only the root name `_` speaks for the domain itself. Undefined when absent. */
export function nip05RootKey(text: string): string | undefined {
  const body = parseJson(text) as { names?: unknown };
  if (!body || typeof body !== 'object' || !body.names || typeof body.names !== 'object' || Array.isArray(body.names))
    throw new Error('Not a NIP-05 file');
  const root = (body.names as Record<string, unknown>)['_'];
  return typeof root === 'string' && hex64.test(root) ? root : undefined;
}

export const recordsName = (records: DomainRecord[], r: DomainRecord) => records.some(x => x.key === r.key && x.proof === r.proof);

// ---------------------------------------------------------------------------
// DNS over HTTPS (RFC 8484) wire messages

export const DNS_TYPE = { A: 1, CNAME: 5, TXT: 16, AAAA: 28 } as const;
export type DnsType = keyof typeof DNS_TYPE;
export interface DnsAnswer { name: string; type: number; ttl: number; data: Uint8Array }
export interface DnsResponse {
  /** 0 = NOERROR, 3 = NXDOMAIN; anything else is a failed lookup. */
  rcode: number;
  /** The resolver reports it validated the answer with DNSSEC. */
  authenticated: boolean;
  answers: DnsAnswer[];
}

/** A recursive query for one name and type. ID 0, as RFC 8484 recommends for caching;
 * the AD bit asks the resolver to report DNSSEC validation (RFC 6840 §5.7). */
export function encodeDnsQuery(name: string, type: DnsType): Uint8Array {
  const labels = name.replace(/\.$/, '').split('.');
  const parts: Uint8Array[] = [Uint8Array.of(0, 0, 0x01, 0x20, 0, 1, 0, 0, 0, 0, 0, 0)];
  for (const label of labels) {
    const bytes = utf8Encode(label);
    if (!bytes.length || bytes.length > 63) throw new Error('Invalid DNS name');
    parts.push(Uint8Array.of(bytes.length), bytes);
  }
  const code = DNS_TYPE[type];
  parts.push(Uint8Array.of(0, code >> 8, code & 0xff, 0, 1));
  return concatBytes(...parts);
}

function readName(data: Uint8Array, start: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = start, next = -1, jumps = 0, length = 0;
  for (;;) {
    if (pos >= data.length) throw new Error('DNS name out of bounds');
    const len = data[pos];
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= data.length) throw new Error('DNS pointer out of bounds');
      if (next < 0) next = pos + 2;
      pos = ((len & 0x3f) << 8) | data[pos + 1];
      if (++jumps > 32) throw new Error('DNS name loops');
      continue;
    }
    if (len & 0xc0) throw new Error('Unsupported DNS label');
    pos += 1;
    if (len === 0) break;
    if (pos + len > data.length) throw new Error('DNS label out of bounds');
    length += len + 1;
    if (length > 255) throw new Error('DNS name too long');
    labels.push(utf8Decode(data.subarray(pos, pos + len)).toLowerCase());
    pos += len;
  }
  return { name: labels.join('.'), next: next < 0 ? pos : next };
}

/**
 * Decodes a resolver's answer to `encodeDnsQuery(name, type)`. Refuses a reply
 * to another question or a truncated one, and keeps only records of the asked
 * type owned by the name or by the CNAME chain the answer itself follows.
 */
export function decodeDnsResponse(data: Uint8Array, name: string, type: DnsType): DnsResponse {
  if (data.length < 12) throw new Error('DNS response too short');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const flags = view.getUint16(2);
  if (!(flags & 0x8000) || (flags & 0x7800) || (flags & 0x0200)) throw new Error('Unusable DNS response');
  const questions = view.getUint16(4), count = view.getUint16(6);
  const want = name.replace(/\.$/, '').toLowerCase(), code = DNS_TYPE[type];
  if (questions !== 1) throw new Error('DNS response is for another question');
  const q = readName(data, 12);
  if (q.name !== want || q.next + 4 > data.length || view.getUint16(q.next) !== code) throw new Error('DNS response is for another question');
  let pos = q.next + 4;
  const all: DnsAnswer[] = [];
  for (let i = 0; i < count && i < 64; i++) {
    const owner = readName(data, pos);
    pos = owner.next;
    if (pos + 10 > data.length) throw new Error('DNS record out of bounds');
    const rtype = view.getUint16(pos), ttl = view.getUint32(pos + 4), len = view.getUint16(pos + 8);
    pos += 10;
    if (pos + len > data.length) throw new Error('DNS record out of bounds');
    const rdata = rtype === DNS_TYPE.CNAME ? utf8Encode(readName(data, pos).name) : data.slice(pos, pos + len);
    all.push({ name: owner.name, type: rtype, ttl, data: rdata });
    pos += len;
  }
  const owners = new Set([want]);
  for (let hop = 0; hop < 8; hop++) {
    const cname = all.find(a => a.type === DNS_TYPE.CNAME && owners.has(a.name) && !owners.has(utf8Decode(a.data)));
    if (!cname) break;
    owners.add(utf8Decode(cname.data));
  }
  return { rcode: flags & 0x000f, authenticated: !!(flags & 0x0020), answers: all.filter(a => a.type === code && owners.has(a.name)) };
}

/** The TXT character-strings of one record, joined as RFC 7208 §3.3 does. */
export function txtValue(rdata: Uint8Array): string {
  const parts: Uint8Array[] = [];
  for (let p = 0; p < rdata.length;) {
    const len = rdata[p];
    if (p + 1 + len > rdata.length) throw new Error('DNS text out of bounds');
    parts.push(rdata.subarray(p + 1, p + 1 + len));
    p += 1 + len;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(...parts));
}

// ---------------------------------------------------------------------------
// Addresses: a proof may only make a contact's app fetch from the public Internet

/** False for loopback, private, link-local, shared (CGNAT), multicast, reserved
 * and unspecified addresses, including IPv4 embedded in IPv6. */
export function isPublicAddress(address: Uint8Array): boolean {
  if (address.length === 4) {
    const [a, b, c] = address;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19)));
  }
  if (address.length !== 16) return false;
  const zeroTo = (n: number) => address.subarray(0, n).every(x => x === 0);
  if (zeroTo(15) && (address[15] === 0 || address[15] === 1)) return false; // :: and ::1
  if (zeroTo(10) && address[10] === 0xff && address[11] === 0xff) return isPublicAddress(address.subarray(12)); // ::ffff:a.b.c.d
  if (address[0] === 0x00 && address[1] === 0x64 && address[2] === 0xff && address[3] === 0x9b && address.subarray(4, 12).every(x => x === 0))
    return isPublicAddress(address.subarray(12)); // 64:ff9b::/96 NAT64
  if (zeroTo(12)) return false; // deprecated IPv4-compatible
  if ((address[0] & 0xfe) === 0xfc) return false; // fc00::/7 unique local
  if (address[0] === 0xfe && (address[1] & 0xc0) === 0x80) return false; // fe80::/10 link-local
  if (address[0] === 0xfe && (address[1] & 0xc0) === 0xc0) return false; // fec0::/10 site-local
  if (address[0] === 0xff) return false; // multicast
  if (address[0] === 0x01 && address.subarray(1, 8).every(x => x === 0)) return false; // 100::/64 discard
  return (address[0] & 0xe0) === 0x20; // only 2000::/3 is global unicast
}
