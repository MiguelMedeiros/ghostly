import {
  ATPROTO_DECLARED_SCOPE, ATPROTO_FULL_SCOPE, ATPROTO_PROOF_COLLECTION, ATPROTO_PROOF_SCOPE, atprotoProofRecord, atprotoProofRkey,
  type AtprotoDidDocument, type IdentityStatement,
} from "@ghostly/core";
import type { IdentityFetch, IdentityPlatform } from "../contract";
import { resolveAtprotoDid, resolveAtprotoHandle, type AtprotoResolveOptions } from "./resolve";

/**
 * The prover's half of AT Protocol proofs: AT Protocol OAuth (PAR + PKCE + DPoP, through the official
 * `@atproto/oauth-client`) against the person's own server, then one record written or deleted. Every
 * flow gets a fresh client whose stores live in memory only: the DPoP key (a non-extractable WebCrypto
 * key), the PKCE verifier and the tokens exist for this one flow, are never logged or persisted, and the
 * session is revoked (signOut) as soon as the record is written. Nothing is kept for later: removing
 * the proof asks the person again.
 *
 * The client is identified by the URL of its metadata document (no registration with anyone):
 * https://ghostly.tools/oauth/client-metadata.json, which is ATPROTO_CLIENT_METADATA verbatim
 * (website/public/oauth/client-metadata.json; a unit test keeps the two equal). A web app served from
 * a loopback address (development, the e2e suite) uses AT Protocol's `http://localhost` development
 * client instead, which needs no document.
 */

export const ATPROTO_CLIENT_ID = "https://ghostly.tools/oauth/client-metadata.json";
/** The extension's id in the Chrome Web Store: its chromiumapp.org redirect is registered. Unpacked builds have another id. */
export const EXTENSION_ID = "nbedaagicniejlmfcncndfjcejaidbcf";
export const ATPROTO_REDIRECTS = {
  /** The web app's static callback page (shared with OpenID Connect): the answer stays in the fragment. */
  web: "https://app.ghostly.tools/oidc-callback.html",
  /** chrome.identity.launchWebAuthFlow catches it without loading it. */
  extension: `https://${EXTENSION_ID}.chromiumapp.org/atproto`,
  /** The desktop app's one-shot listener on 127.0.0.1; the port is not part of the match. */
  desktop: "http://127.0.0.1/oidc-callback",
} as const;

/**
 * `native` because the desktop app's loopback redirect is only allowed for native clients; HTTPS
 * redirects (web, extension) are allowed for them too. No `refresh_token` grant: Ghostly never keeps
 * a session, so it never gets a refresh token to lose.
 */
export const ATPROTO_CLIENT_METADATA = {
  client_id: ATPROTO_CLIENT_ID,
  client_name: "Ghostly",
  client_uri: "https://ghostly.tools",
  logo_uri: "https://ghostly.tools/icon-192.png",
  application_type: "native",
  grant_types: ["authorization_code"],
  response_types: ["code"],
  scope: ATPROTO_DECLARED_SCOPE,
  token_endpoint_auth_method: "none",
  dpop_bound_access_tokens: true,
  redirect_uris: [ATPROTO_REDIRECTS.web, ATPROTO_REDIRECTS.extension, ATPROTO_REDIRECTS.desktop],
} as const;

/** AT Protocol's development client: no document, loopback redirects only, any port. */
export function loopbackClientMetadata(redirectUri: string) {
  const registered = new URL(redirectUri);
  registered.port = "";
  const id = `http://localhost?${new URLSearchParams({ redirect_uri: registered.href, scope: ATPROTO_DECLARED_SCOPE })}`;
  return {
    client_id: id, application_type: "native", grant_types: ["authorization_code"], response_types: ["code"], scope: ATPROTO_DECLARED_SCOPE,
    token_endpoint_auth_method: "none", dpop_bound_access_tokens: true, redirect_uris: [registered.href],
  } as const;
}

const isLoopback = (url: string) => { try { const u = new URL(url); return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "[::1]"); } catch { return false; } };
const withoutPort = (url: string) => { const u = new URL(url); u.port = ""; return u.href; };

/**
 * The client for a redirect: the published one, or the development client on a loopback web app. A
 * loopback redirect is registered without its port (servers match any port), but the library checks
 * the exact address locally, so the one in use is added to the copy it gets; the server only ever sees
 * the client id and reads the registered addresses itself.
 */
export function clientMetadataFor(platform: IdentityPlatform, redirectUri: string) {
  const base = platform === "web" && isLoopback(redirectUri) ? loopbackClientMetadata(redirectUri) : ATPROTO_CLIENT_METADATA;
  const registered = base.redirect_uris as readonly string[];
  const matches = registered.includes(redirectUri) || (isLoopback(redirectUri) && registered.includes(withoutPort(redirectUri)));
  if (!matches) throw new Error("This Ghostly build cannot sign in to an AT Protocol server here (its return address is not registered).");
  return { ...base, redirect_uris: [...new Set([redirectUri, ...registered])] };
}

