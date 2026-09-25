# WISP 800: Invite and Join

| Field | Value |
|---|---|
| Candidate number | 800; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.2 |
| Updated | 2026-09-25 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [01](01-ghost-core.md), [02](02-peer-keys.md) |
| Implementation | Existing bearer invite; admission protocol proposed |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## One invite for the one chat (revision 0.2)

Every new 1:1 chat starts from the same invite ([801](801-invitation-profiles.md#one-invite-format-revision-02)): `pair3/` and three fields. The invite no longer chooses how the chat is carried; the handshake does, on the DHT and on a stream in parallel ([400](400-chat.md#how-a-chat-starts-upgrades-falls-back-and-comes-back)). Its version lives in the prefix, and the error rules go both ways: a current app refuses a newer version with "update to join" and never downgrades it; an older app refuses a `pair3/` code as invalid. v0.4 codes (no prefix) still open a compatibility chat ([402](402-legacy-chat.md)). The admission requirements below are unchanged by this revision.

## Contract and concrete profiles

This document defines common responsibilities and proposed extensions. Exact implemented encodings and runtime limits belong to [801 · Implemented Invitation Profiles](801-invitation-profiles.md). Supporting a concrete profile does not establish full conformance to this Draft.

## Local experimental increment

The follow-up adds transcript-negotiated signed signaling, durable per-message delivery/retry state and observed extension interoperability; see the [implementation profile](PAIRED-CHAT-INCREMENT.md) for exact partial coverage and residual risks. This does not change Draft status.

The opt-in [paired chat increment](PAIRED-CHAT-INCREMENT.md) now exercises a limited subset of this draft. It is not full conformance or a replacement for the broader candidate design below. Read its exact wire profile, local admission boundary and limitations separately from the legacy baseline.

## Baseline and purpose

A current connection string carries a joining seed, creator public key and shared encryption key. Joining restores those credentials. The browser hides its saved invite after receiving a message; it does not invalidate copies of the secret. Local duplicate detection is not global single-use enforcement. Consumable 1:1 invitations below are a NEW admission design, not a property of that legacy string.

## Objects and trust boundary

Keep channel ID, invite ID/secret, participation public key and session ID distinct. A channel ID identifies context and grants no access. A private invite bootstraps admission but is not the permanent identity. A group invitation never distributes one shared signing seed to all members.

Candidate invitation semantics: mode (single-use pair / bounded multiuse group), expected channel, issuer/admission authority key, expiry, remaining-use policy, supported admission profile and optional expected-peer proof/confirmation. This is a semantic list, not a wire encoding. Do not put long-lived participation private keys in a new-format invite.

## Candidate single-use 1:1 state machine

`issued → pending → confirmed/consumed`, or `issued/pending → expired/revoked`.

1. Joiner generates its own participation key and proves possession over a fresh challenge and invite/channel context. A reviewed authenticated key exchange establishes new relationship secrets; the exact construction remains a blocker.
2. Issuer validates the private invite and presents the candidate for expected-person confirmation (out-of-band comparison or an allowed external proof). Arrival order alone must not claim to identify the intended person. A thief who received the invite first remains a real pre-pairing risk.
3. Issuer serializes admissions in durable local state. At most one pending winner can become a consumed binding; other attempts receive a bounded busy/consumed result. Both peers confirm the agreed participation keys and store the final binding before treating the relationship as established.
4. Retries for the SAME authenticated candidate return its pending/final result. A crash between commit and response cannot reopen admission. An abandoned pending attempt may expire, but reopening requires fresh confirmation; never automatically transfer approval to a different candidate.
5. Reconnect authenticates the stored participation keys with fresh session context. It MUST NOT reconsume or reactivate the invite. Revoke the bootstrap secret's authority and discard it where possible; records encrypted with that old secret are not retroactively protected.

This proposal assumes one online admission authority, not DHT compare-and-swap or global atomic storage. Supporting multiple issuer devices requires a specified coordination mechanism. A partitioned copy of issuer state cannot safely make independent single-use decisions.

## Group invitation and join

A multiuse group invite authorizes a request, not immediate access to content. It has an explicit expiry/use limit/revocation policy and an authenticated admission endpoint. Each joiner has a distinct participation key; 900 handles the membership commit and encrypted epoch welcome. Count uses atomically when admission commits. Denied/expired joins receive no group epoch secrets. Bound pending requests per source/invite and rate-limit verification work.

Private admission can contact an online inviter through the invite bootstrap. Public join discovery needs a separate validated ingress route; do not turn the DHT into an unbounded shared inbox. “The Haunt” is a possible public demonstration, not a required launch surface. Public invites need a deliberate abuse policy.

## Compatibility, security and open decisions

New format/version must be visibly distinct, and an app that does not know a version must say so rather than read it as another ([801](801-invitation-profiles.md#reading-an-invite)). Legacy imports keep their documented copied-secret risk; silently labeling them consumed is forbidden. Resolve the reviewed bootstrap/key-agreement profile, confirmation UX, durable commit protocol, limits/timeouts, acknowledgement recovery and public ingress before Proposed. Group authority loss/transfer follows 900. No proof of intended human identity comes merely from a successful handshake.

## Conformance

Race two different joiners, replay consumed invites, duplicate the same join retry, crash before/after durable commit, lose final confirmation, expire pending state, revoke before admission, reconnect after invite expiry and attempt admission from stale issuer state. For groups, exhaust use limits and reject removed participants trying an old invite without fresh admission policy.

## References

[Legacy invite](../../packages/core/src/invite.ts), [browser join and invite display lifecycle](../../packages/browser/src/engine/node.ts), [peer keys](02-peer-keys.md), [group sessions](900-group-sessions.md).

## Revision log

- 0.2 (2026-09-25): one invite for the one chat; version in the prefix; refusal rules both ways (details in 801).
- 0.1 (2026-09-20): initial review draft.
