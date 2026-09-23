# WISP 100 — Transport Negotiation

| Field | Value |
|---|---|
| Candidate number | 100; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-20 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [02](02-peer-keys.md), [03](03-capabilities.md) |
| Implementation | Experimental paired-chat negotiation; see increment |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Local native implementation (2026-09-20)

The [native transport increment](TRANSPORT-INCREMENT.md) documents the implemented wire profile, negotiation rule, platform evidence and remaining limitations. It does not make this Draft Final or establish independent implementation conformance. Baseline absence statements below describe the initial inspection before that increment.

## Local experimental increment

The opt-in [paired chat increment](PAIRED-CHAT-INCREMENT.md) now exercises a limited subset of this draft. It is not full conformance or a replacement for the broader candidate design below. Read its exact wire profile, local admission boundary and limitations separately from the legacy baseline.

## Scope and baseline

Choose an application transport without a global winner. Today `GhostLink` constructs `DataLink` directly; `PkarrTransport` abstracts rendezvous access, not data transport selection. PeerJS is a WebRTC implementation choice, not another adapter. Raw QUIC is not a separate milestone in this series.

## Candidate deterministic negotiation

This is a reviewable algorithm proposal, not an agreed wire standard:

1. Each authenticated offer contains the attempt context, allowed adapter/profile versions in local preference order, connectivity parameters and hard policy constraints. Exclude options prohibited by local privacy/security policy before ranking.
2. Intersect compatible adapter profiles and all hard constraints. Return an explicit no-common-transport result when empty. Missing optional external proofs need not prevent an otherwise allowed transport.
3. For two peers, use the lexicographically lower participation public key as selection coordinator. Follow that peer's advertised order within the common set; resolve any tied entries by canonical adapter/profile identifier. Both peers recompute and explicitly confirm the same choice and offer transcript before use. This simple asymmetric preference rule is a candidate for review, not an established fairness guarantee.
4. Attempt the selected adapter within a bounded, profile-defined timeout. Bind its authenticated remote endpoint to the participation keys and negotiation transcript before application traffic.
5. On failure, agree an incremented attempt and the next untried common candidate. Limit retries and total time. Never silently enable a relay, expose an address class or use DHT payload fallback forbidden by either party. Changed policy/offer requires fresh agreement.

The adapter contract needs connect/accept, authenticated remote identity binding, send/receive with framing boundaries, backpressure, cancellation, error and close semantics. Support for reliable streams, datagrams and media is declared explicitly; adapters are not assumed interchangeable for every capability.

## Compatibility and security

Legacy WebRTC negotiation remains a distinct profile. New offers MUST NOT be interpreted as legacy `_rtc`. Compare signed/authenticated offers, selected versions and endpoint bindings to detect downgrade/substitution. A successful socket alone is insufficient. Group routing selection follows 900; the two-peer coordinator rule is not a group consensus algorithm.

## Open decisions

Fix canonical encodings, adapter IDs, timeout/retry values, simultaneous negotiation resolution, transcript binding and protection against forced repeated failures. Latency measurement and weighted scoring are experiments, not requirements. Browser/native availability must be reported honestly; a bridge is a separate trust/visibility choice.

## Conformance

Reverse offer arrival order and still choose the same result; exercise disjoint sets, crossed attempts, policy-prohibited relay fallback, timeout, stale selection and substituted endpoint keys. Demonstrate the same chat capability over at least two adapters before claiming interchangeability.

## References

[Current composition](../../packages/core/src/ghostlink.ts), [rendezvous interface](../../packages/core/src/transport.ts), [WebRTC adapter](101-webrtc.md), [group session](900-group-sessions.md).
