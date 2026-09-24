# WISP 9xx — Group Mesh Distribution Profile

| Field | Value |
|---|---|
| Number assignment | 9xx; planned, number to be defined |
| Status | Draft |
| Revision | 0.3 |
| Updated | 2026-09-24 |
| Document kind | Profile |
| Dependencies | [02](02-peer-keys.md), [03](03-capabilities.md), [400](400-chat.md), [401](401-paired-chat.md), [800](800-invite-join.md), [900](900-group-sessions.md) |
| Implementation | `group-mesh/1`: core protocol in [`packages/core`](../../packages/core/src/groupSession.ts) and, for the group's link (`group-entry/1`), [`groupEntry.ts`](../../packages/core/src/groupEntry.ts); engine, UI and four-browser e2e in [`packages/browser`](../../packages/browser/src/engine/groups.ts) and [`e2e/web/groups.spec.ts`](../../e2e/web/groups.spec.ts); web, extension and desktop share it |

> This Draft documents the first distribution profile of [900](900-group-sessions.md) as implemented, not full contract conformance or an independent implementation certification. Numbers and wire formats are not registered standards.

## What this profile is

`group-mesh/1` lets up to eight members exchange **text** over a full mesh of pairwise, authenticated data sessions, with a membership chain and epoch keys that exclude removed members from everything sent after their removal and admitted members from everything sent before their admission. It is the bounded mesh prototype 900 asked for, with three decisions made explicit:

1. **Topology: a mesh of dedicated pairwise edges, derived from the roster.** Every pair of members runs one [paired-chat/1](401-paired-chat.md) link of its own, whose rendezvous identities and discovery key both sides derive from the X25519 secret of their member keys and the group id (`edgeParams` in [`groupCrypto.ts`](../../packages/core/src/groupCrypto.ts)). Nobody distributes edge parameters, nobody but the two members can compute them, and the edge's paired session is pinned in advance to the member keys the roster names, so admission of a member is the only trust step. Edges are WebRTC only in this increment; native transports are not offered on them.
2. **Delivery: the author sends to every member directly, and only the author re-sends.** A message goes over each open edge. A member whose edge is down gets it later from the author's bounded log (32 messages, 128 KiB), never from a third member, so per-sender order and gap detection stay honest ([400](400-chat.md)). There is no relay, no store-and-forward and no promise of delivery to a member nobody meets again.
3. **Coordinator: exactly one admin per epoch.** The admin signs every membership commit; there is no election. The role is transferred by a commit; an admin who loses its key leaves a group that can only be re-formed, as 900 says.

Payments between two members are part of it (§ Payments): the money travels on their edge, the group sees a note. Files, media, calls and local services are not part of this profile and are refused in groups.

## Keys and epochs

| Object | Lifetime | Who knows it |
|---|---|---|
| Member key (Ed25519) | The member's participation in one group; never reused across groups | Public in the roster; seed only on the member's device |
| Epoch secret (32 random bytes) | One membership state | Every member of that epoch; sealed to each with an ephemeral X25519 exchange against their member key |
| Epoch message key, confirm key | Derived from the secret with HKDF-SHA-256, salted by group id and epoch | Same |
| Edge parameters | The pair, for the life of the group | The two members only |

The committer generates a fresh secret for every commit (admission, removal, role transfer, rotation) and seals it to each member of the **new** roster. A removed member is sent the commit, so it learns it is out, without a secret. A new member's welcome carries the secret of the epoch that admits it and nothing earlier. Secrets of the last sixteen epochs are kept so a member can hand them on during catch-up; older epochs become unreadable.

The commit carries a **confirmation tag**: HMAC-SHA-256, under the epoch's confirm key, of the commit without its tag. A member that unseals a secret checks the tag before keeping it, so a member relaying a secret cannot hand out a wrong one, and the admin's signature covers the tag.

**What this gives and does not give.** Forward secrecy at the granularity of an epoch: a secret leaked later exposes that epoch. Post-compromise security through rotation: after removal or a rotate commit, whoever held the old secret and is not in the roster learns nothing new. A compromised **member seed** is not healed by rotation, because member keys are static: the member must be removed, and its edges with it. This is the deliberate simplification over MLS (see 900 § Security profile); it is adequate for eight members and reviewable in a few hundred lines.

## Membership chain

