# WISP 9xx — GossipSub Transport

| Field | Value |
|---|---|
| Number assignment | 9xx; planned, number to be defined |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-20 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [100](100-transports.md), [900](900-group-sessions.md) |
| Implementation | Proposed; no adapter found |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

> Planned integration. No current integration is enabled or promised. The historical document identifier 901 remains in the URL for link compatibility; it is not a committed WISP number.

## Purpose and evidence

Evaluate GossipSub as an off-DHT distribution layer for group sessions. No Ghostly adapter was found. [libp2p GossipSub v1.1](https://github.com/libp2p/specs/blob/master/pubsub/gossipsub/gossipsub-v1.1.md) describes mesh/gossip routing and peer scoring; neither routing nor scoring is group encryption, membership consensus or guaranteed storage.

[Waku Relay](https://lip.logos.co/messaging/core/stable/11/relay.html) is a useful primary example of a specified GossipSub-based routing profile. It is a reference for design questions, not a decision to adopt Waku, its protocol identifier or its network. Waku interoperability requires a separate compatible profile and is not claimed.

## Candidate mapping

21 selects the routing/security profile through an authenticated descriptor. Admission delivers topic/routing credentials over an authenticated off-DHT path. A topic name is a routing hint, not a secret key or an authorization proof. Avoid directly encoding stable external identities/group names in public topics. Topic secrecy is not anonymity; connected peers can observe subscriptions and traffic.

Group-security-protected application envelopes are the payload. Bound message size and verification/queue work. Define a stable deduplication identifier over the exact authenticated envelope/profile before Proposed; don't assume default libp2p sender IDs equal Ghost participants. Verify membership/epoch and inner authentication before application acceptance. Forwarding policy must distinguish nodes that can verify membership from blind delivery nodes; neither may invent admission decisions.

Specify outer pubsub signature policy, libp2p identity-to-participation binding where needed, topic rotation on removal, bootstrap peers, mesh/scoring parameters and address/relay policies. Group signing/encryption keys MUST NOT be distributed in a public topic or DHT record. Removal changes group keys via 21, not merely a topic rename.

## Delivery, failure and limits

GossipSub does not promise total ordering, exactly-once processing or offline recovery. Use 13 message IDs/receipts and 21 epoch handling. Missing history requires an explicitly negotiated peer storage/sync mechanism; no DHT fallback for group traffic. Media and file bodies must use separately negotiated bulk paths unless a bounded profile has been validated.

Benchmark against the small full-mesh prototype before choosing a routing profile. Report topology, bandwidth, latency, churn and message loss at stated member counts. Score tuning and bounded queues help constrain abuse but do not prove Sybil resistance. Public lobby spam controls need separate evaluation.

## Compatibility and open decisions

Pin upstream versions and exact pubsub protocol ID, transport binding, message-ID function, validation pipeline, private/public topology, topic derivation/rotation and all resource limits. Decide whether browser participants route directly or use an explicitly authorized bridge. Iroh gossip and HyperDHT are not automatically libp2p GossipSub adapters. No global mandatory data transport follows from choosing this group distribution profile.

## Conformance

Two independent adapters relay identical encrypted group envelopes; test duplicates, wrong epoch/topic, removed participant, malformed/oversized payload, malicious flooding, partition/rejoin, bridge failure and bounded memory. Demonstrate no plaintext delivery to nonmembers and no claim of delivery while a peer is offline without a negotiated store. All results remain pending.

## References

[Group sessions](900-group-sessions.md), [transport selection](100-transports.md), [chat](400-chat.md), [interoperability plan](INTEROP.md).