/** How a platform shows the server's page and hands back where it redirected. */
export interface AtprotoWindow {
  /** The redirect URI for this platform, as used in the request (the desktop's carries its port). */
  redirectUri: string;
  /** Opens `url`; resolves with the full address the server redirected to, carrying `state`. */
  authorize(url: string, state: string, signal: AbortSignal): Promise<string>;
  /** Releases the window or listener, answered or not. */
  close(): void;
}

export interface AtprotoHost {
  platform: IdentityPlatform;
  /** Call it straight from the click: the web app opens its popup before anything is awaited. */
  open(): Promise<AtprotoWindow>;
}

/** Which permission to ask for: only Ghostly's records, or the whole repository (older servers). */
export type AtprotoAccess = "proof-records" | "full";
export const scopeFor = (access: AtprotoAccess) => (access === "full" ? ATPROTO_FULL_SCOPE : ATPROTO_PROOF_SCOPE);

/** The server refused the narrow permission: it predates granular scopes. */
export class AtprotoScopeError extends Error {}

/** The account a handle (or a DID typed as is) names, with its document. */
export async function lookupAtprotoAccount(input: string, options: AtprotoResolveOptions & { normalize(input: string): string | null }): Promise<AtprotoDidDocument> {
  const value = input.trim();
  if (value.startsWith("did:")) return resolveAtprotoDid(value, options);
  const handle = options.normalize(value);
  if (!handle) throw new Error("That is not a handle (like alice.bsky.social)");
  const did = await resolveAtprotoHandle(handle, options);
  if (!did) throw new Error(`${handle} does not point to an AT Protocol account`);
  const doc = await resolveAtprotoDid(did, options);
  if (doc.handle !== handle) throw new Error(`${handle} points to an account that names another handle`);
  return doc;
}

export interface AtprotoFlowOptions {
  platform: IdentityPlatform;
  window: AtprotoWindow;
  account: AtprotoDidDocument;
  access: AtprotoAccess;
  signal: AbortSignal;
  /** The resolution the library uses: the same bounded lookups as the verifier. */
  resolve: AtprotoResolveOptions;
  onProgress(message: string): void;
  /** The HTTP client for the OAuth requests and the record (the page's fetch). */
  fetch?: typeof fetch;
}

const MESSAGES: Record<string, string> = {
  access_denied: "You declined on your server. Nothing was published.",
  login_required: "Log in on your server and try again.",
  consent_required: "Your server needs your approval to continue.",
};

/** The redirect's parameters: the fragment (Ghostly asks for fragment responses), then the query. */
export function callbackParams(redirected: string, redirectUri: string): URLSearchParams {
  const url = new URL(redirected), expected = new URL(redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) throw new Error("Sign-in returned to an unexpected address.");
  const params = new URLSearchParams(url.hash.slice(1));
  for (const [k, v] of new URLSearchParams(url.search)) if (!params.has(k)) params.set(k, v);
  return params;
}

const pdsHost = (pds: string) => new URL(pds).host;

