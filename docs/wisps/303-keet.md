# WISP 3xx — Keet

| Field | Value |
|---|---|
| Number assignment | 3xx; planned, number to be defined |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-20 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [300](300-peer-proofs.md) |
| Implementation | Blocked on existing-identity signer API; see follow-up |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

> Planned integration. No current integration is enabled or promised. The historical document identifier 303 remains in the URL for link compatibility; it is not a committed WISP number.

## Scope and evidence

Investigate an optional Keet identity proof. This is a feasibility draft, not a claim that Keet exposes an appropriate signing API, public identity format or bridge. [Keet's official site](https://keet.io/) describes the product; it is not evidence of a Ghost integration contract. No local adapter was found.

## Candidate acceptance boundary

An acceptable integration must expose a documented, user-authorized way to bind a Keet identity to the 09 participation context and independently verify it. Nicknames, screenshots, room membership claims and a HyperDHT transport key are not substitutes for this proof.

Do not extract private keys from Keet storage, invent a signature scheme or require Keet for Ghost. If the API cannot meet replay protection, user consent and verifier requirements, keep this draft blocked on feasibility and omit the capability from offers.

## Open decisions and security

Identify a supported API, licensing/distribution constraints, identity semantics, canonical signed statement, revocation model and platform coverage. Determine whether a proof would expose a stable cross-channel identity. There is no approved wire format, event identifier or assumption of interoperability with Keet rooms.

## Conformance

First gate: a documented API and reproducible proof/verification prototype. Only then apply 09 negative cases using a second implementation. No successful demonstration is recorded by this draft.

## References

[Peer Proofs](300-peer-proofs.md), [HyperDHT transport](103-hyperdht.md), [catalogue](README.md).

## Implementation follow-up — 2026-09-20

The [proof increment](PROOF-INCREMENT.md) now includes explicit experimental local imports for Pubky and Keet-compatible keys, alongside external-signer Nostr. Multiple proofs coexist per conversation. Ghostly participation remains the default. Pubky Ring and existing Keet account signer bridges remain unavailable; local key control is not evidence of those integrations. All WISPs remain Draft; earlier baseline inspections are historical.
