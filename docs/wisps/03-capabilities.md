# WISP 03: Capability Negotiation

| Field | Value |
|---|---|
| Candidate number | 03; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-20 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [01](01-ghost-core.md), [02](02-peer-keys.md) |
| Implementation | Existing advertisements; negotiation proposed |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Local experimental increment

The follow-up adds transcript-negotiated signed signaling, durable per-message delivery/retry state and observed extension interoperability; see the [implementation profile](PAIRED-CHAT-INCREMENT.md) for exact partial coverage and residual risks. This does not change Draft status.

The opt-in [paired chat increment](PAIRED-CHAT-INCREMENT.md) now exercises a limited subset of this draft. It is not full conformance or a replacement for the broader candidate design below. Read its exact wire profile, local admission boundary and limitations separately from the legacy baseline.

## Scope and baseline

Negotiate what a session can do separately from how it connects. Existing `_svc` and `hello.svc` advertise services, not a general capability agreement. `svc` refreshes the authoritative live list. Current limits: 16 services, IDs up to 32 characters, names up to 48, up to eight metadata entries. Legacy peers implicitly offer chat/voice/video.

## Candidate profile

A semantic offer lists capability identifier, supported versions, required/optional status and bounded parameters. A selection chooses an exact version and accepted limits for each capability, authenticated with both offers and the session context. Identifiers and canonical encoding are not assigned here.

Compute the version intersection. Reject a missing required capability or incompatible required version explicitly; omit unsupported optional entries. Unknown optional identifiers are not enabled automatically. Required extensions MUST be understood. Limits are the stricter compatible limits of both peers, not an assumption that the newer client wins. Parameters incompatible with local policy fail rather than broaden access.

Capabilities authorize behavior only after local consent. Advertising `http` does not authorize arbitrary local destinations; payment support does not authorize spending. Reconfiguration has a monotonically advancing revision and acknowledged selection before the newly enabled behavior starts. A withdrawal should close affected operations without changing unrelated permissions.

## Compatibility and privacy

Use a new negotiated envelope for this profile. Preserve old `_svc` parsing; legacy implicit services are not consent to new capabilities. Move large descriptions off rendezvous and expose only the minimal advertisement needed to connect. Capability fingerprints may correlate devices even when keys differ.

## Open decisions and conformance

Choose identifier registry, exact version rules, canonical offer/selection encoding, revision persistence and cancellation behavior. Test overlapping/disjoint versions, malformed limits, unknown required/optional fields, concurrent updates and policy rejection. Both implementations must agree on the same exact enabled set. Existing permissive version parsing is not proof of this negotiation.

## References

[Services](../../packages/core/src/services.ts), [session frames](../../packages/core/src/frames.ts), [transport selection](100-transports.md).
