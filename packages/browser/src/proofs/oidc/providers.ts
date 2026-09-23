/**
 * The OpenID Connect providers Ghostly can ask for a signed ID token. A contact
 * verifies that token against the provider's published keys, with no Ghostly
 * server in between, so a provider is only listed when its ID tokens are signed
 * and its keys and sign-in page are reachable from a browser without a client
 * secret. See docs/wisps/3xx-oidc-proofs.md for the providers that are not
 * (Facebook, X, LinkedIn, GitHub) and why.
 *
 * Client IDs are public configuration, identical in every build, because the
 * contact's app checks `aud` against them. They stay empty until the OAuth
 * clients are registered (docs/OIDC-PROVIDERS.md); a provider without a client
 * ID is neither offered nor accepted.
 */

export type OidcProviderId = 'google' | 'microsoft' | 'apple' | 'gitlab' | 'twitch' | 'test';
export type OidcAlg = 'RS256' | 'ES256';
export type OidcPlatform = 'web' | 'extension' | 'desktop';
/** What the person chooses to put in the token beyond the account identifier. */
export type OidcReveal = 'email' | 'profile';

export interface OidcProvider {
  id: OidcProviderId;
  name: string;
  /** Exact `iss`. Microsoft's contains the tenant: see `issuerFor`. */
  issuer: string;
  /** Other spellings the provider documents for the same issuer. */
  issuerAliases?: string[];
  discovery: string;
  authorizationEndpoint: string;
  /** Pinned rather than discovered, so a changed discovery document cannot redirect key lookup. */
  jwksUri: string;
  /** Only for `code`: the token endpoint, reached with PKCE and no secret. */
  tokenEndpoint?: string;
  /** Best effort after a `code` exchange: the access token Ghostly never wanted is revoked at once. */
  revocationEndpoint?: string;
  /** Pinned per provider; the token header's `alg` must be one of these. */
  algs: OidcAlg[];
  /**
   * `id_token` returns only the signed ID token in the fragment: no access
   * token, no code, nothing to exchange, so no secret. `code id_token` is
   * Apple's shape (its code needs a secret; Ghostly drops it). `code` is for
   * providers without an ID-token-only response, exchanged with PKCE.
   */
  responseType: 'id_token' | 'code id_token' | 'code';
  /** Which extra claims this provider can add, and the scope (or claims request) for each. */
  reveal: Partial<Record<OidcReveal, { scope?: string; claims?: string[] }>>;
  /** What the provider puts in the token whatever the person picks. Shown before sign-in. */
  alwaysIncluded: string;
  /** Extra authorization parameters, e.g. an account chooser. */
  extraParams?: Record<string, string>;
  /** Client IDs per platform. Desktop signs in through the web callback page, so it uses the web client. */
  clientIds: Partial<Record<OidcPlatform, string>>;
}

export const TEST_ISSUER = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.test$/;
const MICROSOFT_TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const OIDC_PROVIDERS: Record<Exclude<OidcProviderId, 'test'>, OidcProvider> = {
  google: {
    id: 'google', name: 'Google',
    issuer: 'https://accounts.google.com', issuerAliases: ['accounts.google.com'],
    discovery: 'https://accounts.google.com/.well-known/openid-configuration',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    algs: ['RS256'], responseType: 'id_token',
    reveal: { email: { scope: 'email' }, profile: { scope: 'profile' } },
    alwaysIncluded: 'A Google account identifier.',
    extraParams: { prompt: 'select_account' },
    clientIds: { web: '', extension: '' },
  },
  microsoft: {
    // `common` takes work, school and personal accounts; the issuer names the account's tenant.
    id: 'microsoft', name: 'Microsoft',
    issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
    discovery: 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
    authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
    algs: ['RS256'], responseType: 'id_token',
    reveal: { email: { scope: 'email' }, profile: { scope: 'profile' } },
    alwaysIncluded: 'A Microsoft account identifier and the directory (tenant) the account belongs to.',
    extraParams: { prompt: 'select_account', response_mode: 'fragment' },
    clientIds: { web: '', extension: '' },
  },
  apple: {
    // Apple only returns the ID token in the fragment when no scope is asked
    // for; name and email need `form_post`, which a static page cannot read.
    id: 'apple', name: 'Apple',
    issuer: 'https://appleid.apple.com',
    discovery: 'https://appleid.apple.com/.well-known/openid-configuration',
    authorizationEndpoint: 'https://appleid.apple.com/auth/authorize',
    jwksUri: 'https://appleid.apple.com/auth/keys',
    algs: ['RS256'], responseType: 'code id_token',
    reveal: {},
    alwaysIncluded: 'An Apple ID identifier that only Ghostly sees. Apple cannot add your email here without a Ghostly server.',
    extraParams: { response_mode: 'fragment' },
    clientIds: { web: '', extension: '' },
  },
  gitlab: {
    id: 'gitlab', name: 'GitLab',
    issuer: 'https://gitlab.com',
    discovery: 'https://gitlab.com/.well-known/openid-configuration',
    authorizationEndpoint: 'https://gitlab.com/oauth/authorize',
    tokenEndpoint: 'https://gitlab.com/oauth/token',
    revocationEndpoint: 'https://gitlab.com/oauth/revoke',
    jwksUri: 'https://gitlab.com/oauth/discovery/keys',
    algs: ['RS256'], responseType: 'code',
    reveal: { email: { scope: 'email' }, profile: { scope: 'profile' } },
    alwaysIncluded: 'A GitLab.com user ID and the groups you belong to directly: GitLab adds them to every ID token.',
    clientIds: { web: '', extension: '' },
  },
  twitch: {
    // Twitch's email claim needs `user:read:email`, an API scope: not asked for.
    id: 'twitch', name: 'Twitch',
    issuer: 'https://id.twitch.tv/oauth2',
    discovery: 'https://id.twitch.tv/oauth2/.well-known/openid-configuration',
    authorizationEndpoint: 'https://id.twitch.tv/oauth2/authorize',
    jwksUri: 'https://id.twitch.tv/oauth2/keys',
    algs: ['RS256'], responseType: 'id_token',
    reveal: { profile: { claims: ['preferred_username'] } },
    alwaysIncluded: 'A Twitch user ID.',
    extraParams: { force_verify: 'true' },
    clientIds: { web: '', extension: '' },
  },
};

