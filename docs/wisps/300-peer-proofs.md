# WISP 300 — Identity Proofs

| Field | Value |
|---|---|
| Candidate number | 300; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-20 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [02](02-peer-keys.md), [03](03-capabilities.md) |
| Implementation | Experimental Nostr subset; see follow-up |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Purpose and baseline

External identity is an optional attestation about a participation, not the session's transport or its per-message signer. No external proof adapter was found in current core/browser code. A participant may offer multiple proofs or none; local/channel policy decides whether any are required.

## Candidate proof semantics

The external signer attests to a domain-separated statement containing: proof profile/version, external public identity, participation public key, channel context, verifier/audience, purpose, fresh verifier challenge, validity interval and key-generation/rotation context. Bind a fresh session/negotiation transcript when proving within that session, but NEVER bind only a session ID. Field encodings, canonicalization and challenge lengths remain unassigned.

The verifier checks the external signature, expected audience/context, participation-key possession, challenge freshness/single use, expiry and the adapter's revocation rules. Keep replay state for the validity window; reject replays across channels, peers and reconnects. A stable external identifier intentionally links participations and must be presented as such to the user.

After verification, authenticated communication uses the participation/session keys. Do not request a Nostr signature for every chat message. Store verification evidence and policy result with its scope; don't display an expired or revoked proof as currently verified. A signature proves control under its scheme, not legal identity or trustworthiness.

## Compatibility and open decisions

Use explicit capability negotiation; legacy peers are unverified, not invalid by default. Choose canonical proof bytes, clock tolerance, challenge persistence, revocation refresh and behavior when external signers are offline. Rotation of either key requires a new binding; previous proof must not authorize an arbitrary replacement.

## Conformance

Valid proof plus participation possession succeeds; wrong audience/key/channel, reused nonce, expired validity and changed negotiation fail. Verify multiple proofs independently and allow no-proof sessions where policy permits. See [interoperability plan](INTEROP.md).

## References

[Peer keys](02-peer-keys.md), [Nostr](301-nostr.md), [Pubky](302-pubky.md), [Keet](303-keet.md).

## Implementation follow-up — 2026-09-20

The [proof increment](PROOF-INCREMENT.md) now includes explicit experimental local imports for Pubky and Keet-compatible keys, alongside external-signer Nostr. Multiple proofs coexist per conversation. Ghostly participation remains the default. Pubky Ring and existing Keet account signer bridges remain unavailable; local key control is not evidence of those integrations. All WISPs remain Draft; earlier baseline inspections are historical.
