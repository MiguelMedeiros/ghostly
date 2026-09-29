import { describe, expect, it, vi } from 'vitest';
import { toBase64Url, utf8Encode } from '@ghostly/core';
import { OIDC_PROVIDERS, testProvider, type OidcProvider } from '../src/proofs/oidc/providers';
import { authorizationRequest, callbackParams, completeSignIn, scopeFor, signInForProof, type OidcWindow } from '../src/proofs/oidc/flow';
import { routeCallback } from '../src/proofs/oidc/popup';
import { signToken, testKey } from './helpers/oidcIssuer';
// covers: proofs.oidc, proofs.oidc.nonce, proofs.oidc.callback.web, proofs.oidc.callback.desktop

// Key generation is CPU-bound; give a loaded machine room.
vi.setConfig({ testTimeout: 60_000 });

const configured = (p: OidcProvider): OidcProvider => ({ ...p, clientIds: { web: `${p.id}-web`, extension: `${p.id}-ext` } });
const google = configured(OIDC_PROVIDERS.google), gitlab = configured(OIDC_PROVIDERS.gitlab), twitch = configured(OIDC_PROVIDERS.twitch), apple = configured(OIDC_PROVIDERS.apple);
const REDIRECT = 'https://app.ghostly.tools/oidc-callback.html';
const NONCE = 'a'.repeat(64);

describe('OIDC authorization request', () => {
  it('asks for an ID token only, with the statement hash as nonce and the smallest scope', async () => {
    const r = await authorizationRequest({ provider: google, platform: 'web', nonce: NONCE, reveal: [], redirectUri: REDIRECT });
    const url = new URL(r.url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'google-web', redirect_uri: REDIRECT, response_type: 'id_token', scope: 'openid',
      nonce: NONCE, state: r.state, prompt: 'select_account',
    });
    expect(r.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.verifier).toBeUndefined();
    expect(new URL((await authorizationRequest({ provider: google, platform: 'extension', nonce: NONCE, reveal: ['email', 'profile'], redirectUri: REDIRECT })).url).searchParams.get('scope')).toBe('openid email profile');
  });

  it('uses each provider’s own shape: PKCE for GitLab, a claims request for Twitch, no scope for Apple', async () => {
    const g = await authorizationRequest({ provider: gitlab, platform: 'web', nonce: NONCE, reveal: ['email'], redirectUri: REDIRECT });
    const gp = new URL(g.url).searchParams;
    expect(gp.get('response_type')).toBe('code');
    expect(gp.get('code_challenge_method')).toBe('S256');
    expect(gp.get('code_challenge')).toBe(toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8Encode(g.verifier!)))));
    expect(gp.get('scope')).toBe('openid email');
    expect(scopeFor(twitch, ['email', 'profile'])).toEqual({ scope: 'openid', claims: '{"id_token":{"preferred_username":null}}' });
    const a = new URL((await authorizationRequest({ provider: apple, platform: 'web', nonce: NONCE, reveal: ['email'], redirectUri: REDIRECT })).url).searchParams;
    expect(a.get('scope')).toBeNull();
    expect(a.get('response_type')).toBe('code id_token');
    expect(a.get('response_mode')).toBe('fragment');
  });

  it('carries the desktop listener’s port in the state, and refuses an unconfigured provider', async () => {
    const r = await authorizationRequest({ provider: google, platform: 'desktop', nonce: NONCE, reveal: [], redirectUri: REDIRECT, statePrefix: 'd.50123.' });
    expect(r.state).toMatch(/^d\.50123\.[A-Za-z0-9_-]{43}$/);
    expect(r.clientId).toBe('google-web');
    await expect(authorizationRequest({ provider: OIDC_PROVIDERS.google, platform: 'web', nonce: NONCE, reveal: [], redirectUri: REDIRECT })).rejects.toThrow(/not set up/);
  });
});

async function signedAnswer(provider: OidcProvider, extra: Record<string, unknown> = {}) {
  const key = await testKey('k1');
  const request = await authorizationRequest({ provider, platform: 'web', nonce: NONCE, reveal: ['email'], redirectUri: REDIRECT });
  const now = Math.floor(Date.now() / 1000);
  const idToken = await signToken(key, { iss: provider.issuer, aud: `${provider.id}-web`, sub: 'acct', iat: now, exp: now + 3600, nonce: request.nonce, email: 'ada@example.com', ...extra });
  return { key, request, idToken };
}