/** Runs OAuth for `account`, hands `work` a session scoped to this flow, and always revokes it afterwards. */
async function withSession<T>(options: AtprotoFlowOptions, work: (session: { did: string; fetchHandler(path: string, init?: RequestInit): Promise<Response> }) => Promise<T>): Promise<T> {
  const { window: w, account, signal } = options;
  signal.throwIfAborted();
  const [{ OAuthClient }, { WebcryptoKey }] = await Promise.all([import("@atproto/oauth-client"), import("@atproto/jwk-webcrypto")]);
  const states = new Map<string, unknown>(), sessions = new Map<string, unknown>();
  let state: string | undefined;
  const memory = <V>(map: Map<string, V>, onSet?: (key: string) => void) => ({
    async get(key: string) { return map.get(key); },
    async set(key: string, value: V) { onSet?.(key); map.set(key, value); },
    async del(key: string) { map.delete(key); },
  });
  const client = new OAuthClient({
    responseMode: "fragment",
    clientMetadata: clientMetadataFor(options.platform, w.redirectUri) as never,
    stateStore: memory(states, key => { state = key; }) as never,
    sessionStore: memory(sessions) as never,
    runtimeImplementation: {
      createKey: algs => WebcryptoKey.generate(algs),
      getRandomValues: length => crypto.getRandomValues(new Uint8Array(length)),
      digest: async (data, { name }) => new Uint8Array(await crypto.subtle.digest(`SHA-${name.slice(3)}`, data)),
    },
    // The same lookups the verifier makes, bounded, through the person's DoH resolver: no third-party handle resolver.
    identityResolver: {
      async resolve(input: string) {
        const did = input.startsWith("did:") ? input : await resolveAtprotoHandle(input, options.resolve);
        if (!did) throw new Error("The account could not be resolved");
        const doc = await fetchDidJson(did, options.resolve);
        return { did, didDoc: doc.json, handle: doc.parsed.handle ?? "handle.invalid" } as never;
      },
    },
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    allowHttp: false,
  });
  let url: URL;
  try {
    url = await client.authorize(account.did, { scope: scopeFor(options.access), redirect_uri: w.redirectUri as never, signal });
  } catch (e) {
    const text = String((e as { error?: string })?.error ?? (e as Error)?.message ?? e);
    if (/invalid_scope/i.test(text) || /scope/i.test(String((e as { errorDescription?: string })?.errorDescription ?? ""))) throw new AtprotoScopeError(
      "Your server does not offer a permission limited to Ghostly's records: it only offers full access to your account. Choose \"Your server, full access\" to continue anyway; Ghostly still only writes this one record.");
    // eslint-disable-next-line preserve-caught-error -- A message people can act on; the library's error stays out of the UI (ES2020 has no Error.cause).
    throw new Error(`Your server (${pdsHost(account.pds)}) refused to start the sign-in.`);
  }
  if (!state) throw new Error("The sign-in could not start.");
  options.onProgress(`Approve on ${pdsHost(account.pds)} in the window that opened…`);
  const redirected = await w.authorize(url.href, state, signal);
  signal.throwIfAborted();
  const params = callbackParams(redirected, w.redirectUri);
  const error = params.get("error");
  if (error) throw new Error(MESSAGES[error] ?? "Your server refused the sign-in.");
  let session: Awaited<ReturnType<typeof client.callback>>["session"];
  try { ({ session } = await client.callback(params, { redirect_uri: w.redirectUri as never })); }
  catch { throw new Error("The sign-in could not be completed. Nothing was published."); }
  try {
    if (session.did !== account.did) throw new Error("You logged in to another account than the one you typed. Nothing was published.");
    return await work(session);
  } finally {
    // Revokes the tokens on the server; the DPoP key and verifier go out of scope with the client.
    await session.signOut().catch(() => {});
    sessions.clear(); states.clear();
  }
}

/** A DID's document, checked, and the JSON the library reads its services from. */
async function fetchDidJson(did: string, options: AtprotoResolveOptions): Promise<{ parsed: AtprotoDidDocument; json: unknown }> {
  let json: unknown;
  const recording: IdentityFetch = async (url, init) => {
    const response = await options.fetch(url, init);
    try { json = JSON.parse(response.text); } catch { /* resolveAtprotoDid says so */ }
    return response;
  };
  const parsed = await resolveAtprotoDid(did, { ...options, fetch: recording });
  return { parsed, json };
}

async function xrpcError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
  return `${body.error ?? response.status}${body.message ? `: ${body.message}` : ""}`;
}

/** Writes the proof record (rkey = the proof key) and returns once the server has it. */
export async function publishAtprotoProof(statement: IdentityStatement, options: AtprotoFlowOptions): Promise<void> {
  await withSession(options, async session => {
    options.onProgress(`Publishing the proof on ${pdsHost(options.account.pds)}…`);
    const response = await session.fetchHandler("/xrpc/com.atproto.repo.createRecord", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: session.did, collection: ATPROTO_PROOF_COLLECTION, rkey: atprotoProofRkey(statement.binding.key), record: atprotoProofRecord(statement, new Date()) }),
    });
    if (response.status === 403) throw new AtprotoScopeError("Your server did not let Ghostly write its record. Choose \"Your server, full access\" to try again.");
    if (!response.ok) throw new Error(`Your server did not publish the record (${await xrpcError(response)}).`);
  });
}

/** Deletes the proof record. Deleting a record that is not there succeeds. */
export async function unpublishAtprotoProof(proofKey: string, options: AtprotoFlowOptions): Promise<void> {
  await withSession(options, async session => {
    options.onProgress(`Deleting the record on ${pdsHost(options.account.pds)}…`);
    const response = await session.fetchHandler("/xrpc/com.atproto.repo.deleteRecord", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: session.did, collection: ATPROTO_PROOF_COLLECTION, rkey: atprotoProofRkey(proofKey) }),
    });
    if (response.status === 403) throw new AtprotoScopeError("Your server did not let Ghostly delete its record.");
    if (!response.ok) throw new Error(`Your server did not delete the record (${await xrpcError(response)}).`);
  });
}
