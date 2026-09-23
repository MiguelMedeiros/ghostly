# WISP 900 — Group Session Negotiation

| Field | Value |
|---|---|
| Candidate number | 900; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-20 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [02](02-peer-keys.md), [03](03-capabilities.md), [100](100-transports.md), [800](800-invite-join.md) |
| Implementation | Proposed; no group implementation found |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Purpose and implementation state

Define a concrete candidate group architecture that moves fanout, membership synchronization and history traffic off Pkarr/DHT. No group session, group key schedule or group delivery layer was found in the inspected implementation. This draft specifies responsibilities and state transitions for review; cryptographic and wire profiles remain validation gates.

## Separate the layers

| Layer | Candidate responsibility | Explicit non-guarantee |
|---|---|---|
| Ghost rendezvous | Minimal signed, bounded hints to reach an admission/session endpoint | No message history, member roster, per-recipient group fanout or public join queue in DHT |
| Admission control | Validate invite, participation possession and group policy | Knowing group ID or gossip topic is not membership |
| Group security | Authenticate membership changes and protect application content across epochs | No custom shared-key scheme is approved here |
| Delivery | Route encrypted group messages/commits over a selected live topology | Gossip alone gives neither E2EE nor reliable offline storage |
| Local application | History, message state, permissions and moderation UI | Remote copies cannot be recalled or forcibly erased |

## Distribution is a negotiated family of adapters

Keep three independent contracts: (a) admission/permissions and group security; (b) distribution/overlay; (c) authenticated transport between adjacent peers. A working set of pairwise transport connections does not prove that all members can understand or route the same group distribution protocol.

The candidate distribution interface exposes supported profile/version, join/leave, publish an opaque protected envelope, receive with routing provenance, bounded validation feedback, delivery availability, backpressure and shutdown. It also declares size limits, duplicate/order semantics, topology/forwarding roles, required edge transports, history availability and privacy costs. It MUST NOT grant membership, mint group secrets or bypass application authentication. Group security passes authorized encrypted payloads to distribution; received payloads still require security/application validation.

Initial groups MUST agree on one common distribution profile/version and compatible security/application rules. Each edge can negotiate a supported transport only within that profile's requirements. Unsupported overlay combinations fail explicitly even if individual sockets connect. Future bridges require an explicitly supported mapping, authorization, loop/deduplication handling, trust analysis and independent tests; no bridge is assumed now.

GossipSub is the initial named candidate in 22, not the permanent group abstraction. A bounded mesh is the first prototype topology. Other adapters, including possible Pear ecosystem components, are research only; Keet does not imply a usable distribution API. None is an additional assigned WISP, an approved custom gossip algorithm or a ready integration.

## Initial topology proposal

Start with a private group using one explicitly identified membership coordinator/admission authority. This serializes admission and policy changes; it is a trust and availability tradeoff, not a central Ghost service. The coordinator may run on a member's device. Loss/offline status pauses membership changes; remaining peers may continue an already-established epoch where policy permits. There is no silent leader election or privilege transfer.

For the first interoperability prototype, propose a bounded full mesh of authenticated pairwise data sessions between members, capped at eight online members for testing, not as a measured product limit. All must support the selected common application/security profile; participants without it fail admission clearly. Full mesh has quadratic connection cost and is not a scale claim. Larger/private routing can negotiate 22 after measurement. Existing 1:1 WebRTC can inform the prototype but is not already a group implementation.

Relays and a coordinator need not decrypt application payloads merely to deliver them. If a coordinator is also a group member, it can read content by membership. Any elected delivery/storage peer has explicitly selected retention and traffic visibility. Group media, SFUs and public lobbies are separate profile decisions, not consequences of text routing.

## Session descriptor and agreement

Candidate descriptor semantics: logical group ID, descriptor revision, authorized coordinator key, participation roster/roles, admission policy, required capabilities and exact versions, chosen delivery/security profile, limits and current membership epoch reference. Keep descriptor and roster OFF the DHT; obtain them over authenticated admission/session connections. Pin the initial authority from the invitation and verify updates against the previous authorized state.

Each participant checks the descriptor against local privacy/security policy before accepting. The coordinator proposes a deterministic common profile using a declared preference order; all admitted participants must acknowledge the compatible result for the prototype. Required incompatibility cannot be bypassed by silently weakening encryption or enabling a relay. Time out missing acknowledgements and explicitly abort or restart with a revised candidate membership; do not claim consensus from silence.

Descriptor revision, transport attempt and cryptographic epoch are different counters. A network reconnect need not change membership; a membership change must update the group security state. Bind accepted policy/roster/profile to the authenticated group context using the selected security protocol's supported mechanisms. Exact encoding and transcript construction are blockers.

## Security profile: evaluate MLS, do not invent group crypto