A commit is `{ v, g, e, p, k, m, by, s?, ts, c, sig }`: version 1, group id, epoch (its index in the chain), the hash of the previous commit (empty for the genesis), a kind (`create`, `add`, `remove`, `role`, `rotate`), the whole roster after it as sorted `[key, role]` pairs, the committer, the member concerned, a timestamp, the confirmation tag and the committer's Ed25519 signature over the canonical tuple `[v, g, e, p, k, m, by, s, ts, c]`. The hash is SHA-256 of that same tuple.

Rules a receiver enforces, in this order: shape (at most eight members, exactly one admin, sorted, distinct), group id, `e` is the next index, `p` matches, the committer is the admin of the previous roster, the roster is exactly the previous roster with the change applied (an admin cannot remove or demote itself; `rotate` names nobody), and the signature verifies. A chain is verified from its genesis; a chain is at most 1024 commits.

**Trust anchor.** The invitation arrives over the inviter's authenticated contact chat, naming the inviter's member key as the admin. The welcome's chain must admit the joiner in a commit signed by that key. Everything else about the roster is what the admin says: a member key with no owner never connects and never signs, but its presence in the list is the admin's claim.

**Forks.** Two validly signed commits after the same epoch halt the group on every member that sees both: status `forked`, no sending, no further commits, re-form the group. A bare claim (a `group-sync` naming a different hash) is not evidence; it is answered with the commit for that epoch, so only a validly signed conflicting history forks anyone.

## Admission and departure

```
inviter → contact:  { "t": "group-invite", "g", "name", "admin", "e", "n" }
contact → inviter:  { "t": "group-accept", "g", "key" }   |   { "t": "group-decline", "g" }
inviter → contact:  { "t": "group-chain", "g", "commits": [ … ] } *   (24 commits at a time, when the chain is long)
inviter → contact:  { "t": "group-welcome", "g", "name", "commits": [ … ], "secrets": [ { "e", "s": <sealed> } ] }
```

The invitee generates its member key on accepting. The admin commits `add`, tells the existing members over their edges, and sends the welcome over the contact chat. The joiner verifies the chain, unseals and confirms the secret, then opens edges to every other member. Being in the roster is the only admission; the contact chat is only the authenticated path that carried it.

### Entry link (`group-entry/1`)

An admin can also hand out **one link that anyone may use**, so people who are not their contacts can join, without a contact chat and without saying who they are:

```
group1/<group id>/<entry key>          (in the web app: https://…/#/join/group1/<group id>/<entry key>)
```

The **entry key** is an Ed25519 key the admin makes for the link and for nothing else; its seed stays on the admin's device. From the link alone every holder derives the same **knock identity** (seed = HKDF-SHA-256 over the entry key, salted by the group id, info `ghostly-group-entry/1 knock seed`) and a knock key (info `… knock key`).

