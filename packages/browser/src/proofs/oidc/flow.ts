import { randomBytes, toBase64Url, utf8Encode } from '@ghostly/core';
import { clientIdFor, type OidcPlatform, type OidcProvider, type OidcReveal } from './providers';
import { decodeIdToken, issuerMatches } from './verify';

/**
 * The sign-in half: send the person to the provider with the identity proof's
 * statement id as `nonce`, and take back only the ID token. The token's
 * signature is checked by the proof's `verify`, before saving and on every
 * contact's device; here only that it answers this request. Access and refresh tokens are never requested
 * where the provider allows it, and dropped (and revoked) where it does not.
 */

/** How a platform shows the provider's page and hands back where it redirected. */
export interface OidcWindow {
  /** The redirect URI registered for this platform. */
  redirectUri: string;
  /** Extra state prefix the platform needs to route the answer back (desktop: its loopback port). */
  statePrefix?: string;
  /** Opens `url` and resolves with the full URL the provider redirected to. */
  authorize(url: string, signal: AbortSignal): Promise<string>;
  /** Releases the window or listener, answered or not. */
  close(): void;
}

export interface OidcRequest {
  url: string;
  state: string;
  nonce: string;
  redirectUri: string;
  clientId: string;
  /** PKCE verifier, only for `code`. Held in memory for the one exchange. */
  verifier?: string;
}

const STATE = /^(?:d\.\d{1,5}\.)?[A-Za-z0-9_-]{43}$/;

export function scopeFor(provider: OidcProvider, reveal: OidcReveal[]): { scope: string; claims?: string } {
  const scopes = provider.id === 'apple' ? [] : ['openid'];
  const claims: string[] = [];
  for (const r of reveal) {
    const option = provider.reveal[r];
    if (!option) continue;
    if (option.scope) scopes.push(option.scope);
    if (option.claims) claims.push(...option.claims);
  }
  return { scope: scopes.join(' '), claims: claims.length ? JSON.stringify({ id_token: Object.fromEntries(claims.map(c => [c, null])) }) : undefined };
}

export async function authorizationRequest(options: { provider: OidcProvider; platform: OidcPlatform; nonce: string; reveal: OidcReveal[]; redirectUri: string; statePrefix?: string }): Promise<OidcRequest> {
  const { provider } = options;
  const clientId = clientIdFor(provider, options.platform);
  if (!clientId) throw new Error(`${provider.name} sign-in is not set up in this Ghostly build yet.`);
  const { nonce } = options;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new Error('Invalid sign-in nonce');
  const state = `${options.statePrefix ?? ''}${toBase64Url(randomBytes(32))}`;
  const url = new URL(provider.authorizationEndpoint);
  const { scope, claims } = scopeFor(provider, options.reveal);
  const params: Record<string, string> = {
    client_id: clientId, redirect_uri: options.redirectUri, response_type: provider.responseType,
    nonce, state, ...(scope ? { scope } : {}), ...(claims ? { claims } : {}), ...provider.extraParams,
  };
  let verifier: string | undefined;
  if (provider.responseType === 'code') {
    verifier = toBase64Url(randomBytes(32));
    params.code_challenge = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8Encode(verifier) as BufferSource)));
    params.code_challenge_method = 'S256';
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { url: url.toString(), state, nonce, redirectUri: options.redirectUri, clientId, verifier };
}

/** Parameters from the redirect: the fragment for implicit responses, the query for `code`. */
export function callbackParams(redirected: string, redirectUri: string): URLSearchParams {
  const url = new URL(redirected), expected = new URL(redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) throw new Error('Sign-in returned to an unexpected address.');
  const params = new URLSearchParams(url.hash.slice(1));
  for (const [k, v] of new URLSearchParams(url.search)) if (!params.has(k)) params.set(k, v);
  return params;
}

const PROVIDER_ERRORS: Record<string, string> = {
  access_denied: 'Sign-in was cancelled.',
  login_required: 'Sign in to your account and try again.',
  consent_required: 'Consent was not given.',
  interaction_required: 'The provider needs you to finish signing in.',
  unauthorized_client: 'This provider has not accepted Ghostly’s sign-in yet.',
  invalid_request: 'The provider refused the sign-in request.',
};

async function exchangeCode(provider: OidcProvider, request: OidcRequest, code: string, doFetch: typeof fetch): Promise<string> {
  if (!provider.tokenEndpoint || !request.verifier) throw new Error('This provider cannot finish sign-in here.');
  const response = await doFetch(provider.tokenEndpoint, {
    method: 'POST', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: request.redirectUri, client_id: request.clientId, code_verifier: request.verifier }),
  });
  const body = await response.json().catch(() => ({})) as { id_token?: unknown; access_token?: unknown; refresh_token?: unknown };
  // Only the ID token leaves this function. The others were never wanted:
  // revoke them without waiting, and let them go out of scope.
  for (const token of [body.refresh_token, body.access_token]) {
    if (typeof token === 'string' && provider.revocationEndpoint)
      void doFetch(provider.revocationEndpoint, { method: 'POST', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, client_id: request.clientId }) }).catch(() => {});
  }
  if (!response.ok || typeof body.id_token !== 'string') throw new Error(`${provider.name} did not return an ID token.`);
  return body.id_token;
}

/** Turns the redirect into the ID token: state, provider error, code exchange if needed, and that it answers this request. */
export async function completeSignIn(provider: OidcProvider, request: OidcRequest, redirected: string, options: { fetch?: typeof fetch } = {}): Promise<string> {
  const params = callbackParams(redirected, request.redirectUri);
  const state = params.get('state');
  if (!state || !STATE.test(state) || state !== request.state) throw new Error('Sign-in answer does not belong to this request.');
  const error = params.get('error');
  if (error) throw new Error(PROVIDER_ERRORS[error] ?? 'The provider refused the sign-in.');
  let idToken: string | null;
  if (provider.responseType === 'code') {
    const code = params.get('code');
    if (!code || code.length > 2048) throw new Error(`${provider.name} did not return a sign-in code.`);
    idToken = await exchangeCode(provider, request, code, options.fetch ?? fetch);
  } else idToken = params.get('id_token');
  // Apple's code needs a client secret to redeem, which Ghostly does not have: it is dropped with the rest.
  if (!idToken) throw new Error(`${provider.name} did not return an ID token.`);
  const { claims } = decodeIdToken(idToken);
  if (claims.nonce !== request.nonce || !issuerMatches(provider, claims)) throw new Error(`${provider.name} answered another sign-in request.`);
  return idToken;
}

/** Everything the prover does: sign in on this platform and return the ID token for this nonce. */
export async function signInForProof(options: {
  provider: OidcProvider; platform: OidcPlatform; nonce: string; reveal: OidcReveal[];
  window: OidcWindow; signal: AbortSignal; fetch?: typeof fetch;
}): Promise<string> {
  const { window: w } = options;
  try {
    options.signal.throwIfAborted();
    const request = await authorizationRequest({ ...options, redirectUri: w.redirectUri, statePrefix: w.statePrefix });
    const redirected = await w.authorize(request.url, options.signal);
    options.signal.throwIfAborted();
    return await completeSignIn(options.provider, request, redirected, options);
  } finally { w.close(); }
}
