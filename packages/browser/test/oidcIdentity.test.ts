import { describe, expect, it, vi } from 'vitest';
import { identityStatement, newIdentityBinding, type IdentityStatement } from '@ghostly/core';
import type { IdentityFetch, RedirectSigner, SignerContext } from '../src/proofs/contract';
import type { OidcHost } from '../src/host';
import { createOidcIdentityProvider, type OidcEvidence } from '../src/proofs/providers/oidc';
import { IDENTITY_PROVIDERS } from '../src/proofs/registry';
import { JwksCache } from '../src/proofs/oidc/jwks';
import { OIDC_PROVIDERS, testProvider, type OidcProvider } from '../src/proofs/oidc/providers';
import { verifyIdentity } from '../src/proofs/verify';
import { signToken, testKey, type TestKey } from './helpers/oidcIssuer';
import { describeIdentityProof } from './helpers/identityProofContract';

// Key generation is CPU-bound; give a loaded machine room.
vi.setConfig({ testTimeout: 60_000 });

const ISSUER = 'https://oidc.ghostly.test';
const test = testProvider(ISSUER);

/** A provider's network as `ctx.fetch` sees it: its JWKS and nothing else. */
function network(provider: OidcProvider, keys: () => TestKey[]) {
  const requests: string[] = [];
  const fetch: IdentityFetch = async url => {
    requests.push(url);
    if (url !== provider.jwksUri) throw new Error(`Unexpected network access: ${url}`);
    const text = JSON.stringify({ keys: keys().map(k => k.jwk) });
    return { status: 200, contentType: 'application/json', text, bytes: new TextEncoder().encode(text) };
  };
  return { fetch, requests };
}

const token = (key: TestKey, statement: IdentityStatement, claims: Record<string, unknown> = {}, provider = test) =>
  signToken(key, { iss: provider.issuer, aud: provider.clientIds.web, sub: 'alice-0001', iat: statement.binding.issuedAt + 5, exp: statement.binding.issuedAt + 3605, nonce: statement.id, ...claims });

describeIdentityProof('OpenID Connect', async () => {
  const key = await testKey('k1', 'ES256'), impostor = await testKey('k1', 'ES256', 2048, 'impostor');
  const provider = createOidcIdentityProvider({ providers: () => [test], jwks: new JwksCache(), host: () => undefined });
  return {
    provider, subject: ISSUER, fetch: network(test, () => [key]).fetch,
    prove: async s => ({ token: await token(key, s) }),
    // Signed with a key the issuer does not publish under that kid.
    proveAsOther: async s => ({ token: await token(impostor, s) }),
  };
});

function statementFor(subject: string, now = Math.floor(Date.now() / 1000)) {
  return identityStatement(newIdentityBinding({ provider: 'oidc', subject, validitySeconds: 7 * 86400, now }).binding);
}
const ctx = (fetch: IdentityFetch, now = Math.floor(Date.now() / 1000)) => ({ now, signal: new AbortController().signal, fetch });