[MLS (RFC 9420)](https://www.rfc-editor.org/rfc/rfc9420.html) provides group key establishment with epochs and membership changes. It is the candidate to evaluate, not an implemented dependency or an automatically inherited security guarantee. Select a maintained implementation, credentials, cipher suite and delivery integration; verify its required state deletion and commit processing. Authentication, application policy and delivery still need a Ghost profile.

Proposed flow using that candidate:

1. **Create:** creator initializes group security state and admission policy. Pin group/authority context locally.
2. **Join:** 20 verifies a unique participation and local consent. An authorized membership change produces the new epoch and admission material via the selected security protocol. Deliver that material privately through the authenticated join path; never in DHT/gossip plaintext.
3. **Activate:** joiner verifies the authorized group context and initializes the accepted epoch before sending. Existing members apply the ordered membership change before accepting application data for that epoch.
4. **Leave/remove:** accept only a policy-authorized change, advance the security epoch and stop delivering new epoch secrets to the removed participation. Rotate delivery authorization/topic material as specified by the routing profile. Removal cannot erase old history or prevent an authorized insider forwarding new content.
5. **Reconnect:** retain membership identity, authenticate a fresh data connection and obtain missing authorized state transitions from an available peer. A peer unable to safely catch up must rejoin explicitly; never invent an epoch key from a public descriptor.

The MLS-derived behavior above is conditional on a validated integration. Single epoch secrets copied to every invite, reuse of a legacy pairwise seed, or transport encryption alone MUST NOT be presented as this group security profile.

## Ordering, partitions and concurrent changes

Membership changes require one accepted ordered sequence for the prototype. Coordinator serializes candidate changes and records committed state durably; peers reject unauthorized/stale branches. Exact interaction with the security protocol's commit rules must be specified, rather than assuming the coordinator replaces cryptographic validation. Conflicting valid branches halt new membership progression and surface a resynchronization requirement; there is no invented merge or automatic fork winner in this draft.

Application messages use sender-scoped IDs and declared per-sender ordering from 400, with epoch context and bounded replay/deduplication state. No total chat order is promised. Bound buffering of future-epoch messages while awaiting state, and bound retention of previous-epoch state according to the reviewed security profile. Removed/offline peers do not automatically get future keys. A re-admitted member is a fresh admission, with an explicit history policy.

## Offline delivery and bulk data

Initial prototype promises live delivery only. Local history remains on devices. Optional encrypted store-and-forward needs an explicit selected peer/service, quota, expiry, consent, gap detection and replay policy. If no peer retained a missing message, report the gap. DHT TTL does not create an offline archive. New members get no old history by default; sharing old content is a separate authorized application action.

Files are announced with bounded metadata and fetched over a negotiated data session; media uses a separately supported profile. Payments remain individually addressed and authorized. Local services require host audience consent; being in a group is not blanket localhost access.

## Moderation and resource limits

Initial authority may approve/reject joins and remove members under visible group policy. Local blocking/muting remains separate from group removal. Rate-limit join attempts, membership changes, verification work and message ingress. Validate membership/epoch before expensive application processing, bound queues and disconnect abusive sessions. A public “The Haunt” needs additional spam/Sybil evaluation; no anonymous/public-scale abuse solution is claimed.

Prototype proposals to validate: eight members, 16 KiB application-message ceiling, 64 buffered future-epoch messages with a 1 MiB total-byte cap, and bounded per-peer connection/verification queues. Numeric timeouts, history windows, rate limits and larger-group targets remain blockers, not production defaults. Group coordination failure must be visible. Authority transfer requires approval under the pinned policy and security profile; loss of the sole authority otherwise means re-forming/re-inviting, not takeover by the next online peer.

## Compatibility and open decisions

Legacy 1:1 clients remain pairwise clients; no auto-upgrade to groups. Before Proposed: choose and pin MLS implementation/profile; define signed descriptor encoding and authority transitions; resolve commit/descriptor atomicity and forks; fix bounds/timeouts; select browser/native routing and mobile background behavior; validate coordinator recovery, removal and offline catch-up; measure mesh/GossipSub costs. External identity proofs are optional per group policy and do not replace membership-key authentication.

## Conformance

Two independently implemented group clients must create/join with a third participant, send in one epoch, concurrently request joins, remove a member, reject old-epoch/replayed/unauthorized traffic and reconnect after missed updates. Test partitions, forked membership state, coordinator loss, unsupported capability, topic leakage, bounded invalid-message floods and history gaps. Removal must exclude the old member from new secrets under the tested threat model. Report versions, topology, bounds, failures and security review; no success is claimed now.

## References

[Invite/admission](800-invite-join.md), [keys](02-peer-keys.md), [chat](400-chat.md), [GossipSub candidate](901-gossipsub.md), [interoperability gates](INTEROP.md).
