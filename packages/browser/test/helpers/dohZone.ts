/**
 * A tiny authoritative-looking DNS-over-HTTPS responder for tests: it answers
 * RFC 8484 wire-format queries from an in-memory zone. Used by the unit tests
 * through a fake `fetch` and by the e2e suite's local DoH server, so both speak
 * exactly the bytes a public resolver would.
 */
export interface Zone {
  txt?: Record<string, string[]>;
  a?: Record<string, string[]>;
  aaaa?: Record<string, Uint8Array[]>;
  ttl?: number;
  /** Set the AD bit, as a validating resolver does for a signed zone. */
  dnssec?: boolean;
}

const TYPES: Record<number, 'txt' | 'a' | 'aaaa'> = { 16: 'txt', 1: 'a', 28: 'aaaa' };

function readQuestion(query: Uint8Array): { name: string; type: number; end: number } {
  const labels: string[] = [];
  let pos = 12;
  while (query[pos]) { labels.push(new TextDecoder().decode(query.subarray(pos + 1, pos + 1 + query[pos]))); pos += 1 + query[pos]; }
  pos += 1;
  return { name: labels.join('.').toLowerCase(), type: (query[pos] << 8) | query[pos + 1], end: pos + 4 };
}

function rdataOf(kind: 'txt' | 'a' | 'aaaa', value: string | Uint8Array): number[] {
  if (kind === 'a') return (value as string).split('.').map(Number);
  if (kind === 'aaaa') return [...(value as Uint8Array)];
  const bytes = [...new TextEncoder().encode(value as string)], out: number[] = [];
  for (let i = 0; i < bytes.length || i === 0; i += 255) { const chunk = bytes.slice(i, i + 255); out.push(chunk.length, ...chunk); }
  return out;
}

export function answerDoh(query: Uint8Array, zone: Zone): Uint8Array {
  const q = readQuestion(query), kind = TYPES[q.type], ttl = zone.ttl ?? 60;
  const exists = ['txt', 'a', 'aaaa'].some(k => zone[k as 'txt']?.[q.name]);
  const values: (string | Uint8Array)[] = (kind && zone[kind]?.[q.name]) || [];
  const answers: number[] = [];
  for (const value of values) {
    const rdata = rdataOf(kind, value);
    // Owner name as a pointer to the question name at offset 12.
    answers.push(0xc0, 12, 0, q.type, 0, 1, ttl >>> 24, (ttl >> 16) & 0xff, (ttl >> 8) & 0xff, ttl & 0xff, rdata.length >> 8, rdata.length & 0xff, ...rdata);
  }
  const out = new Uint8Array(q.end + answers.length);
  out.set(query.subarray(0, q.end));
  const flags = 0x8180 | (zone.dnssec ? 0x20 : 0) | (exists ? 0 : 3);
  out[2] = flags >> 8; out[3] = flags & 0xff;
  out[6] = values.length >> 8; out[7] = values.length & 0xff;
  out.set(answers, q.end);
  return out;
}

export function queryFromUrl(url: string): Uint8Array {
  const b64 = new URL(url).searchParams.get('dns') ?? '';
  return Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - b64.length % 4) % 4)), c => c.charCodeAt(0));
}
