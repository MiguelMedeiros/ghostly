import { describe, expect, it, vi } from 'vitest';
import { toBase64Url, utf8Encode } from '@ghostly/core';
import { JwksCache, JWKS_MAX_BYTES, REFETCH_INTERVAL_MS } from '../src/proofs/oidc/jwks';
import { OIDC_PROVIDERS, audiences, issuerFor, oidcProvider, oidcProviders, testProvider, type OidcProvider } from '../src/proofs/oidc/providers';
import { verifyIdToken, MAX_ID_TOKEN_LENGTH } from '../src/proofs/oidc/verify';
import { forgeToken, jwksServer, nonceFor, signToken, testKey, type TestKey } from './helpers/oidcIssuer';

// Key generation is CPU-bound; give a loaded machine room.
vi.setConfig({ testTimeout: 60_000 });

const NOW = 1_800_000_000;
const google: OidcProvider = { ...OIDC_PROVIDERS.google, clientIds: { web: 'g-web.apps.googleusercontent.com', extension: 'g-ext.apps.googleusercontent.com' } };
const microsoft: OidcProvider = { ...OIDC_PROVIDERS.microsoft, clientIds: { web: '11111111-2222-3333-4444-555555555555' } };
const apple: OidcProvider = { ...OIDC_PROVIDERS.apple, clientIds: { web: 'tools.ghostly.signin' } };
const TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

/** Two statements that differ only in the contact they are for. */
const statementFor = (audience: string) => JSON.stringify(['ghostly-peer-proof', 1, 'oidc', 'google', 'subject-key', audience, 'context', 'session', 'challenge', NOW, NOW + 600]);

async function setup(provider: OidcProvider = google, alg: 'RS256' | 'ES256' = 'RS256') {
  const key = await testKey('k1', alg);
  let keys = [key.jwk];
  const server = jwksServer(() => keys);
  let clock = NOW * 1000;
  const jwks = new JwksCache({ now: () => clock });
  const nonce = await nonceFor(statementFor('contact-a'));
  const claims = (extra: Record<string, unknown> = {}) => ({
    iss: provider.id === 'microsoft' ? `https://login.microsoftonline.com/${TENANT}/v2.0` : provider.issuer,
    aud: audiences(provider)[0], sub: 'account-123', iat: NOW - 10, exp: NOW + 3590, nonce,
    ...(provider.id === 'microsoft' ? { tid: TENANT } : {}), ...extra,
  });
  const verify = (token: string, options: { nonce?: string; now?: number } = {}) =>
    verifyIdToken(token, { provider, nonce: options.nonce ?? nonce, now: options.now ?? NOW, jwks, fetch: server.fetch });
  return { key, server, jwks, nonce, claims, verify, fetch: server.fetch, setKeys: (k: TestKey[]) => { keys = k.map(x => x.jwk); }, tick: (ms: number) => { clock += ms; } };
}