describe('OIDC sign-in answer', () => {
  it('returns the ID token for this request', async () => {
    const { request, idToken } = await signedAnswer(google);
    await expect(completeSignIn(google, request, `${REDIRECT}#id_token=${idToken}&state=${request.state}`)).resolves.toBe(idToken);
  });

  it('refuses an answer for another request, another address, a provider error or a token for another nonce or issuer', async () => {
    const { request, idToken, key } = await signedAnswer(google);
    await expect(completeSignIn(google, request, `${REDIRECT}#id_token=${idToken}&state=${'x'.repeat(43)}`)).rejects.toThrow(/does not belong/);
    await expect(completeSignIn(google, request, `https://evil.example/oidc-callback.html#id_token=${idToken}&state=${request.state}`)).rejects.toThrow(/unexpected address/);
    await expect(completeSignIn(google, request, `${REDIRECT}#error=access_denied&state=${request.state}`)).rejects.toThrow(/cancelled/);
    await expect(completeSignIn(google, request, `${REDIRECT}#state=${request.state}`)).rejects.toThrow(/did not return an ID token/);
    const now = Math.floor(Date.now() / 1000);
    const other = await signToken(key, { iss: google.issuer, aud: 'google-web', sub: 'acct', iat: now, exp: now + 3600, nonce: 'b'.repeat(64) });
    await expect(completeSignIn(google, request, `${REDIRECT}#id_token=${other}&state=${request.state}`)).rejects.toThrow(/another sign-in request/);
    const elsewhere = await signToken(key, { iss: 'https://evil.example', aud: 'google-web', sub: 'acct', iat: now, exp: now + 3600, nonce: NONCE });
    await expect(completeSignIn(google, request, `${REDIRECT}#id_token=${elsewhere}&state=${request.state}`)).rejects.toThrow(/another sign-in request/);
  });

  it('exchanges GitLab’s code with PKCE and no secret, keeps only the ID token and revokes the rest', async () => {
    const { request, idToken } = await signedAnswer(gitlab);
    const calls: { url: string; body: URLSearchParams }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: new URLSearchParams(String(init?.body)) });
      return String(url).endsWith('/token')
        ? new Response(JSON.stringify({ id_token: idToken, access_token: 'AT-secret', refresh_token: 'RT-secret', token_type: 'Bearer' }), { headers: { 'content-type': 'application/json' } })
        : new Response('{}');
    }) as unknown as typeof globalThis.fetch;
    const result = await completeSignIn(gitlab, request, `${REDIRECT}?code=the-code&state=${request.state}`, { fetch });
    expect(result).toBe(idToken);
    const exchange = calls.find(c => c.url === 'https://gitlab.com/oauth/token')!;
    expect(Object.fromEntries(exchange.body)).toEqual({ grant_type: 'authorization_code', code: 'the-code', redirect_uri: REDIRECT, client_id: 'gitlab-web', code_verifier: request.verifier });
    expect(exchange.body.has('client_secret')).toBe(false);
    expect(calls.filter(c => c.url === 'https://gitlab.com/oauth/revoke').map(c => c.body.get('token')).sort()).toEqual(['AT-secret', 'RT-secret']);
  });

  it('reads the fragment and the query, and accepts only the registered redirect', () => {
    expect(Object.fromEntries(callbackParams(`${REDIRECT}?code=c#state=s`, REDIRECT))).toEqual({ state: 's', code: 'c' });
    expect(() => callbackParams('https://app.ghostly.tools/other#state=s', REDIRECT)).toThrow();
  });

  it('runs a whole sign-in through a platform window and always releases it', async () => {
    const provider = testProvider('https://oidc.ghostly.test');
    const key = await testKey('k1', 'ES256');
    const close = vi.fn();
    const window: OidcWindow = {
      redirectUri: 'http://localhost:45201/oidc-callback.html', close,
      async authorize(url) {
        const u = new URL(url), now = Math.floor(Date.now() / 1000);
        const token = await signToken(key, { iss: provider.issuer, aud: 'ghostly-e2e', sub: 'alice', iat: now, exp: now + 600, nonce: u.searchParams.get('nonce') });
        return `${u.searchParams.get('redirect_uri')}#id_token=${token}&state=${u.searchParams.get('state')}`;
      },
    };
    const token = await signInForProof({ provider, platform: 'web', nonce: NONCE, reveal: [], window, signal: new AbortController().signal });
    expect(token.split('.')).toHaveLength(3);
    expect(close).toHaveBeenCalledOnce();
    const aborted = new AbortController(); aborted.abort();
    await expect(signInForProof({ provider, platform: 'web', nonce: NONCE, reveal: [], window, signal: aborted.signal })).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe('OIDC callback page', () => {
  const state = 'A'.repeat(43);
  it('hands a web answer to the tab and forwards a desktop answer to its loopback port only', () => {
    expect(routeCallback(`https://app.ghostly.tools/oidc-callback.html#id_token=t&state=${state}`)).toEqual({ kind: 'tab', url: `https://app.ghostly.tools/oidc-callback.html#id_token=t&state=${state}` });
    expect(routeCallback(`https://app.ghostly.tools/oidc-callback.html?code=c&state=d.50123.${state}`)).toEqual({ kind: 'desktop', target: `http://127.0.0.1:50123/oidc-callback?code=c&state=d.50123.${state}` });
    expect(routeCallback(`https://app.ghostly.tools/oidc-callback.html#state=d.80.${state}`)).toEqual({ kind: 'none' });
    expect(routeCallback(`https://app.ghostly.tools/oidc-callback.html#state=d.99999.${state}`)).toEqual({ kind: 'none' });
    expect(routeCallback('https://app.ghostly.tools/oidc-callback.html')).toEqual({ kind: 'none' });
    // A crafted state cannot point the forward anywhere but 127.0.0.1.
    expect(routeCallback(`https://app.ghostly.tools/oidc-callback.html#state=d.evil.example.${state}`)).toMatchObject({ kind: 'tab' });
  });
});
