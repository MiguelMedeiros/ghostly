# WISP 102 — Iroh

| Field | Value |
|---|---|
| Candidate number | 102; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-20 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [100](100-transports.md) |
| Implementation | Experimental native paired-chat adapter; see increment |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Local native implementation (2026-09-20)

The [native transport increment](TRANSPORT-INCREMENT.md) documents the implemented wire profile, negotiation rule, platform evidence and remaining limitations. It does not make this Draft Final or establish independent implementation conformance. Baseline absence statements below describe the initial inspection before that increment.

## Purpose and evidence

Evaluate Iroh as an optional data adapter, independent of external identity proofs. No Ghost adapter was found in the inspected source. Upstream exposes endpoint identities and application protocol selection; this is not evidence of Ghost compatibility. See [Iroh endpoint source](https://github.com/n0-computer/iroh/blob/main/iroh/src/endpoint.rs) and [protocol examples](https://www.iroh.computer/proto).

## Candidate contract

Exchange a bounded endpoint descriptor through authenticated negotiation, bind that endpoint's key to the Ghost participation and attempt, and verify the remote endpoint before application traffic. Define stream-to-frame mapping, maximum frames, concurrent streams, backpressure, half-close and failure propagation. Do not reuse Ghost secret key bytes as Iroh credentials by convention.

Relay/discovery use and address visibility must be exposed as policy inputs to 05. Disable prohibited routes or fail clearly. Protocol negotiation/ALPN alone does not prove the remote endpoint belongs to the expected Ghost peer.

## Compatibility, security and open decisions

Pin an upstream version and prove native and browser feasibility separately. Select the application protocol identifier only through registry review. Decide reliable framing and media support; Iroh gossip is not the GossipSub profile in 22. No mandatory Iroh deployment, relay or wallet is introduced.

## Conformance

Two independent Ghost adapter implementations exchange the same capability payload; reject mismatched endpoint binding, reconnect with fresh context, test relay policy and bounds. Native success must not be reported as browser support. All results are pending.

## References

[Transport negotiation](100-transports.md), [participation lifecycle](02-peer-keys.md), [evidence ledger](IMPLEMENTATION.md).
