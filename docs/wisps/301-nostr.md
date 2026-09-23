# WISP 301 — Nostr

| Field | Value |
|---|---|
| Candidate number | 301; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-20 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [300](300-peer-proofs.md) |
| Implementation | Experimental Nostr subset; see follow-up |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Scope and baseline

Optional Nostr proof of a Ghost participation. No implementation was found. [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) defines Nostr's signed event structure; it does not define this Ghost proof or reserve a Ghost event kind.

## Candidate adapter

Request a signature from a user-selected Nostr signer over the 09 proof context. Verify event ID/signature and exact signed binding to participation key, audience, challenge and channel. Merely supplying an `npub` or a signed unrelated event is insufficient. Keep the proof private between peers by default; signing does not imply permission to publish it to relays.

Use participation-key authentication after initial proof. Re-prove on key changes or when policy requires freshness. Nostr identity is optional and independent of WebRTC/Iroh/HyperDHT choice. A denied signer request must produce an explicit unmet-proof-policy result, not change the user's keys or silently drop a required proof.

## Compatibility, security and open decisions

Choose event kind, tags/content encoding, domain separation, signer interfaces, canonical vectors, expiry and revocation interpretation before Proposed. No NIP number or event kind is assigned here. Demonstrate both browser and native signer support separately; do not infer it from NIP-01. Stable Nostr keys can correlate otherwise distinct local personas.

## Conformance

Verify identical proof bytes in two independent verifiers; reject a valid Nostr event with wrong Ghost context, replay, changed peer key or missing possession proof. Verify that neither proof nor private key is published without explicit consent.

## References

[Peer Proofs](300-peer-proofs.md), [capability negotiation](03-capabilities.md).

## Implementation follow-up — 2026-09-20

The [proof increment](PROOF-INCREMENT.md) now includes explicit experimental local imports for Pubky and Keet-compatible keys, alongside external-signer Nostr. Multiple proofs coexist per conversation. Ghostly participation remains the default. Pubky Ring and existing Keet account signer bridges remain unavailable; local key control is not evidence of those integrations. All WISPs remain Draft; earlier baseline inspections are historical.
