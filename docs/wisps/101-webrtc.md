# WISP 101: WebRTC

| Field | Value |
|---|---|
| Candidate number | 101; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-20 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [100](100-transports.md) |
| Implementation | Existing adapter behavior; WISP binding proposed |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Local experimental increment

The follow-up adds transcript-negotiated signed signaling, durable per-message delivery/retry state and observed extension interoperability; see the [implementation profile](PAIRED-CHAT-INCREMENT.md) for exact partial coverage and residual risks. This does not change Draft status.

The opt-in [paired chat increment](PAIRED-CHAT-INCREMENT.md) now exercises a limited subset of this draft. It is not full conformance or a replacement for the broader candidate design below. Read its exact wire profile, local admission boundary and limitations separately from the legacy baseline.

## Existing profile

WebRTC carries the current live data link. `_rtc` conveys compact ICE credentials, DTLS fingerprint and candidates inside encrypted, signed records. The data channel is `ghostly/1`, negotiated ID 0, ordered and reliable. Simultaneous offers are resolved by the lower peer public key retaining its offer. Signaling older than 120 seconds is ignored; connection timeout is 90 seconds and ICE gathering is bounded at five seconds.

The expected DTLS fingerprint is authenticated by the link's rendezvous context. STUN helps discover addresses; configured TURN can relay encrypted traffic. Direct paths do not guarantee IP anonymity. Media uses a separate peer connection in the current implementation.

## Candidate WISP binding

Preserve current signaling as a legacy adapter profile. A future profile MUST bind WebRTC fingerprint, both participation keys, selected capabilities and fresh transport attempt context before accepting data. Advertise data/media capability separately. ICE privacy policies, candidate filtering and TURN consent must survive fallback negotiation.

Keep frame limits and backpressure from the existing data link: 16 KiB binary chunks, 60 KiB accepted control frames, pause above 1 MiB buffered and resume below 256 KiB. These are distinct limits, not a claim that every WebRTC message is at most 16 KiB. Never infer application persistence from reliable channel delivery.

## Compatibility and open decisions

Specify migration between legacy link-secret authentication and future participation-key binding, restart/renegotiation states, supported candidate policies and media coexistence. A PeerJS-based implementation must still implement the selected wire profile; using PeerJS alone does not imply interoperability.

## Conformance

Connect independent engines; verify simultaneous offers, stale signaling rejection, wrong fingerprint failure, direct and explicitly allowed TURN paths, reconnect and backpressure. Include browser permission denials and platform-specific unavailable capabilities.

## References

[DataLink](../../packages/core/src/datalink.ts), [signaling](../../packages/core/src/signal.ts), [frames](../../packages/core/src/frames.ts), [current protocol](../PROTOCOL.md).
