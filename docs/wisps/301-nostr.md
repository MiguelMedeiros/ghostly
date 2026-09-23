# WISP 301 — Nostr

| Field | Value |
|---|---|
| Candidate number | 301; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-23 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [300](300-peer-proofs.md) |
| Implementation | Nostr identity-proof provider; see [2026-09-23](#implementation--2026-09-23) |

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

## Implementation — 2026-09-23

Nostr is the first provider of the [identity proofs](300-peer-proofs.md#implementation--2026-09-23-identity-proofs) (`packages/browser/src/proofs/providers/nostr.ts`). Category: self-custodied. Subject: the 32-byte public key, lowercase hex (npub accepted as input).

- **Signers.** NIP-07 (the page's `window.nostr`: web and desktop pages, never assumed inside the extension) and NIP-46 (a `bunker://` link, 1–3 `wss://` relays, loopback `ws://` only for tests, permission `sign_event:30078`, auth URLs shown as links and never opened, two-minute time-out; the ephemeral client key is discarded). No private key is ever entered in Ghostly.
- **Evidence.** One event: kind 30078 (existing NIP-78 application data; no kind is claimed), `created_at` = issue time, content = the exact statement, tags exactly `[["d","ghostly-identity-proof"],["expiration","<expires>"]]`. The verifier recomputes the NIP-01 id from the serialized event, requires `pubkey` = subject, and checks the BIP-340 signature itself, never trusting an id or verification flag it received. Signed once per profile; never published to a relay by Ghostly.
- **Validity.** 90 days by default, at most 365. Nothing is fetched to verify.
- **Profile.** A kind-0 name/picture is looked up only when the contact asks ("Show public profile"), from two fixed relays, signature-checked, name sanitized as plain text, picture from fixed hosts re-encoded to a small JPEG; labelled self-described.

Tests: the contract suite, template tampering, a real NIP-46 WebSocket exchange with an isolated disposable bunker, a NIP-07 signer injected into the page in e2e. No real Nostr account was used.
