# WISP 400: Chat Messaging

| Field | Value |
|---|---|
| Candidate number | 400; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-20 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [02](02-peer-keys.md), [03](03-capabilities.md) |
| Implementation | Existing 1:1 messages; stronger semantics proposed |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Contract and concrete profiles

This document defines common responsibilities and proposed extensions. Exact implemented encodings and runtime limits belong to [401 · Paired Chat](401-paired-chat.md), [402 · Legacy Timestamp Chat](402-legacy-chat.md), [403 · Bounded DHT Text](403-dht-text.md). Supporting a concrete profile does not establish full conformance to this Draft.

## Local experimental increment

The follow-up adds transcript-negotiated signed signaling, durable per-message delivery/retry state and observed extension interoperability; see the [implementation profile](PAIRED-CHAT-INCREMENT.md) for exact partial coverage and residual risks. This does not change Draft status.

The opt-in [paired chat increment](PAIRED-CHAT-INCREMENT.md) now exercises a limited subset of this draft. It is not full conformance or a replacement for the broader candidate design below. Read its exact wire profile, local admission boundary and limitations separately from the legacy baseline.

## Implemented scope

See the concrete profiles above for current fields, limits, receipt semantics and runtime availability. Contract requirements below are separately reviewable; proposed extensions are not shipped merely because a profile exists.

## Candidate semantics

Future messages need a stable sender-scoped message ID, authenticated channel/participation context, sequence within a sender generation, content type and bounded body. Distinguish locally queued, sent, received, durably stored and read; only advertise receipts actually implemented. Retries reuse IDs. Deduplication retention must cover the declared retry window and survive restart where durable delivery is promised.

Offer per-sender order with explicit gaps; do not promise total order across peers/groups. Bind generation/epoch changes so sequence resets cannot replay old messages. DHT-only must be an explicit small-message profile with visible size/retention limits; report failure or truncation policy before losing user content. No group fanout over `_msgs`.

## Compatibility, security and open decisions

Keep the legacy timestamp profile separate. Decide message ID encoding, durable outbox, receipt authentication, retry limits, retention and upgrade rules before Proposed. Offline group catch-up is negotiated peer storage in 900, not a Core promise. Receipts leak activity and should have declared policy.

## Conformance

Exercise equal timestamps, out-of-order arrivals, duplicated messages across DHT/data link, disconnect after send but before storage, restart/retry and full budgets with signaling present. Verify no receipt means more than its declared stage.

## References

[LinkSession](../../packages/core/src/link.ts), [GhostLink](../../packages/core/src/ghostlink.ts), [records](../../packages/core/src/records.ts), [local messages](../../packages/browser/src/engine/db.ts), [group sessions](900-group-sessions.md).
