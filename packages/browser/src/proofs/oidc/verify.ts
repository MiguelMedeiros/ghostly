import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from '@ghostly/core';
import { audiences, issuerFor, type OidcAlg, type OidcProvider, type OidcProviderId } from './providers';
import { sharedJwksCache, type Jwk, type JwksCache, type JwksFetch } from './jwks';

/**
 * Checks an ID token the way a contact must: the provider's signature under
 * a key from its own JWKS, the pinned `alg`, the issuer, `aud` = one of
 * Ghostly's client IDs for that provider, the time window, and `nonce` = the
 * hash of the exact Ghostly proof statement. Nothing here talks to a Ghostly
 * server, and nothing here trusts what the token says about its own key.
 */

/** Seconds of clock difference accepted on `iat`, `nbf` and `exp`. */
export const CLOCK_TOLERANCE = 60;
/** An ID token that claims to live longer than a day is not a sign-in result. */
const MAX_LIFETIME = 24 * 60 * 60;
/** Room for Microsoft's larger tokens, well inside a peer frame. */
export const MAX_ID_TOKEN_LENGTH = 6144;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const REFUSED_HEADERS = ['crit', 'jku', 'jwk', 'x5u', 'x5c', 'zip', 'enc'];

export class OidcVerificationError extends Error {
  constructor(message: string) { super(message); this.name = 'OidcVerificationError'; }
}
const refuse = (message: string): never => { throw new OidcVerificationError(message); };

/** What a contact is shown: only claims the provider signed, bounded. */
export interface OidcIdentity {
  provider: OidcProviderId;
  issuer: string;
  subject: string;
  audience: string;
  issuedAt: number;
  expiresAt: number;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  username?: string;
  /** Microsoft's directory (tenant) ID. */
  tenant?: string;
}

function segment(value: string): Uint8Array {
  if (!SEGMENT.test(value)) refuse('Malformed ID token');
  let bytes: Uint8Array;
  try { bytes = fromBase64Url(value); } catch { return refuse('Malformed ID token'); }
  if (toBase64Url(bytes) !== value) refuse('Malformed ID token');
  return bytes;
}

function json(value: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(utf8Decode(segment(value))); } catch (e) { if (e instanceof OidcVerificationError) throw e; return refuse('Malformed ID token'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) refuse('Malformed ID token');
  return parsed as Record<string, unknown>;
}

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;

/** Splits and decodes without verifying anything. Only for display of a token already verified. */
export function decodeIdToken(token: string): { header: Record<string, unknown>; claims: Record<string, unknown>; signature: Uint8Array; signed: Uint8Array } {
  if (typeof token !== 'string' || token.length > MAX_ID_TOKEN_LENGTH) refuse('ID token missing or too large');
  const parts = token.split('.');
  if (parts.length !== 3) refuse('Not a signed ID token');
  return { header: json(parts[0]), claims: json(parts[1]), signature: segment(parts[2]), signed: utf8Encode(`${parts[0]}.${parts[1]}`) };
}

async function verifySignature(alg: OidcAlg, jwk: Jwk, signed: Uint8Array, signature: Uint8Array): Promise<boolean> {
  if (jwk.use !== undefined && jwk.use !== 'sig') refuse('Provider key is not a signing key');
  if (jwk.alg !== undefined && jwk.alg !== alg) refuse('Provider key is for another algorithm');
  if (jwk.key_ops !== undefined && !(Array.isArray(jwk.key_ops) && jwk.key_ops.includes('verify'))) refuse('Provider key is not a signing key');
  let key: CryptoKey;
  if (alg === 'RS256') {
    if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') return refuse('Provider key does not match the token algorithm');
    const modulus = segment(jwk.n);
    const bits = (modulus.length - (modulus[0] === 0 ? 1 : 0)) * 8;
    if (bits < 2048 || bits > 8192) refuse('Provider key size refused');
    key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature as BufferSource, signed as BufferSource);
  }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return refuse('Provider key does not match the token algorithm');
  if (signature.length !== 64) refuse('Invalid ID token signature');
  key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature as BufferSource, signed as BufferSource);
}

/** Whether `iss` is this provider's, as it words it (Microsoft: with the token's own tenant). */
export function issuerMatches(provider: OidcProvider, claims: Record<string, unknown>): boolean {
  const iss = text(claims.iss, 512);
  return !!iss && issuerFor(provider, claims).includes(iss);
}

