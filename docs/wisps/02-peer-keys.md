# WISP 02: Peer Keys

| Field | Value |
|---|---|
| Candidate number | 02; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-20 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [01](01-ghost-core.md) |
| Implementation | Existing per-link keys; lifecycle extensions proposed |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Local experimental increment

The follow-up adds transcript-negotiated signed signaling, durable per-message delivery/retry state and observed extension interoperability; see the [implementation profile](PAIRED-CHAT-INCREMENT.md) for exact partial coverage and residual risks. This does not change Draft status.

The opt-in [paired chat increment](PAIRED-CHAT-INCREMENT.md) now exercises a limited subset of this draft. It is not full conformance or a replacement for the broader candidate design below. Read its exact wire profile, local admission boundary and limitations separately from the legacy baseline.

## Purpose and existing behavior

Give each participation its own key and distinguish its lifetime from an individual network session. Today `createLink` generates two Ed25519 identities and one symmetric link key. The creator initially knows both seeds. Browser link state persists locally; reconnecting reuses the same link keys. These are scoped keys, not keys that automatically disappear on disconnect.

## Candidate key lifecycle

| Object | Scope and lifetime | Rotation/loss behavior |
|---|---|---|
| Channel ID | Logical relationship or group; not a credential | Remains stable through reconnects; no authority by itself |
| Invite secret | Admission attempt or explicitly bounded multiuse policy | Consume/revoke via 20; never treat a channel ID as an invite |
| Participation key | One local persona's participation in a channel | Persist until explicit removal/rotation; never reuse across channels by default |
| Session keys/ID | One authenticated connection attempt | Fresh context on reconnect; old transcript cannot authorize a new attempt |
| Group epoch state | One accepted membership state | Changes through the reviewed group security protocol in 21 |
| External identity | Optional proof provider | Does not replace participation authorization or recover it automatically |

Participants SHOULD generate their own participation keys after bootstrap rather than inherit the legacy invite seed. Bind replacement keys to the authenticated old context, peer approval and fresh handshake. Exact key agreement, derivation, erasure and wire encoding remain blockers; this draft does not invent a ratchet or claim forward secrecy.

Clients MUST document where secrets persist and what export/backup exposes. Deleting local state does not revoke copies held elsewhere. Revocation requires the other participants to accept a new authorized membership/key state; an offline or hostile peer cannot be forced to erase data.

A lost participation key means loss of that participation unless an explicitly configured recovery policy exists. Initial proposal: re-invite/re-admit with a visible identity change, not silent account recovery via Nostr/Pubky. Compromise recovery without a trusted surviving key requires out-of-band confirmation. Rotation cannot retroactively hide ciphertext encrypted under a compromised old link secret.

## Compatibility, security and open decisions

Legacy invites disclose one seed and the symmetric key; hiding the invite UI is not rotation. Do not describe that format as a consumable credential. Decide approved handshake primitives, key export UX, atomic durable rotation, rollback detection, multi-device policy and recovery before Proposed. The same Ed25519 key type across systems does not justify reusing secret bytes for other protocols.

## Conformance

Restart/reconnect without reopening an invite; rotate without accepting replayed old bindings; lose state without silently creating continuity; test crash during rotation and external-proof revocation. Negative cases include a copied invite and a replaced participation key. See 800 and 21 for admission/removal cases.

## References

[Identity](../../packages/core/src/identity.ts), [invite](../../packages/core/src/invite.ts), [local storage](../../packages/browser/src/engine/db.ts), [peer proofs](300-peer-proofs.md).
