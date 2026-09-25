# WISP 801: Implemented Invitation Profiles

| Field | Value |
|---|---|
| Candidate number | 801; editorial family allocation |
| Status | Draft |
| Revision | 0.2 |
| Updated | 2026-09-25 |
| Document kind | Profile |
| Dependencies | [800](800-invite-join.md), [400](400-chat.md), [403](403-dht-text.md) |
| Implementation | Today: `pair1/` and `pair2d/` creation plus v0.4 imports. Proposed: one format, `pair3/`, and the reading rules below |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## One invite format (revision 0.2)

A current app creates exactly one kind of invite, for the one chat of [400](400-chat.md). There is no "Live chat" or "Text only" choice: how the chat is carried is decided after the handshake, and can be changed per chat at any time.

```text
pair3/<joining-seed>/<inviter-rendezvous-key>/<invite-secret>
```

| Field | Encoding | Meaning |
|---|---|---|
| `pair3/` | Literal prefix | The invite format and its version: `pair` and a decimal version, `3` here |
| `joining-seed` | 43 characters, unpadded base64url (32 bytes) | The joiner's rendezvous seed for this chat |
| `inviter-rendezvous-key` | 52 characters, z-base-32 | The inviter's rendezvous public key |
| `invite-secret` | 43 characters, unpadded base64url (32 bytes) | The shared secret: seals pre-pin records and derives the mailboxes, the capability records and the hold pointer |

The three fields keep the lengths and validation every earlier format used. The invite may be wrapped in a link: everything up to a `#`, then an optional `chat/` or `/chat/`, is ignored, as today. It carries no participation key and no private key beyond the joining seed.

**What the joiner does with it.** It stores the fields and a fresh participation key, then starts both first contacts at once: the first-contact envelope on the DHT ([403](403-dht-text.md#first-contact)) with its capability record ([03](03-capabilities.md#layer-0-capability-record)), and a stream attempt ([100](100-transports.md)). This first action is what changed from `pair1/`, and it is why the version changes: a `pair1/`-only app handed this code would wait for a stream alone.

A copied invitation is a bearer capability; hiding a saved invite after a message does not invalidate other copies. Participation keys are authenticated and durably pinned; possession of an invite can still compete for first admission, and comparing the displayed code verifies the pin separately. Reconnect uses the stored relationship and fresh session context.

## Reading an invite

A current app reads an invite by these rules, in order. It never guesses: a code is one format or it is refused with a reason.

| Input | Result | Message when refused |
|---|---|---|
| `pair3/` with three valid fields | A new chat of [400](400-chat.md) | |
| `pair1/` with three valid fields | A new chat of [400](400-chat.md). It was made by a pre-0.5 build that expects a stream first; the DHT first contact still runs, and works once that build reads its mailbox | |
| `pair2d/` with three valid fields | A new chat of [400](400-chat.md), `dht-chosen` by the contact: that build chose DHT only and says so in its envelopes, until someone leaves it | |
| No prefix, three valid fields | A **compatibility chat** ([402](402-legacy-chat.md)): the code came from Ghostly 0.4 or the CLI, which speak only that profile | |
| `pair` followed by a version above 3, or by a version this app does not know (`pair4/`, `pair2x/`) | Refused; nothing stored | "This invite was made by a newer Ghostly. Update to join." |
| Any other `<letters><digits>/` prefix | Refused; nothing stored | "This invite was made by a newer Ghostly. Update to join." |
| Anything else, or a known prefix with a malformed field | Refused; nothing stored | "This is not a Ghostly invite." (with the field that failed, when the prefix was known) |

A refused code MUST NOT be retried as another format: a `pair4/` code is never read as prefix-less, and a malformed `pair3/` code is never read as `pair1/`.

**Older apps reading a `pair3/` code.** Ghostly 0.4 and the CLI read only prefix-less codes; a `pair3/` code splits into four parts, which their parsers refuse as an invalid code. Pre-0.5 development builds read `pair1/` and `pair2d/` only and refuse it the same way. Neither can say "update"; that message can only come from apps that implement the rule above, which is why the rule is written now.

**Creating.** A current app only creates `pair3/`. It never creates a prefix-less code, so a contact on 0.4 cannot join a chat a current app starts; the 0.4 contact can start one instead (a compatibility chat), or update.

## Versioning from here

- The prefix version changes only when the invite's fields, or what the joiner must do first, change incompatibly. Anything that can be negotiated after the first contact (capabilities, transports, extensions) is negotiated there ([03](03-capabilities.md)), not added to the invite.
- A new version is `pair<N>/` with the next integer. Every app keeps reading each older version it can map to a chat, and refuses newer ones with the update message.
- Adding a field to an existing version is not allowed: a longer `pair3/` code is malformed, not extended.

## Boundary with the common contract

The stronger single-use admission state machine, atomic global use limits, group admission and authority coordination in [800](800-invite-join.md) remain proposed. This profile does not make those promises. Group invites (`group-entry/1`, `group-community/1`) have their own formats ([9xx group mesh](9xx-group-mesh.md), [9xx group community](9xx-group-community.md)) and are not changed by this revision.

## Open decisions

| # | Question | Recommendation |
|---|---|---|
| Q8 | A new prefix `pair3/`, or keep `pair1/` and change what it means? | **`pair3/`.** A `pair1/`-aware build that took the code would pair only when a stream connects, silently missing the new first contact. 0.5 is not released, so no public app has made a `pair1/` code yet. |
| Q9 | Should `pair3/` also carry the inviter's participation public key (52 more characters)? | **Yes, if accepted before 0.5 ships** (`pair3/` has never been emitted, so it can still change without a version bump). The joiner could then pin the inviter from the code, and someone else holding a copy could no longer answer as the inviter. Otherwise leave it to the admission work of [800](800-invite-join.md). |
| Q10 | Offer "Invite someone on Ghostly 0.4" (make a prefix-less code)? | **No.** The web app is replaced by 0.5 on release; desktop users on 0.4 can make the code themselves or update. |

## Evidence and checks

[Invite encoding](../../packages/core/src/invite.ts), [paired bootstrap](PAIRED-CHAT-INCREMENT.md), [DHT invitation binding](../DHT-DELIVERY.md), [client join lifecycle](../../packages/browser/src/engine/node.ts). Test round trips of `pair3/`; reading `pair1/`, `pair2d/` and prefix-less codes; refusal of `pair4/`, `pair2x/`, `abc1/`, a five-part `pair3/` code and each malformed field, with nothing stored; duplicate local joins; key substitution; reconnect without losing history.

## Revision log

- 0.2 (2026-09-25): one invite format, `pair3/`; reading rules and messages both ways; versioning rule; Q8 to Q10.
- 0.1 (2026-09-22): `pair1/`, `pair2d/` and legacy imports.