1. The joiner generates its member key for the group and publishes, under the knock identity, a `_knock` record: the latest knocks `[[member key, ms], …]` (at most six, each fresh for three minutes), sealed with XChaCha20-Poly1305 under the knock key with the group id as associated data. It reads the record first and keeps other joiners' fresh knocks, since everyone holding the link writes the same Pkarr key; it republishes every five seconds (every twenty after two minutes) until the admin's side of its entry session shows up, and again if that side goes away. Its app shows how far it got: knocking, knocked, answered (the admin's side is there), let in, then connecting to the members until the first edge is up.
2. The admin's app reads the knock identity every five seconds, and every two for ten minutes after the link was handed out or someone knocked (people open a link in the minutes after it is shared, and in bursts). For every fresh knock that is not a member, not already in progress and not recently timed out, while the group has room, it opens an **entry session**: a paired-chat/1 link whose rendezvous identities and discovery key derive, exactly like an edge, from the X25519 secret of the entry key and the joiner's member key, under the salt `entry/<group id>` so it never coincides with an edge. Each side pins the other in advance: the admin the knocked member key, the joiner the entry key. At most four run at once; one that does not finish within three minutes is closed and its key not answered for ten.
3. On the open session the ordinary admission runs: `group-invite`, then `group-accept` (sent at once: opening the link was the joiner's consent) whose `key` must be the member key the session is pinned to, then the welcome. The joiner closes its side when it has joined; the admin closes its own shortly after sending the welcome. Both sides of an entry session poll fast while it comes up (the other side is due any moment), and so do the admin and the new member on the edge between them, which they open right after; other edges come up at the ordinary pace. An entry session is never a contact chat: nobody records it as one, and courtesy notices do not use it.

**Trust anchor.** The entry key the link named. The session is pinned to it, so the admin who invites over it is whoever holds its seed, and the welcome must admit the joiner in a commit signed by the member key that invitation named, as for a contact's invitation.

**Revocation.** The admin turns the link off, or replaces it with a new entry key; knocks under the old knock identity are then read by nobody. The link also stops working when its admin stops being the admin (the app turns it off): a new admin makes its own.

**What it gives and does not give.** The link is a bearer capability: whoever has it joins while it is on and the admin's app is open, as many people as the group has room for, and the admin cannot tell who they are beyond the name they announce. Relays see a Pkarr key and an opaque value, then ordinary paired signaling; neither the group id nor the member keys appear on them. Holders of the link can read each other's pending member keys and can overwrite each other's knocks (they are republished), which is a nuisance, not a way in. There is no approval step, expiry or use count in this increment; those are open decisions.

A member leaves by wiping its secrets at once and sending `{ "t": "group-leave", "g" }` to the admin, over their edge and over their contact chat when there is one, and the admin commits `remove`. The app drops the group and its history from the device at once; it keeps only a tombstone (the member key and the edge to that admin) until the admin's `remove` commit, or its `group-removed` on the contact chat, comes back, and repeats the leave whenever that edge opens, for at most a week. An admin with other members hands the role to one whose edge is up (a `role` commit) and then leaves like anyone else; with nobody reachable it cannot leave, since the role commit would reach no one. The last member leaving simply deletes the group. Removal is a `remove` commit; the removed member is told over its edge and, as a courtesy, with `{ "t": "group-removed", "g" }` over the contact chat when the remover has one. A removed member that was offline for both is not told; it sees the group go silent.

## Messages

```
{ "t": "group-msg", "g", "e", "s": <sender member key>, "n": <sequence in epoch>, "ts", "nn": <nonce>, "c": <box>, "sig" }
```

Text is trimmed UTF-8 of at most 16 KiB, encrypted with XChaCha20-Poly1305 under the epoch message key with the JSON of `[g, e, s, n, ts]` as associated data, then signed by the sender over `["ghostly-group/1 msg", g, e, s, n, ts, nn, c]`. Sequence numbers start at 0 in every epoch and are the sender's; the stable id of a message is `<sender>:<epoch>:<sequence>`.

A receiver accepts a frame only from the edge of the member it names as sender; only for an epoch the sender and the receiver were both members of; only once per `(sender, epoch, sequence)`, remembering the highest sequence and the 256 below it per sender and epoch; and only with a valid signature and a ciphertext that opens. A frame for an epoch ahead of the receiver's chain, or one whose secret has not arrived, waits (64 frames, 1 MiB) while the receiver asks the sender to catch it up, at most once every ten seconds per member. Anything else is dropped without a reply.

## Catch-up

When an edge opens, each side sends what it knows:

```
{ "t": "group-sync", "g", "e", "h": <hash of my top commit>, "have": { <sender>: { <epoch>: <highest seq> } }, "secrets": [ <epochs I hold> ] }
```

The side that is ahead answers with the commits the other lacks (each with the secret sealed for the other when it was in that epoch's roster and the secret is still held), `{ "t": "group-secrets", "g", "secrets": [ … ] }` for epochs the other was in but does not hold, and its **own** messages above the other's `have`, from its bounded log and only for epochs the other was a member of. A member behind on the chain asks in turn. Gaps below the highest sequence that no author fills are reported per sender (`missing`), not hidden.

## Payments

A payment in a group is a payment **between two members**, carried by the edge between them, plus a **note** the rest of the group sees. Nothing about the money ever crosses a third member.

**On the edge.** An edge is a paired-chat/1 link ([401](401-paired-chat.md)): it offers and negotiates the ways of paying exactly as a contact chat does ([200](200-payments.md), `paired-payments`), and carries the ordinary frames (`pay-ask`, `pay-req`, `pay`, `pay-res`). So a member pays or asks another member on any rail both of their apps allow, through the same review and explicit approval as a chat; the receipts and the reclaim of unredeemed ecash are the chat's. An app whose edges offer no payments (older ones) negotiates none, and the other side says it needs an update.

**A request to the whole group** (`f` = `*`) is one request, with one id, sent as a `pay-req` on every edge (and again to a member whose edge opens later), that any member may pay **once**:

1. **One rail.** Cashu *or* Lightning, never both, because each enforces "once" on its own and two together could each be paid. A Lightning request carries one invoice: an invoice is paid at most once. A Cashu request names the payee's mints.
2. **First valid payment wins.** The payee's app handles the tokens for one request one after the other. Before redeeming a token it checks that the request is still open and that the token would settle it (amount, mint); if not, it answers `pay-res` with `ok: false` and **does not redeem it**, so the payer's app takes its ecash back as for any refused payment. The first token that is redeemed settles the request.
3. **Everyone's copy closes.** When the request settles (a token redeemed, or the payee's own wallet seeing the invoice paid), the payee sends `pay-res` `{ id: <request id>, ok: true }` on every edge; a member's copy of the request is then paid and cannot be paid again. A member whose edge was down gets that receipt when it opens.
4. **Idempotent receipts.** A token sent again is answered from what was recorded (redeemed once, never twice); a receipt for a request already closed changes nothing; a refused token is refused again.

**The note.** Each side tells the group about its own part, on every edge:

```
{ "t": "group-pay", "g", "id", "k": "req" | "pay", "f": <payer key> | "*", "to": <payee key>,
  "v": <amount, smallest unit>, "u": <unit>, "d": <decimals>, "r": "cashu" | "lightning" | "arkade" | "bark" | "bitcoin" | "usdt",
  "x"?: 1 (test money), "m"?: <memo, 140 chars>, "a"?: 1 (answers the payer's own ask), "ts", "st": "open" | "sent" | "paid" | "closed", "by"?: <payer key> }
```

A receiver takes a note only from the member it is about, as authenticated by the edge it came on, and only when every key it names is in the roster: a request's state (`open`, `paid`, `closed`) and a payment's `paid` from the **payee**; `sent` (and `closed`, taking it back when its payment came back) from the **payer**, about itself (`by` = the author). The payee's description of a request, and the payer's of a payment, win over anyone else's; states only move forward and `paid` is final. For an invoice the payee's wallet cannot tell who paid: when exactly one member said `sent`, that member is named; otherwise the note says only that it was paid. Each device keeps the latest note it said per payment and says it again when an edge opens (its last 32). A note is information, never proof: the payee's wallet is the only thing that marks a request paid, as in a chat.

**What it gives and does not give.** The group sees who paid whom, how much, over what and a memo, and nothing to pay with (no invoice, address or token). Members see each other's amounts: payments in a group are not private from the group. A member's note is its own word; a lying payer can claim `sent`, and the request stays open until the payee's wallet says otherwise. A request to the group on an irreversible rail (Ark, Bark, on-chain, USDT) is not offered, since nothing could refuse a second payment.

## Compatibility

Groups are announced after the paired handshake, on the open session, as `{ "t": "paired-groups", "v": [1] }`, the way `paired-payments` is, so a full handshake offer stays within the sixteen capabilities older apps accept. An app without groups drops the announcement and every `group-*` frame (they carry no `id`), keeps chatting 1:1, and is shown as needing an update to be invited. No 1:1 behavior changes. Payments on edges came after groups (revision 0.3): an app from before offers none on its edges, drops `group-pay`, and simply sees no payments; nothing else changes for it.

## Bounds

Eight members; 32 payment notes said again per edge; 1024 commits; 16 KiB of text; 32 own messages and 128 KiB kept for catch-up; 64 waiting frames and 1 MiB; 16 epoch secrets; a replay window of 256 sequence numbers per sender and epoch; 16 commits buffered ahead of the chain; 24 commits per welcome piece; 60 KiB per frame. These are the first profile's numbers, chosen to be small, not measured product limits.

## Security and privacy

- The admin sees, and can invent, the roster; it cannot read edges it is not part of, forge another member's messages or hand a removed member a new secret it does not have.
- Every member can read every message of every epoch it was in, keep it, and forward it out of band. Removal changes keys, not the past.
- Edges are pairwise Pkarr links: relays see one rendezvous key per member per edge and its signaling; the group id and the roster never touch the DHT.
- A member's device holds its member seed, the chain, the secrets of recent epochs and its own recent messages in the clear at rest, as chats are held today. Profile backups include them.
- Denial of service by an insider is bounded to what one edge can carry; a validly signed fork by the admin halts the group by design.

## Conformance

[`packages/core/test/groups.test.ts`](../../packages/core/test/groups.test.ts) exercises: everyone reads everyone; a removed member holds no secret and cannot decrypt the next epoch, its old-epoch messages are accepted for that epoch only and a re-stamped one is refused; a new member cannot read earlier epochs and is not re-sent them; two admissions serialized before either edge is up; duplicate, out-of-order, tampered, foreign-key and wrong-group frames; offline catch-up across a rotation from the authors' logs; buffering ahead of the chain; forks, and lying syncs that are not forks; admin transfer, with the former admin's commits refused; leaving; bounded logs and waiting rooms; long chains in pieces; welcomes from the wrong admin; restart from saved state. [`groupLink.test.ts`](../../packages/core/test/groupLink.test.ts) checks that group frames flow only after both sides announced groups, and that an app without them sees nothing. [`e2e/web/groups.spec.ts`](../../e2e/web/groups.spec.ts) runs four browsers through a local relay: create, invite two from the contacts, everyone reads everyone with sender names, one closes its tab and misses two messages and a rotation and is caught up on return, one is removed and is told and reads nothing after, the admin role moves and the new admin brings in a fourth who reads nothing earlier, the founder leaves. [`packages/browser/test/groups.test.ts`](../../packages/browser/test/groups.test.ts) covers the admission exchange, edge lifecycle and restart at the engine level, and the entry link: a stranger knocking and admitted over an entry session, a replaced or turned-off link reaching nobody, an accept for another key than the one that knocked refused, admissions in flight dropped on the admin's restart. [`groupEntry.test.ts`](../../packages/core/test/groupEntry.test.ts) checks the link format, the knock identity and sealing, knock merging and the entry session's derivation. [`e2e/web/group-link.spec.ts`](../../e2e/web/group-link.spec.ts) runs four browsers that never pair: two join through the admin's link, one by opening it and one by pasting it into Join, everyone reads everyone by name, and a replaced link leaves the fourth waiting; a second test holds a join with the admin's app open to 20 seconds (reaching the admin to 30) and checks the joiner's steps go forward only. [`e2e/web/group-join-timing.spec.ts`](../../e2e/web/group-join-timing.spec.ts) is a measurement, not a check: with `E2E_JOIN_RUNS=N` (and `E2E_REAL_RELAYS=1` for the public relays) it times N joins step by step from the engine's own trace (`joinTrace.ts`). Payments: [`packages/browser/test/groupPaymentDesk.test.ts`](../../packages/browser/test/groupPaymentDesk.test.ts) wires three payment desks over edges: a member's request travels only on its edge; a request to the group goes to every edge on one rail, two members paying it at once (and two tokens arriving at the same moment while the mint is slow) leave one redeemed and the other refused unredeemed and taken back, every copy closes, receipts and retransmitted tokens change nothing, a token of another mint or too small is refused before redemption, one invoice is paid once, and a member whose edge was down gets the request, or its closing receipt, when it opens. [`groupPayments.test.ts`](../../packages/browser/test/groupPayments.test.ts) checks the `group-pay` note: strict parsing, who may say what, forward-only merging, claims and their withdrawal, and what each side says about its own records. [`e2e/web/group-payments.spec.ts`](../../e2e/web/group-payments.spec.ts) runs three browsers and a Cashu mint: Alice asks Bob, Carol sees the request and then sees it paid; Alice asks the group, Carol pays it once, Bob sees it paid by Carol and cannot pay it, and the balances moved once.

## Open decisions

Private payments in a group (no note, or amounts hidden); a request to the group on reversible rails only, or split between members; approval of each entry before admission, and an expiry or use count on a link; multiple admins; a member key update (post-compromise security for a member's own key); files and media in groups, each behind a capability of its own; native transports on edges; a relay or GossipSub profile ([901](901-gossipsub.md)) for larger groups; a negotiated store for members that are never online together.

## References

[Group contract](900-group-sessions.md), [paired chat](401-paired-chat.md), [invite/join](800-invite-join.md), [protocol](../PROTOCOL.md#65-private-groups-group-mesh1), [session](../../packages/core/src/groupSession.ts), [commits](../../packages/core/src/groupCommits.ts), [crypto](../../packages/core/src/groupCrypto.ts).
