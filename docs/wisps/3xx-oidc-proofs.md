# WISP 3xx: Provider-attested identity (OpenID Connect)

| Field | Value |
|---|---|
| Number assignment | 3xx; planned, number to be defined |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-23 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [300](300-peer-proofs.md) |
| Implementation | In development: `packages/browser/src/proofs/oidc/`; provider clients not yet registered ([checklist](../OIDC-PROVIDERS.md)) |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee.

## Purpose

A person shows one contact that an account at a provider (Google, Microsoft, Apple, GitLab, Twitch) signed in for **this** conversation. The evidence is the provider's own signed ID token; the contact checks it against the provider's published keys. No Ghostly server takes part.

## Trust model: attested, not self-custodied

Unlike a Nostr, Pubky, SSH, PGP or Bitcoin proof, the person holds no key here. The contact trusts **the provider** to say that whoever signed in controls the account. A compromised or coerced provider can mint such a token. The UI MUST say "verified by <provider> on <date>" and MUST NOT present it as a key signature. A provider account identifier (`sub`) is stable and links every conversation where it is shared; the person is told before sharing.

## Binding the statement

This is a provider of the identity-proof contract ([PROOFS.md](../../packages/browser/src/proofs/PROOFS.md)), id `oidc`. The person makes the proof once, on the Identities page: Ghostly builds the statement (the subject is the **issuer** the person picked, e.g. `https://accounts.google.com`; it authorizes a fresh proof key for a validity period) and the person signs in with that provider using **`nonce` = the statement id** (SHA-256 of the statement bytes, 64 hex characters). The provider signs the nonce into the ID token, so the token attests exactly that statement: another statement, proof key, nonce or validity produces another id. Each contact it is shared with then gets a presentation signed by the proof key over their own fresh challenge (WISP 300's exchange); a copy replayed to someone else fails there.

The ID token is the evidence (`{ "token": "<compact JWS>" }`, nothing else). Access and refresh tokens are never requested where the provider allows (`response_type=id_token`), and never stored or shared where it does not (GitLab's code flow: both are revoked right after the exchange).

**Lifetime.** The token itself expires within about an hour; what counts is that the sign-in **followed the statement**: `iat` within [statement issue − 5 min, statement issue + 15 min]. A contact checks the token when the proof is shared with it, which may be days later, and stores the outcome ("verified by <provider> on <date>"), not a session. It can only check while the provider still publishes the signing key; Google rotates within about two weeks, so a proof lasts 7 days by default and 14 at most.

## Verification (contact side)

A token is accepted only when every check passes:

1. Compact JWS, three base64url segments, at most 6144 characters; canonical base64url.
2. Header `alg` in the provider's pinned list (all current providers: `RS256`; the local test issuer also `ES256`). `none`, `HS*` and anything else are refused before any key lookup. Headers `jku`, `jwk`, `x5u`, `x5c`, `crit` are refused: the token never names its own key.
3. `iss` equals the provider's issuer (Google also `accounts.google.com`). Microsoft: `https://login.microsoftonline.com/{tid}/v2.0` with the token's own `tid`, a GUID; a Microsoft key that declares an `issuer` must match it or the template.
4. `aud` contains one of Ghostly's client IDs for that provider (any platform); with several audiences, `azp` equals it; a present `azp` always equals it.
5. `0 < exp − iat ≤ 24 h`, `iat ≤ now + 60 s`, and `iat` within the statement's sign-in window above. (Outside a proof, e.g. the prover's own check right after sign-in, the token must also be unexpired: `nbf ≤ now + 60 s ≤ exp + 120 s`.)
6. `nonce` equals the statement id.
7. `sub` present (≤ 255 characters).
8. Signature valid under the key with the header's `kid` from the provider's **pinned** JWKS URL (not discovered at verification time). RSA keys 2048 to 8192 bits; P-256 for ES256; a key's `use`/`alg`/`key_ops`, when present, must allow this use.

JWKS fetching goes through the contract's `ctx.fetch` (HTTPS GET only, no redirects, no credentials, 10 s time-out, refused offline), 64 KiB and 32 keys at most, cached for an hour (the response's `max-age`, bounded to between 5 min and 24 h, where the fetcher reports it). An unknown `kid` refetches once, at most once a minute per URL (key rotation without becoming a request amplifier).

The result names the account as `<issuer>#<sub>` (Microsoft: the issuer with the account's tenant), `attester` = the issuer host, and, when the person chose to share them, their name or username and email as `display`, with whether the provider says it verified the email. It is shown as attested by that provider, never as a key the person holds, and never as current once the proof expires or is withdrawn.

## Sign-in per platform

| Platform | Mechanism | Redirect URI |
|---|---|---|
| Web | Popup on the app origin; the static `/oidc-callback.html` passes the answer to the tab over a same-origin `BroadcastChannel` | `https://app.ghostly.tools/oidc-callback.html` |
| Extension | `chrome.identity.launchWebAuthFlow` (optional `identity` permission, asked on first use) | `https://<extension id>.chromiumapp.org/oidc` |
| Desktop | System browser (providers refuse embedded WebViews); the web callback page forwards the fragment to a one-shot listener on `127.0.0.1:<port>` opened by a Tauri command; the port travels in the `state` (`d.<port>.<random>`) | the web one |

The fragment never reaches a server. `state` is 32 random bytes, checked before anything else.

## Providers

| Provider | Response | Scopes / claims the person can add | Always in the token |
|---|---|---|---|
| Google | `id_token` | `email`, `profile` | account ID |
| Microsoft | `id_token` (`common`) | `email`, `profile` | account ID, tenant |
| Apple | `code id_token`, fragment, no scope | none (email needs `form_post`, i.e. a server) | app-scoped Apple ID |
| GitLab.com | `code` + PKCE, public client | `email`, `profile` | user ID, **direct groups** |
| Twitch | `id_token` | username via `claims` (email needs an API scope: not offered) | user ID |

Out: **Facebook** (web login yields an access token, no verifiable ID token), **X/Twitter** (no OpenID Connect), **LinkedIn** (secret-bound code exchange, JWKS without CORS), **GitHub** (no ID token). Each would need a Ghostly server that checks the account and signs an attestation, which moves trust to Ghostly; not planned.

## Conformance

Unit tests (`packages/browser/test/oidcVerify.test.ts`, `oidcFlow.test.ts`, `oidcIdentity.test.ts`, the last one also running the shared contract suite) cover acceptance and each refusal: wrong `iss`, `aud`, `azp`, unpinned `alg` (`none`, `HS256` with the public key, `ES256` for Google), self-named keys, key type/size mismatches, expiry/future/lifetime, nonce for another statement or contact, tampering, key rotation and its rate limit, a key no longer published, a sign-in before or long after the statement, JWKS limits, Microsoft tenants, unconfigured providers, state and redirect mismatches, the PKCE exchange with revocation, and the desktop relay routing. The Tauri listener has Rust tests. End-to-end tests run two web peers against a local issuer (`e2e/support/oidcIssuer.ts`) that only test builds know.

## Open decisions

Whether contacts should be able to require a provider proof by policy; how to show a Microsoft tenant name (the token carries only its ID); registration of the provider clients (maintainer).
