import { toBase64Url, utf8Encode } from '@ghostly/core';
import type { Jwk, JwksFetch } from '../../src/proofs/oidc/jwks';

/** A provider in memory: real keys, real signatures, a JWKS it can rotate. */
export interface TestKey { kid: string; alg: 'RS256' | 'ES256'; privateKey: CryptoKey; jwk: Jwk }

const enc = (value: unknown) => toBase64Url(utf8Encode(JSON.stringify(value)));

/** RSA generation is slow on a busy machine: one pair per (name, alg, size) for the whole run. */
const pairs = new Map<string, Promise<CryptoKeyPair>>();

/** `pair` names the key material; two calls with the same pair name share it, whatever their `kid`. */
export async function testKey(kid: string, alg: 'RS256' | 'ES256' = 'RS256', modulusLength = 2048, pair = kid): Promise<TestKey> {
  const id = `${pair}/${alg}/${modulusLength}`;
  if (!pairs.has(id)) pairs.set(id, alg === 'RS256'
    ? crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>
    : crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>);
  const keys = await pairs.get(id)!;
  const exported = await crypto.subtle.exportKey('jwk', keys.publicKey) as JsonWebKey;
  const jwk: Jwk = alg === 'RS256'
    ? { kty: 'RSA', kid, use: 'sig', alg, n: exported.n, e: exported.e }
    : { kty: 'EC', kid, use: 'sig', alg, crv: 'P-256', x: exported.x, y: exported.y };
  return { kid, alg, privateKey: keys.privateKey, jwk };
}

export async function signToken(key: TestKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const head = enc({ alg: key.alg, typ: 'JWT', kid: key.kid, ...header });
  const body = enc(claims);
  const input = utf8Encode(`${head}.${body}`);
  const signature = key.alg === 'RS256'
    ? await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, input as BufferSource)
    : await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, input as BufferSource);
  return `${head}.${body}.${toBase64Url(new Uint8Array(signature))}`;
}

/** An unsigned token (`alg: none`) or one "signed" with arbitrary bytes. */
export function forgeToken(header: Record<string, unknown>, claims: Record<string, unknown>, signature = ''): string {
  return `${enc(header)}.${enc(claims)}.${signature}`;
}

/** An identity proof's nonce is its statement id: SHA-256 of the statement, hex. */
export async function nonceFor(statement: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8Encode(statement) as BufferSource)), b => b.toString(16).padStart(2, '0')).join('');
}

/** A JWKS fetcher (the shape `ctx.fetch` is adapted to) serving `keys()`, counting requests. */
export function jwksServer(keys: () => Jwk[], init: { cacheControl?: string; status?: number } = {}) {
  const requests: { url: string; maxBytes: number }[] = [];
  const fetch: JwksFetch = async (url, { maxBytes }) => {
    requests.push({ url, maxBytes });
    return { status: init.status ?? 200, text: JSON.stringify({ keys: keys() }), cacheControl: init.cacheControl };
  };
  return { fetch, requests };
}