describe('OIDC ID token verification', () => {
  it('accepts a token the provider signed for this statement and returns only signed claims', async () => {
    const t = await setup();
    const token = await signToken(t.key, t.claims({ email: 'ada@example.com', email_verified: true, name: 'Ada' }));
    await expect(t.verify(token)).resolves.toMatchObject({ provider: 'google', issuer: 'https://accounts.google.com', subject: 'account-123', audience: 'g-web.apps.googleusercontent.com', email: 'ada@example.com', emailVerified: true, name: 'Ada', expiresAt: NOW + 3590 });
    // The contact may run another platform: every Ghostly client ID of the provider is an accepted audience.
    await expect(t.verify(await signToken(t.key, t.claims({ aud: 'g-ext.apps.googleusercontent.com' })))).resolves.toMatchObject({ audience: 'g-ext.apps.googleusercontent.com' });
    // Google documents both spellings of its issuer.
    await expect(t.verify(await signToken(t.key, t.claims({ iss: 'accounts.google.com' })))).resolves.toBeTruthy();
    expect(t.server.requests[0]).toEqual({ url: google.jwksUri, maxBytes: 64 * 1024 });
  });

  it('accepts ES256 where the provider pins it', async () => {
    const t = await setup(testProvider('https://oidc.ghostly.test'), 'ES256');
    await expect(t.verify(await signToken(t.key, t.claims()))).resolves.toMatchObject({ provider: 'test' });
  });

  it('refuses a token issued by someone else, or to another app', async () => {
    const t = await setup();
    await expect(t.verify(await signToken(t.key, t.claims({ iss: 'https://evil.example' })))).rejects.toThrow(/not issued by Google/);
    await expect(t.verify(await signToken(t.key, t.claims({ aud: 'someone-elses-app' })))).rejects.toThrow(/another app/);
    await expect(t.verify(await signToken(t.key, t.claims({ aud: ['g-web.apps.googleusercontent.com', 'other'] })))).rejects.toThrow(/another app/);
    await expect(t.verify(await signToken(t.key, t.claims({ azp: 'other' })))).rejects.toThrow(/another app/);
    await expect(t.verify(await signToken(t.key, t.claims({ aud: ['g-web.apps.googleusercontent.com', 'other'], azp: 'g-web.apps.googleusercontent.com' })))).resolves.toBeTruthy();
  });

  it('refuses every algorithm the provider does not pin: none, HS256 with the public key, ES256 for Google', async () => {
    const t = await setup();
    const claims = t.claims();
    await expect(t.verify(forgeToken({ alg: 'none', typ: 'JWT' }, claims))).rejects.toThrow(/Malformed|Algorithm none/);
    await expect(t.verify(forgeToken({ alg: 'none', typ: 'JWT', kid: 'k1' }, claims, 'AA'))).rejects.toThrow(/Algorithm none/);
    // The classic confusion: the RSA public key used as an HMAC secret.
    const hmacKey = await crypto.subtle.importKey('raw', utf8Encode(t.key.jwk.n!) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const head = toBase64Url(utf8Encode(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'k1' }))), body = toBase64Url(utf8Encode(JSON.stringify(claims)));
    const mac = toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, utf8Encode(`${head}.${body}`) as BufferSource)));
    await expect(t.verify(`${head}.${body}.${mac}`)).rejects.toThrow(/Algorithm HS256 is not accepted/);
    const ec = await testKey('k1', 'ES256');
    await expect(t.verify(await signToken(ec, claims))).rejects.toThrow(/Algorithm ES256 is not accepted for Google/);
    // The token cannot name its own key.
    await expect(t.verify(await signToken(t.key, claims, { jku: 'https://evil.example/jwks' }))).rejects.toThrow(/header refused/);
    await expect(t.verify(await signToken(t.key, claims, { jwk: t.key.jwk }))).rejects.toThrow(/header refused/);
  });

  it('refuses a key whose type or declared algorithm does not match, and short RSA keys', async () => {
    const t = await setup();
    const token = await signToken(t.key, t.claims());
    t.setKeys([{ ...t.key, jwk: { ...t.key.jwk, alg: 'RS512' } }]); t.jwks.clear();
    await expect(t.verify(token)).rejects.toThrow(/another algorithm/);
    t.setKeys([{ ...t.key, jwk: { ...t.key.jwk, use: 'enc' } }]); t.jwks.clear();
    await expect(t.verify(token)).rejects.toThrow(/not a signing key/);
    const weak = await testKey('k1', 'RS256', 1024);
    t.setKeys([weak]); t.jwks.clear();
    await expect(t.verify(await signToken(weak, t.claims()))).rejects.toThrow(/key size/);
  });

  it('refuses an expired token, one from the future and one that claims to live for days, with a minute of tolerance', async () => {
    const t = await setup();
    const token = await signToken(t.key, t.claims());
    await expect(t.verify(token, { now: NOW + 3590 + 60 })).resolves.toBeTruthy();
    await expect(t.verify(token, { now: NOW + 3590 + 61 })).rejects.toThrow(/expired/);
    await expect(t.verify(await signToken(t.key, t.claims({ iat: NOW + 120, exp: NOW + 3600 })))).rejects.toThrow(/not valid yet/);
    await expect(t.verify(await signToken(t.key, t.claims({ nbf: NOW + 120 })))).rejects.toThrow(/not valid yet/);
    await expect(t.verify(await signToken(t.key, t.claims({ exp: NOW + 3 * 86400 })))).rejects.toThrow(/window refused/);
    await expect(t.verify(await signToken(t.key, t.claims({ exp: 'soon' })))).rejects.toThrow(/validity window/);
  });

  it('refuses a token whose nonce is for another statement or another contact', async () => {
    const t = await setup();
    const token = await signToken(t.key, t.claims());
    await expect(t.verify(token, { nonce: await nonceFor(statementFor('contact-b')) })).rejects.toThrow(/another proof request/);
    await expect(t.verify(await signToken(t.key, t.claims({ nonce: undefined })))).rejects.toThrow(/another proof request/);
    expect(t.nonce).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses a tampered payload, a signature from another key and malformed tokens', async () => {
    const t = await setup();
    const token = await signToken(t.key, t.claims());
    const [h, , s] = token.split('.');
    const other = toBase64Url(utf8Encode(JSON.stringify(t.claims({ sub: 'someone-else' }))));
    await expect(t.verify(`${h}.${other}.${s}`)).rejects.toThrow(/Invalid ID token signature/);
    const stranger = await testKey('k1', 'RS256', 2048, 'stranger');
    await expect(t.verify(await signToken(stranger, t.claims()))).rejects.toThrow(/Invalid ID token signature/);
    for (const bad of ['', 'a.b', 'a.b.c.d', `${h}.${other}.${s}=`, `${h}.!!.${s}`, 'x'.repeat(MAX_ID_TOKEN_LENGTH + 1)])
      await expect(t.verify(bad)).rejects.toThrow();
  });

  it('follows a key rotation by refetching once for an unknown kid, and no more than once a minute', async () => {
    const t = await setup();
    await t.verify(await signToken(t.key, t.claims()));
    expect(t.server.requests).toHaveLength(1);
    const rotated = await testKey('k2');
    t.setKeys([rotated]);
    // Fetched less than a minute ago: an unknown kid does not trigger a request.
    await expect(t.verify(await signToken(rotated, t.claims()))).rejects.toThrow(/does not publish the key/);
    expect(t.server.requests).toHaveLength(1);
    t.tick(REFETCH_INTERVAL_MS);
    await expect(t.verify(await signToken(rotated, t.claims()))).resolves.toBeTruthy();
    expect(t.server.requests).toHaveLength(2);
    // A made-up kid right after costs nothing either.
    await expect(t.verify(await signToken(await testKey('made-up', 'RS256', 2048, 'k2'), t.claims()))).rejects.toThrow(/does not publish/);
    expect(t.server.requests).toHaveLength(2);
  });

  it('caches keys for the provider’s max-age, bounded, and refuses oversized, failing or insecure key sets', async () => {
    const key = await testKey('k1');
    const server = jwksServer(() => [key.jwk], { cacheControl: 'public, max-age=18645' });
    let clock = 0;
    const cache = new JwksCache({ now: () => clock });
    const url = 'https://keys.example/jwks';
    await cache.key(url, 'k1', server.fetch);
    clock = 18_000_000; await cache.key(url, 'k1', server.fetch);
    expect(server.requests).toHaveLength(1);
    clock = 18_646_000; await cache.key(url, 'k1', server.fetch);
    expect(server.requests).toHaveLength(2);

    const answer = (status: number, text: string) => async () => ({ status, text });
    await expect(new JwksCache().key(url, 'k1', answer(200, '{"keys":[' + '{"kty":"RSA"},'.repeat(JWKS_MAX_BYTES / 10) + '{"kty":"RSA"}]}'))).rejects.toThrow(/too large/);
    await expect(new JwksCache().key(url, 'k1', answer(200, JSON.stringify({ keys: Array.from({ length: 40 }, () => key.jwk) })))).rejects.toThrow(/Invalid provider key set/);
    await expect(new JwksCache().key(url, 'k1', answer(200, '<html>'))).rejects.toThrow(/Invalid provider key set/);
    await expect(new JwksCache().key(url, 'k1', answer(503, ''))).rejects.toThrow(/unavailable \(503\)/);
    await expect(new JwksCache().key('http://keys.example/jwks', 'k1', server.fetch)).rejects.toThrow(/refused/);
  });

  it('accepts an old token for a proof when it was issued right after the statement, whatever its own expiry', async () => {
    const t = await setup();
    const token = await signToken(t.key, t.claims());
    const later = NOW + 10 * 86400;
    const within = (from: number, to: number) => verifyIdToken(token, { provider: google, nonce: t.nonce, now: later, jwks: t.jwks, fetch: t.fetch, issuedWithin: [from, to] });
    await expect(within(NOW - 300, NOW + 900)).resolves.toMatchObject({ subject: 'account-123' });
    await expect(within(NOW + 60, NOW + 900)).rejects.toThrow(/another time/);
    await expect(within(NOW - 3600, NOW - 600)).rejects.toThrow(/another time/);
    // Without a window, it is an ordinary sign-in and must be unexpired.
    await expect(t.verify(token, { now: later })).rejects.toThrow(/expired/);
  });

  it('checks Microsoft’s issuer against the tenant the token names', async () => {
    const t = await setup(microsoft);
    await expect(t.verify(await signToken(t.key, t.claims()))).resolves.toMatchObject({ provider: 'microsoft', tenant: TENANT, issuer: `https://login.microsoftonline.com/${TENANT}/v2.0` });
    const otherTenant = '72f988bf-86f1-41af-91ab-2d7cd011db47';
    await expect(t.verify(await signToken(t.key, t.claims({ tid: otherTenant })))).rejects.toThrow(/not issued by Microsoft/);
    await expect(t.verify(await signToken(t.key, t.claims({ iss: 'https://login.microsoftonline.com/{tenantid}/v2.0' })))).rejects.toThrow(/not issued by Microsoft/);
    await expect(t.verify(await signToken(t.key, t.claims({ tid: '../evil' })))).rejects.toThrow(/not issued by Microsoft/);
    expect(issuerFor(microsoft, {})).toEqual([]);
    // A key Microsoft publishes for one issuer does not sign for another.
    t.setKeys([{ ...t.key, jwk: { ...t.key.jwk, issuer: 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0' } }]); t.jwks.clear();
    await expect(t.verify(await signToken(t.key, t.claims()))).rejects.toThrow(/another issuer/);
    t.setKeys([{ ...t.key, jwk: { ...t.key.jwk, issuer: microsoft.issuer } }]); t.jwks.clear();
    await expect(t.verify(await signToken(t.key, t.claims()))).resolves.toBeTruthy();
  });

  it('reads Apple’s string booleans', async () => {
    const t = await setup(apple);
    await expect(t.verify(await signToken(t.key, t.claims({ email: 'x@privaterelay.appleid.com', email_verified: 'true' })))).resolves.toMatchObject({ provider: 'apple', emailVerified: true });
  });

  it('refuses every token for a provider this build has no client ID for', async () => {
    const t = await setup({ ...google, clientIds: { web: 'g-web.apps.googleusercontent.com' } });
    const unconfigured = { ...google, clientIds: {} };
    await expect(verifyIdToken(await signToken(t.key, t.claims()), { provider: unconfigured, nonce: t.nonce, now: NOW, jwks: t.jwks, fetch: t.fetch })).rejects.toThrow(/not configured/);
  });
});

describe('OIDC providers', () => {
  it('lists only providers with signed ID tokens reachable without a secret, and the test issuer only when a test build names one', () => {
    expect(oidcProviders(undefined).map(p => p.id)).toEqual(['google', 'microsoft', 'apple', 'gitlab', 'twitch']);
    expect(oidcProviders('https://oidc.ghostly.test').map(p => p.id)).toContain('test');
    expect(() => testProvider('http://127.0.0.1:45210')).toThrow(/\.test host/);
    expect(() => testProvider('https://accounts.google.com')).toThrow(/\.test host/);
    expect(oidcProvider('test', undefined)).toBeUndefined();
    for (const p of oidcProviders(undefined)) {
      expect(p.algs).toEqual(['RS256']);
      expect(p.jwksUri).toMatch(/^https:\/\//);
    }
  });
});
