# WISP 801: Implemented Invitation Profiles

| Field | Value |
|---|---|
| Candidate number | 801; editorial family allocation |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-22 |
| Document kind | Profile |
| Dependencies | [800](800-invite-join.md) |
| Implementation | Current modern pair1/pair2d creation plus legacy imports. |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Concrete formats

Modern `pair1/` invitations choose streams initially; `pair2d/` chooses DHT-only. They bootstrap the same conversation, participation identity, durable peer pin and message history. Legacy connection strings remain readable and carry a joining seed, creator public key and encryption key. A copied invitation is a bearer capability; hiding a saved invite after a message does not invalidate other copies.

Modern peers authenticate and durably pin participation keys; possession of an invite can still compete for first admission. Comparing the displayed code separately verifies the pinned relationship. Reconnect uses the stored relationship and fresh session context. Keep parsing/version selection explicit and do not silently convert existing chats.

## Boundary with the common contract

The stronger single-use admission state machine, atomic global use limits, group admission and authority coordination in [800](800-invite-join.md) remain proposed. This implemented profile does not make those promises. Group invites must not be presented as shipped merely because the UI has New/Join.

[Invite encoding](../../packages/core/src/invite.ts), [paired bootstrap](PAIRED-CHAT-INCREMENT.md), [DHT invitation binding](../DHT-DELIVERY.md), [client join lifecycle](../../packages/browser/src/engine/node.ts). Test parse/version round trips, legacy imports, duplicate local joins, key substitution and reconnect without losing history.
