# WISP 01 — Ghost Core Protocol

| Field | Value |
|---|---|
| Candidate number | 01; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-20 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [00](00-process.md) |
| Implementation | Existing rendezvous; modular boundary proposed |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Purpose and current behavior

Ghost is a minimal, ephemeral rendezvous and small-record exchange primitive over Pkarr/Mainline DHT. Records can contain small encrypted messages and signaling, not only pointers to a homeserver. Ghostly currently composes it with WebRTC and application services. Local history is separate from network presence.

The existing profile is [PROTOCOL.md](../PROTOCOL.md): signed Pkarr DNS packets, at most 1000 DNS bytes; secretbox-encrypted values except plaintext `_ts` and `_ack`; record TTL 300 seconds. `records.ts` prioritizes signaling, then advertisements, then messages that fit. This is not a new WISP wire version.

## Candidate requirements

1. Verify packet signature and expected publishing key before parsing private payloads; authenticate encrypted fields, validate lengths and treat all content as untrusted.
2. Keep rendezvous records bounded. Publish only enough discovery, small data and signaling to establish an allowed session. Bulk files, media, group fanout, history replication and payment tokens MUST leave the DHT.
3. DHT-only small messaging is an explicit profile/policy choice. A failed data transport MUST NOT silently relax a peer's no-DHT-payload policy. Current automatic small-text fallback is legacy behavior, not evidence this policy is implemented.
4. Unknown optional record labels are ignored. A future mandatory extension or incompatible version needs explicit negotiation; adding a label MUST NOT silently reinterpret existing `_msgs`, `_call` or `_rtc` values.
5. Histories and peer state remain local unless a separately authorized synchronization capability is selected. A homeserver is not required by Core.

## Compatibility and privacy

Keep the current wire profile unchanged until a migration is specified. Pkarr relay access and direct DHT access are ways of reaching rendezvous, not alternative application data transports. A relay can observe public keys, activity, packet sizes and plaintext metadata. DHT records are publicly retrievable by address; the shared secret protects contents. Presence expiry neither proves deletion nor hides network addresses. See [limitations](IMPLEMENTATION.md).

## Open decisions

Fix the extensible Core version envelope, record budget per future capability, replay watermark persistence, expiry/clock-skew rules and publication/poll budgets across platforms. Specify what happens when mandatory signaling alone exceeds the packet budget; do not split arbitrary heavy data across DHT records as a workaround.

## Conformance

Exchange current TypeScript/Rust fixtures; reject wrong signatures and tampered ciphertext; ignore unknown optional labels; exercise full packet budgets, stale packets and relay failures. Demonstrate an explicit DHT-only session and a no-DHT-payload session that fails closed. See [test plan](INTEROP.md).

## References

[Records](../../packages/core/src/records.ts), [Pkarr validation](../../packages/core/src/pkarr.ts), [link polling](../../packages/core/src/link.ts), [Pkarr](https://github.com/pubky/pkarr).
