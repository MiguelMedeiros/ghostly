# WISP 3xx: AT Protocol identity (Bluesky)

| Field | Value |
|---|---|
| Number assignment | 3xx; planned, number to be defined |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-25 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [300](300-peer-proofs.md) |
| Implementation | In development: `packages/core/src/atprotoRepo.ts`, `atprotoIdentity.ts`, `packages/browser/src/proofs/atproto/`, `proofs/providers/atproto.ts`; the client metadata goes live with the website |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee.

## Purpose

A person shows one contact that they control an AT Protocol account (a Bluesky account, or one on any other Personal Data Server). The evidence is a record in the account's own repository, which the account's key signs; the contact checks it from the repository, without logging in anywhere and without a Ghostly server.

## Trust model

The identity is the account's DID (`did:plc:…` or `did:web:<host>`). Its DID document names a signing key and a server (PDS); every commit to the repository is signed by that key. The proof is therefore as strong as control of the DID: whoever holds its signing key, which is usually the PDS operator acting on the person's login, not the person. It is shown as the person's own identity (self-custodied in the contract's terms), with that caveat in the UI: it proves control of the account, not who someone is.

A handle (`alice.bsky.social`, `miguel.example.com`) is a name the DID document claims. It is shown only when it resolves back to the same DID; otherwise the card shows the DID.

**The record is public.** Everything in an AT Protocol repository is readable by anyone. The record reveals that this account authorized some Ghostly proof key for a period; it does not say which contacts see it (the per-contact presentations of WISP 300 never touch the repository). The person is told before publishing.

## Binding the statement

This is a provider of the identity-proof contract ([PROOFS.md](../../packages/browser/src/proofs/PROOFS.md)), id `atproto`. The statement's subject is the account's DID. The person makes the proof once, on the Identities page:

1. They type a handle (or a DID). Ghostly resolves it (below), requires the DID document to claim that same handle, and builds the statement authorizing a fresh proof key.
2. Ghostly runs AT Protocol OAuth against the account's server and writes one record:

```json
{ "$type": "tools.ghostly.proof", "statement": "<the statement text, exactly>", "createdAt": "2026-09-25T12:00:00.000Z" }
```

in collection `tools.ghostly.proof` with **record key = the proof key** (52 characters of z-base-32, already a valid record key), so the record is found and removed by the proof key alone. The lexicon is [docs/lexicons/tools.ghostly.proof.json](../lexicons/tools.ghostly.proof.json).

3. The session is revoked right after the write. Evidence is the empty object `{}`: a verifier fetches everything from the repository. Any other evidence is refused, so a proof can never name a server or a URL.

Each contact the proof is shared with then gets a presentation signed by the proof key over their own challenge (WISP 300).

## OAuth

- **Protocol**: AT Protocol OAuth, with the official `@atproto/oauth-client`: pushed authorization requests (PAR), PKCE (S256), DPoP-bound tokens with server nonces, `response_mode=fragment`. The client resolves the account through the same bounded lookups as the verifier (no third-party handle resolver), checks that the token's `sub` is the DID typed, and that the DID's server names the authorization server that answered.
- **Scope**: `atproto repo:tools.ghostly.proof?action=create&action=delete`: create and delete records of Ghostly's collection, nothing else (no posts, messages, profile, blobs or service calls). A server that predates granular permissions refuses it; the person is then told, and may choose "full access" (`atproto transition:generic`), which Ghostly uses for the same single write. Removing asks for the same narrow scope again (full access if that server refused it before).
- **State kept**: none. Each flow has its own client whose state and session stores are in memory; the DPoP key is a non-extractable WebCrypto key; no refresh token is requested (`grant_types` is `authorization_code` only). Nothing is logged.
- **Client identity**: the URL of its metadata document, [`https://ghostly.tools/oauth/client-metadata.json`](../../website/public/oauth/client-metadata.json) (`application_type: native`, `token_endpoint_auth_method: none`, `dpop_bound_access_tokens: true`). A unit test keeps it equal to the app's copy. A web app served from a loopback address uses AT Protocol's development client (`http://localhost?redirect_uri=…&scope=…`), which needs no document; that is how the e2e suite runs against a local PDS.