describe('OpenID Connect identity provider', () => {
  it('is registered, and offers only providers with a client ID', () => {
    expect(IDENTITY_PROVIDERS.map(p => p.id)).toContain('oidc');
    const unconfigured = createOidcIdentityProvider({ providers: () => Object.values(OIDC_PROVIDERS), host: () => undefined });
    expect(unconfigured.subject.options).toEqual([]);
    expect(() => unconfigured.subject.normalize('https://accounts.google.com')).toThrow(/Choose a provider/);
    const google = { ...OIDC_PROVIDERS.google, clientIds: { web: 'g' } };
    const some = createOidcIdentityProvider({ providers: () => [google, OIDC_PROVIDERS.apple], host: () => undefined });
    expect(some.subject.options).toEqual([{ value: 'https://accounts.google.com', label: 'Google' }]);
    expect(some.subject.short!('https://accounts.google.com')).toBe('Google');
    expect(some.category).toBe('provider-attested');
  });

  it('proves the account the provider signed, with who attests it and what the person chose to show', async () => {
    const key = await testKey('k1', 'ES256');
    const provider = createOidcIdentityProvider({ providers: () => [test], jwks: new JwksCache(), host: () => undefined });
    const s = statementFor(ISSUER);
    const net = network(test, () => [key]);
    const verified = await verifyIdentity([provider], s, { token: await token(key, s, { email: 'alice@example.test', email_verified: true, name: 'Alice' }) }, ctx(net.fetch));
    expect(verified).toMatchObject({
      subject: `${ISSUER}#alice-0001`, attester: 'oidc.ghostly.test', source: 'ID token signed by oidc.ghostly.test',
      display: { name: 'Alice · alice@example.test', source: 'Signed by Test issuer; email verified by Test issuer' },
    });
    const bare = await verifyIdentity([provider], s, { token: await token(key, s) }, ctx(net.fetch));
    expect(bare.display).toBeUndefined();
    const unverified = await verifyIdentity([provider], s, { token: await token(key, s, { email: 'a@example.test' }) }, ctx(net.fetch));
    expect(unverified.display?.source).toMatch(/email not verified/);
  });

  it('is checked by a contact days later, but only for a sign-in that followed its statement', async () => {
    const key = await testKey('k1', 'ES256');
    const provider = createOidcIdentityProvider({ providers: () => [test], jwks: new JwksCache(), host: () => undefined });
    const s = statementFor(ISSUER);
    const net = network(test, () => [key]);
    const later = s.binding.issuedAt + 5 * 86400;
    await expect(verifyIdentity([provider], s, { token: await token(key, s) }, ctx(net.fetch, later))).resolves.toBeTruthy();
    // A sign-in from before the statement, or long after it, is not the one the statement asked for.
    await expect(verifyIdentity([provider], s, { token: await token(key, s, { iat: s.binding.issuedAt - 3600, exp: s.binding.issuedAt }) }, ctx(net.fetch, later))).rejects.toThrow(/another time/);
    await expect(verifyIdentity([provider], s, { token: await token(key, s, { iat: s.binding.issuedAt + 3600, exp: s.binding.issuedAt + 7200 }) }, ctx(net.fetch, later))).rejects.toThrow(/another time/);
    // Once the provider stops publishing the key, nobody can check it any more.
    const gone = network(test, () => []);
    const elsewhere = createOidcIdentityProvider({ providers: () => [test], jwks: new JwksCache(), host: () => undefined });
    await expect(verifyIdentity([elsewhere], s, { token: await token(key, s) }, ctx(gone.fetch, later))).rejects.toThrow(/does not publish the key/);
  });

  it('refuses a token from another issuer, or for another subject, and account IDs it cannot show', async () => {
    const key = await testKey('k1', 'ES256');
    const provider = createOidcIdentityProvider({ providers: () => [test, { ...OIDC_PROVIDERS.google, clientIds: { web: 'g' } }], jwks: new JwksCache(), host: () => undefined });
    const s = statementFor(ISSUER);
    const net = network(test, () => [key]);
    await expect(verifyIdentity([provider], s, { token: await token(key, s, { iss: 'https://accounts.google.com' }) }, ctx(net.fetch))).rejects.toThrow(/not issued by Test issuer/);
    await expect(verifyIdentity([provider], statementFor('https://unknown.example'), { token: await token(key, s) }, ctx(net.fetch))).rejects.toThrow(/does not know this provider/);
    await expect(verifyIdentity([provider], s, { token: await token(key, s, { sub: 'has space' }) }, ctx(net.fetch))).rejects.toThrow(/cannot be shown/);
    for (const raw of [{ token: 'a.b' }, { token: 'x'.repeat(7000) }, { token: 'a.b.c', access_token: 'at' }])
      await expect(verifyIdentity([provider], s, raw, ctx(net.fetch))).rejects.toThrow();
  });

  it('names a Microsoft account with its tenant', async () => {
    const key = await testKey('k1');
    const microsoft = { ...OIDC_PROVIDERS.microsoft, clientIds: { web: '11111111-2222-3333-4444-555555555555' } };
    const provider = createOidcIdentityProvider({ providers: () => [microsoft], jwks: new JwksCache(), host: () => undefined });
    const s = statementFor(microsoft.issuer);
    const tid = '9188040d-6c67-4c5b-b112-36a304b66dad';
    const verified = await verifyIdentity([provider], s, { token: await token(key, s, { iss: `https://login.microsoftonline.com/${tid}/v2.0`, tid }, microsoft) }, ctx(network(microsoft, () => [key]).fetch));
    expect(verified).toMatchObject({ subject: `https://login.microsoftonline.com/${tid}/v2.0#alice-0001`, attester: 'login.microsoftonline.com' });
  });

  it('signs in through the platform window with the statement id as nonce, asking only for what the provider can give', async () => {
    const key = await testKey('k1', 'ES256');
    const apple = { ...OIDC_PROVIDERS.apple, clientIds: { web: 'tools.ghostly.signin' } };
    const opened: URL[] = [];
    const close = vi.fn();
    const host: OidcHost = {
      platform: 'web',
      open: vi.fn(async () => ({
        redirectUri: 'https://app.ghostly.tools/oidc-callback.html', close,
        async authorize(url: string) {
          const u = new URL(url); opened.push(u);
          const iss = u.origin === 'https://appleid.apple.com' ? apple.issuer : ISSUER;
          const t = await signToken(key, { iss, aud: u.searchParams.get('client_id'), sub: 'alice', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, nonce: u.searchParams.get('nonce') });
          return `https://app.ghostly.tools/oidc-callback.html#id_token=${t}&state=${u.searchParams.get('state')}`;
        },
      })),
    };
    const provider = createOidcIdentityProvider({ providers: () => [test, apple], jwks: new JwksCache(), host: () => host });
    const signer = (id: string) => provider.signers.find(s => s.id === id) as RedirectSigner<OidcEvidence>;
    const signerCtx: SignerContext = { values: {}, signal: new AbortController().signal, onAuthUrl: vi.fn(), onProgress: vi.fn() };
    expect(provider.signers.map(s => s.id)).toEqual(['oidc-account', 'oidc-email', 'oidc-profile']);
    expect(signer('oidc-email').available!()).toBe(true);

    const s = statementFor(ISSUER);
    const evidence = await signer('oidc-profile').start(s, signerCtx);
    expect(opened[0].searchParams.get('nonce')).toBe(s.id);
    expect(opened[0].searchParams.get('scope')).toBe('openid email profile');
    expect(close).toHaveBeenCalledOnce();
    await expect(verifyIdentity([provider], s, JSON.parse(JSON.stringify(evidence)), ctx(network(test, () => [key]).fetch))).resolves.toMatchObject({ subject: `${ISSUER}#alice` });

    // Apple can only answer without scopes: the email the person asked for is not requested.
    await signer('oidc-email').start(statementFor(apple.issuer), signerCtx);
    expect(opened[1].searchParams.get('scope')).toBeNull();

    // The window opens before anything is awaited (the click's user activation).
    const sync = vi.fn(async () => { throw new Error('closed'); });
    const early = createOidcIdentityProvider({ providers: () => [test], host: () => ({ platform: 'web', open: sync }) });
    const pending = (early.signers[0] as RedirectSigner<OidcEvidence>).start(s, signerCtx);
    expect(sync).toHaveBeenCalledOnce();
    await expect(pending).rejects.toThrow();
  });

  it('is not offered where there is no sign-in window or nothing is configured', () => {
    const none = createOidcIdentityProvider({ providers: () => [test], host: () => undefined });
    expect(none.signers.every(s => !s.available!())).toBe(true);
    const unconfigured = createOidcIdentityProvider({ providers: () => Object.values(OIDC_PROVIDERS), host: () => ({ platform: 'web', open: vi.fn() }) });
    expect(unconfigured.signers.every(s => !s.available!())).toBe(true);
  });
});