/**
 * The local issuer the e2e suite runs (e2e/support/oidcIssuer.ts). It exists
 * only in a build made with VITE_OIDC_TEST_ISSUER, and only on a `.test` host
 * (a name reserved for testing, never a real issuer); a release build has no
 * such provider, so a token from it is refused like any unknown issuer.
 */
export function testProvider(issuer: string): OidcProvider {
  if (!TEST_ISSUER.test(issuer)) throw new Error('A test issuer lives on a .test host');
  const base = issuer;
  return {
    id: 'test', name: 'Test issuer', issuer: base,
    discovery: `${base}/.well-known/openid-configuration`,
    authorizationEndpoint: `${base}/authorize`,
    jwksUri: `${base}/jwks`,
    algs: ['RS256', 'ES256'], responseType: 'id_token',
    reveal: { email: { scope: 'email' }, profile: { scope: 'profile' } },
    alwaysIncluded: 'A test account identifier.',
    clientIds: { web: 'ghostly-e2e', extension: 'ghostly-e2e', desktop: 'ghostly-e2e' },
  };
}

function configuredTestIssuer(): string | undefined {
  try {
    const value = import.meta.env?.VITE_OIDC_TEST_ISSUER as string | undefined;
    return value && TEST_ISSUER.test(value) ? value : undefined;
  } catch { return undefined; }
}

/** Every provider this build knows, configured or not. */
export function oidcProviders(testIssuer = configuredTestIssuer()): OidcProvider[] {
  return [...Object.values(OIDC_PROVIDERS), ...(testIssuer ? [testProvider(testIssuer)] : [])];
}

export function oidcProvider(id: string, testIssuer = configuredTestIssuer()): OidcProvider | undefined {
  return oidcProviders(testIssuer).find(p => p.id === id);
}

/** Every client ID this provider has, on any platform: a contact may use another platform than the prover. */
export function audiences(provider: OidcProvider): string[] {
  return [...new Set(Object.values(provider.clientIds).filter((id): id is string => !!id))];
}

export function clientIdFor(provider: OidcProvider, platform: OidcPlatform): string {
  return provider.clientIds[platform] || provider.clientIds.web || '';
}

/** A provider is offered only once its client ID for this platform exists. */
export function isConfigured(provider: OidcProvider, platform: OidcPlatform): boolean {
  return !!clientIdFor(provider, platform);
}

/** The exact issuer a token from this provider must carry, or undefined when its claims do not name one. */
export function issuerFor(provider: OidcProvider, claims: { tid?: unknown }): string[] {
  if (provider.id !== 'microsoft') return [provider.issuer, ...(provider.issuerAliases ?? [])];
  return typeof claims.tid === 'string' && MICROSOFT_TENANT.test(claims.tid) ? [provider.issuer.replace('{tenantid}', claims.tid)] : [];
}

/** The provider a proof's subject (an issuer, as `OidcProvider.issuer` spells it) names. */
export function providerForIssuer(issuer: string, list = oidcProviders()): OidcProvider | undefined {
  return list.find(p => p.issuer === issuer);
}