| Platform | Mechanism | Redirect URI (registered) |
|---|---|---|
| Web | Popup on the app origin; the static `/oidc-callback.html` (shared with OpenID Connect) passes the fragment to the tab over a same-origin `BroadcastChannel`; the flow names the `state` it waits for, since PAR keeps it off the address | `https://app.ghostly.tools/oidc-callback.html` |
| Extension | `chrome.identity.launchWebAuthFlow` (optional `identity` permission, asked from the click) | `https://<Chrome Web Store id>.chromiumapp.org/atproto`; an unpacked build's id is not registered |
| Desktop | System browser to a one-shot Tauri listener on 127.0.0.1 (the native-client loopback pattern; the port is not matched) | `http://127.0.0.1/oidc-callback` |

## Verification (contact side)

A proof is accepted only when every step passes. All requests go through the contract's `ctx.fetch`: HTTPS GET, no credentials, no redirects, a time-out, a size cap. No URL comes from the proof.

1. The subject is a `did:plc` (24 base32 characters) or a hostname-level `did:web`.
2. **DID document**: `https://plc.directory/<did>` or `https://<host>/.well-known/did.json`, at most 32 KiB, JSON, `id` equal to the DID. The `#atproto` verification method is a secp256k1 or P-256 key, as `Multikey` (multicodec-prefixed, compressed) or the legacy `EcdsaSecp256k1VerificationKey2019` / `EcdsaSecp256r1VerificationKey2019` form. The `#atproto_pds` service of type `AtprotoPersonalDataServer` is an https origin without path, query or credentials.
3. **Record proof**: `GET <pds>/xrpc/com.atproto.sync.getRecord?did=<did>&collection=tools.ghostly.proof&rkey=<proof key>`, at most 256 KiB. A `RecordNotFound` error, or a proof of absence, means the record was deleted.
4. **CAR**: v1, the first root is the commit; every block's SHA-256 matches its CIDv1 (dag-cbor or raw); at most 1024 blocks. DAG-CBOR is decoded strictly (minimal lengths, sorted unique text keys, only tag 42 links, no floats or undefined, depth 32), so re-encoding reproduces the signed bytes.
5. **Commit**: version 3, `did` equal to the subject; `sig` is a 64-byte low-S ECDSA signature over SHA-256 of the commit without `sig`, by the DID document's key.
6. **Tree**: from the commit's `data` down the Merkle Search Tree to the key `tools.ghostly.proof/<proof key>`, every node present in the CAR, entries in order; the value's block decodes to exactly `$type`, `statement` and `createdAt`, and `statement` equals the statement text byte for byte.
7. **Handle**: the first `at://` entry of `alsoKnownAs`, shown only if `_atproto.<handle>` (DNS TXT through the contact's chosen DNS-over-HTTPS resolver) or `https://<handle>/.well-known/atproto-did` (after checking its addresses are public) gives back the same DID.

The result: subject = the DID; source "Record signed with the account's key, from <pds host>"; `display.name` = `@handle` when verified; `display.url` = `https://bsky.app/profile/<did>`. The provider declares a re-check after an hour, so a deleted record or a moved account is noticed.

## Removal

Removing the proof in Ghostly first deletes the record (a fresh approval on the person's server, then `com.atproto.repo.deleteRecord`), then withdraws it everywhere and publishes WISP 300's Pkarr revocation record. If the deletion fails or is declined, the person may remove the proof without it: contacts still see it revoked through the Pkarr record, and the record simply stays in the repository until deleted by hand.

## Privacy

A contact's app asks the PLC directory (or the did:web host) for the DID document, the account's server for the record, and its DNS-over-HTTPS resolver or the handle's website for the handle: each learns that this account was checked, by an IP address, not by whom in Ghostly terms. The person's server sees the OAuth login and the write.

## Conformance

Unit tests: `packages/core/test/atprotoRepo.test.ts` (strict DAG-CBOR, CAR, MST inclusion and absence, commit signatures including high-S refusal, DID documents in both key forms, handle/DID syntax, the record; fixtures from a local PDS and from bsky.app's public repository), `packages/browser/test/atprotoIdentity.test.ts` (the shared contract suite, resolution for did:plc and did:web, DNS then HTTPS handles, the back-check, bounded fetches, the server taken only from the DID document, every refusal), `packages/browser/test/atprotoOAuth.test.ts` (client metadata, scopes, the flow and its errors, the window opened from the click, removal). End to end: two web peers and a local PLC + PDS (`e2e/infra/atproto`), through the real OAuth pages.

## Open decisions

Publishing the lexicon through AT Protocol lexicon resolution (`_lexicon.ghostly.tools`); whether a contact should also fetch the profile's display name and avatar on request; did:web accounts with ports (not atproto-conformant today).
