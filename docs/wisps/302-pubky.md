# WISP 3xx — Pubky

> Release decision (2026-09-21): external identity proofs and external profile lookup are deferred. This release exposes only Ghostly participation identity. Nostr, Pubky, Keet, imports and Ring UI are disabled; previous experiments and stored data are preserved for future work. Descriptions below are historical/research, not available release features.

| Field | Value |
|---|---|
| Number assignment | 3xx; planned, number to be defined |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-20 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [300](300-peer-proofs.md) |
| Implementation | Experimental local import and modified-Ring adapter; see follow-up |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

> Planned integration. No current integration is enabled or promised. The historical document identifier 302 remains in the URL for link compatibility; it is not a committed WISP number.

## Scope and baseline

Optional Pubky identity proof bound to a participation. Existing Pkarr use and Paykit-inspired payment identifiers do not constitute Pubky identity integration. The [browser documentation](../BROWSER.md) explicitly describes the current lack of Pubky Ring integration.

## Candidate adapter

Use a supported external signing/authorization interface only after proving it can produce a verifiable, domain-separated binding satisfying 09. Verify participation-key possession separately. Keep external credentials out of Ghost records and local application services. A Pubky identifier, a homeserver session or ownership of a Pkarr packet alone is not this proof.

An external signer may be used when a proof is required; ordinary messages continue under participation/session keys. No Pubky homeserver becomes mandatory for Ghost rendezvous or history. Declining a proof must preserve the ability to use channels that do not require one.

## Compatibility, security and open decisions

The current [Pubky homeserver repository](https://github.com/pubky/pubky-homeserver) is a research entry point, not a validated proof API. Pin a signer/API and establish its statement format, audience protection, permission model and revocation handling. Test platform support and avoid treating passkeys or hardware support as already available. Reusing private keys between Ghost and Pubky is not required.

## Conformance

Two independent verifiers must reject signatures for the wrong participation/audience, stale authorization and revoked bindings. Demonstrate proof creation through the chosen external interface before claiming compatibility. All such results are pending.

## References

[Peer Proofs](300-peer-proofs.md), [implementation evidence](IMPLEMENTATION.md).

## Implementation follow-up — 2026-09-20

The [proof increment](PROOF-INCREMENT.md) now includes explicit experimental local imports for Pubky and Keet-compatible keys, alongside external-signer Nostr. Multiple proofs coexist per conversation. Ghostly participation remains the default. Pubky Ring and existing Keet account signer bridges remain unavailable; local key control is not evidence of those integrations. All WISPs remain Draft; earlier baseline inspections are historical.


## Modified Ring identity authorization — implementation candidate

The new negotiated capability is `proof-pubky-ring/1`, separate from `proof-pubky-import/1`. This is an experimental extension to Ring revision `f142436883b4f41a599da37993a9635225f008fa`, **not compatible with the unchanged official Ring app**. Source overlay, reproducible patch and rationale are in [the Ring integration](../../integrations/pubky-ring/README.md). No Pubky SDK export of a session credential is used.

The issuer signs an Ed25519 JWS with exact header `{"alg":"EdDSA","typ":"ghostly-pubky-identity-delegation/1"}`. Its canonical claims are `iss` (Pubky z32 key), `cnf` (temporary delegated z32 key), `aud` (`ghostly-peer-proof/1`), `challenge` (base64url SHA-256 of the exact statement), `iat`, and `exp`. This is deliberately a different type from `pubky-grant`: it grants no homeserver capabilities. The authorization's lifetime equals the challenge's ten minutes.

The statement uses WISP09's canonical array with adapter `pubky-ring` and purpose `delegated-conversation-proof`; all participation/audience/context/session/nonce/time fields remain signed. The client signs `["ghostly-pubky-possession",1,SHA256(authorization),statement]` with the delegated key. Evidence contains only `scheme`, public `authorization`, `signature`, and a SHA-256 digest ID. The peer MUST verify both signatures, exact statement claims, canonical encoding, negotiated capability, audience, current pending challenge and single-use nonce before durable acceptance. Ordinary Ghostly participation authentication is unchanged.

Ring MUST show explicit per-request consent and compareable conversation/participant identifiers. Ordinary Ring auto-auth cannot approve this extension. A QR is a private pairing capability, expires after three minutes, and is not persisted. Initial identity selection releases only that public identifier to Ghostly; approval releases the signed public authorization. No root seed, grant secret, bearer token or private delegated key crosses the peer channel. A restart cancels pending approvals and requires fresh keys/nonces.

There is no ongoing homeserver session to revoke. The signed statement expires after ten minutes and Ghostly supports an independent authenticated withdrawal for its presentation. Ring homeserver revocation MUST NOT be described as revoking this separate statement; offline evidence MUST NOT be labelled current account access. A remote recipient can retain copies. Expiry/withdrawal stops using this adapter's cached public name/photo.

A transport fixture or successful build alone is not Ring E2E evidence.