export interface VerifyOptions {
  provider: OidcProvider;
  /** The nonce the sign-in was asked for: an identity proof's `statement.id`. */
  nonce: string;
  /** How the provider's keys are fetched: `ctx.fetch` in a proof's `verify`. */
  fetch: JwksFetch;
  /** Unix seconds. */
  now?: number;
  jwks?: JwksCache;
  /**
   * `[from, to]` in Unix seconds: the token must have been issued in this window. For a proof, the
   * sign-in that followed the statement; the token's own `exp` (an hour) then does not matter, the
   * statement's validity does. Without it, the token must still be unexpired.
   */
  issuedWithin?: [number, number];
}

export async function verifyIdToken(token: string, options: VerifyOptions): Promise<OidcIdentity> {
  const { provider, nonce } = options;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const { header, claims, signature, signed } = decodeIdToken(token);

  // The algorithm is the provider's, never the token's choice: `none`, HS256
  // (a public key used as an HMAC secret) and anything unpinned stop here.
  const alg = header.alg;
  if (typeof alg !== 'string' || !provider.algs.includes(alg as OidcAlg)) refuse(`Algorithm ${typeof alg === 'string' ? alg : 'missing'} is not accepted for ${provider.name}`);
  if (header.typ !== undefined && (typeof header.typ !== 'string' || header.typ.toUpperCase() !== 'JWT')) refuse('Not an ID token');
  for (const name of REFUSED_HEADERS) if (name in header) refuse('ID token header refused');
  const kid = text(header.kid, 256) ?? refuse('ID token names no provider key');

  if (!issuerMatches(provider, claims)) refuse(`Token was not issued by ${provider.name}`);
  const iss = claims.iss as string;

  const expected = audiences(provider);
  if (!expected.length) refuse(`${provider.name} is not configured in this Ghostly build`);
  const aud = typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) && claims.aud.every(a => typeof a === 'string') ? claims.aud as string[] : [];
  const audience = aud.find(a => expected.includes(a)) ?? refuse('Token was issued to another app');
  if (aud.length > 1 && claims.azp !== audience) refuse('Token was issued to another app');
  if (claims.azp !== undefined && claims.azp !== audience) refuse('Token was issued to another app');

  const iat = claims.iat, exp = claims.exp, nbf = claims.nbf;
  if (typeof iat !== 'number' || typeof exp !== 'number' || !Number.isFinite(iat) || !Number.isFinite(exp)) return refuse('Token has no validity window');
  if (exp <= iat || exp - iat > MAX_LIFETIME) refuse('Token validity window refused');
  if (iat > now + CLOCK_TOLERANCE) refuse('Token is not valid yet');
  if (options.issuedWithin) {
    const [from, to] = options.issuedWithin;
    if (iat < from || iat > to) refuse('The sign-in does not belong to this proof: it happened at another time');
  } else {
    if (typeof nbf === 'number' && nbf > now + CLOCK_TOLERANCE) refuse('Token is not valid yet');
    if (exp + CLOCK_TOLERANCE < now) refuse('Token expired');
  }

  if (typeof claims.nonce !== 'string' || claims.nonce !== nonce) refuse('Token answers another proof request');
  const subject = text(claims.sub, 255) ?? refuse('Token names no account');

  const jwk = await (options.jwks ?? sharedJwksCache).key(provider.jwksUri, kid, options.fetch) ?? refuse(`${provider.name} does not publish the key that signed this token`);
  if (provider.id === 'microsoft' && jwk.issuer !== undefined && jwk.issuer !== provider.issuer && jwk.issuer !== iss) refuse('Provider key belongs to another issuer');
  let valid = false;
  try { valid = await verifySignature(alg as OidcAlg, jwk, signed, signature); }
  catch (e) { if (e instanceof OidcVerificationError) throw e; refuse('Invalid ID token signature'); }
  if (!valid) refuse('Invalid ID token signature');

  const verified = claims.email_verified === true || claims.email_verified === 'true' ? true : claims.email_verified === false || claims.email_verified === 'false' ? false : undefined;
  return {
    provider: provider.id, issuer: iss, subject, audience, issuedAt: Math.floor(iat), expiresAt: Math.floor(exp),
    email: text(claims.email, 320), emailVerified: text(claims.email, 320) ? verified : undefined,
    name: text(claims.name, 200), username: text(claims.preferred_username, 200) ?? text(claims.nickname, 200),
    tenant: provider.id === 'microsoft' ? text(claims.tid, 64) : undefined,
  };
}
