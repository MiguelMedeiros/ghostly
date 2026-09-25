# WISP 403: DHT Text

| Field | Value |
|---|---|
| Candidate number | 403; editorial family allocation |
| Status | Draft |
| Revision | 0.2 |
| Updated | 2026-09-25 |
| Document kind | Profile |
| Dependencies | [400](400-chat.md), [01](01-ghost-core.md), [03](03-capabilities.md) |
| Implementation | Existing envelope, limits and DHT-only mode (`pair2d/` chats and paired fallback); as the floor and first contact of every chat (decided 2026-09-25; being implemented). Native DHT versus browser relays differ. |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Role in the one chat (revision 0.2)

This profile is the **floor** of every chat of [400](400-chat.md): the delivery that works whenever both sides reach the DHT, whatever else fails. It carries:

1. the **first contact** of every new chat, in parallel with the first stream attempt;
2. **short text and its receipts** while the chat is `on-dht` (layer 1 lost or never connected) or `dht-chosen` (either side chose DHT only);
3. the **delivery mode** each side is in, so both know when layer 1 is blocked.

It is a small-record delivery path, not an adapter pretending that the DHT is a live byte stream. It is never a candidate in the transport rank sum of [100](100-transports.md): it is what the chat has when that ranking yields nothing, or when a person chose it.

Before this revision, the same envelope served two separate cases: chats created with the `pair2d/` ("Text only") invite, which stayed on the DHT until someone switched, and paired chats whose stream dropped after the contact had announced DHT support. Both remain valid readings of the same bytes; the differences are that every new chat now runs this profile from the first contact, and that a chat on the DHT upgrades to layer 1 by itself.

## Wire binding and limits

It uses separate directional Pkarr mailboxes and the `_dm`/`_dmk` envelope described in [DHT delivery](../DHT-DELIVERY.md). The envelope binds sender participation, intended recipient, sequence, times, delivery mode, message ID and receipt. Known participation keys must not be silently replaced.

Only text is admitted: at most 256 UTF-8 bytes, and complete encrypted/authenticated DNS packets must fit 1,000 bytes. Escaping/receipts can lower the usable text budget. Refuse oversized content intact; do not fragment or truncate. Keep one outstanding message per direction, a five-minute lifetime and at most eight bounded publication attempts. Save original expiry/sequence/attempt state before publishing. A mode switch cannot reset the budget.

Persist received content before advancing replay state or acknowledging its stable ID. Publishing is not delivery confirmation. Expiry stops acceptance/retransmission; it does not erase caches, screenshots or recipient history. This construction has no forward-secrecy guarantee.

The envelope's `mode` field (`"stream"` or `"dht"`) is unchanged. In revision 0.2 its reading is: `"dht"` = this side is `dht-chosen`; `"stream"` = this side wants layer 1 whenever it connects.

## First contact

(Exists for `pair2d/` invites; proposed for every invite.)

1. The invite's secret and the ordered pair of rendezvous keys derive the envelope key and the two directional mailboxes ([DHT delivery](../DHT-DELIVERY.md#invitation-bootstrap-and-encryption)).
2. The joiner generates and stores its participation key, then publishes a first-contact envelope in its mailbox: intended recipient `invite`, signed by its participation key, sealed with the invitation-derived key. It carries the joiner's `mode` and MAY carry a first text. At the same moment the joiner publishes its capability record ([03](03-capabilities.md#layer-0-capability-record)) and starts a stream attempt ([100](100-transports.md)).
3. The inviter reads the joiner's mailbox at the signaling pace (every 4 s) from the moment the invite exists until it pins a contact or the invite is withdrawn (new: today the inviter of a streams-first invite reads it every 30 s). It verifies the signature, durably pins the participation key, stores any text, and answers with its own envelope (its key hint in `_dmk`, sealed with the post-pin key) and a receipt.
4. The joiner already pinned the inviter's participation key from the invite ([801](801-invitation-profiles.md#exact-layout)); it verifies the answer against that pin, and refuses an answer signed by any other key as a security rejection. The chat is now `on-dht`, or `live` if the stream attempt verified first. Every later envelope uses the post-pin key. (Codes made before revision 0.2 carry no participation key; for them the joiner pins from the first answer, as today.)
5. If the stream path pins first, the DHT path MUST find the same participation key when its envelope arrives; a different key is a security rejection on both layers ([400](400-chat.md#candidate-requirements-for-the-one-chat)). Possession of the invite is enough to compete for first admission, as before; the comparison code shown on both sides verifies the pin independently.

## When text goes over the DHT

| Chat state ([400](400-chat.md#states-of-a-chat)) | A new text of at most 256 bytes | A longer text |
|---|---|---|
| `rendezvous` (joiner) | May ride the first-contact envelope | Queued until pinned |
| `live` | Layer 1 | Layer 1 |
| `on-dht` | DHT, under its stable id | Held ([4xx](4xx-store-and-forward.md)) if both allow; otherwise queued for layer 1 |
| `dht-chosen` | DHT | Held if both allow; otherwise queued until someone leaves DHT only |

A text already sent on layer 1 that loses its session before the receipt is sent again over the DHT under the same id, when it fits (exists today). A text first sent over the DHT whose layer 1 comes back goes again on layer 1 at once; the first receipt on either path ends the other path's retries, and the receiver shows it once.

**Queueing (new; Q4 of [400](400-chat.md#compatibility-security-and-decisions)).** Only one DHT text per direction may await a receipt. Today a second text stays in the composer until then. In this revision it goes to the outbox as `queued`, in order, and is published when the previous one is confirmed or expires, or sent on layer 1 when that comes back. The wire rule does not change.

**Expiry.** A DHT text that expires unconfirmed is queued for layer 1 in `on-dht` (exists today for `pair1/` chats), and becomes **Delivery unconfirmed** at once in `dht-chosen` (exists today for DHT-only chats), because nothing else would carry it.

## Choosing DHT only

Either side choosing DHT only keeps both off layer 1, so leaving it takes both, and each learns the other's choice from its envelopes. The new mode goes out in an envelope at once, not after the usual spacing between publications. After this side leaves DHT only, it reads a contact still on DHT only every 4 s for two more minutes. A DHT-only contact runs no stream discovery, so as soon as it advertises itself on the link's Pkarr record again, its mailbox is read right away; once neither side is blocked, the link is dialled or answered at once. All of this exists today ([DHT delivery](../DHT-DELIVERY.md#one-conversation-two-delivery-methods)).

What changes is where the choice is made: not in the invite, but in the chat's Connection menu, as the **DHT only** entry beside Automatic, WebRTC, Iroh and HyperDHT ([400](400-chat.md#pairing-progress-and-transport-rows)). Store-and-forward still works while DHT only is chosen: it dials nobody (new: today holding stops in DHT-only mode).

## Poll pace

| Situation | Today | Proposed |
|---|---|---|
| This side DHT only, or the contact just left it | 4 s | 4 s |
| Inviter waiting for a first contact | 30 s (streams-first invite), 4 s (`pair2d/`) | 4 s until pinned or withdrawn |
| `on-dht`, chat open and app in front | 30 s | 4 s |
| `on-dht`, in the background | 30 s | 30 s |
| `live` | 30 s | 5 min, and at once when layer 1 is lost |

With every chat running this profile, reads multiply by the number of chats. The relays' per-IP budget (50 requests a minute on pkarr.pubky.org) is the binding limit, which is why reads slow down while layer 1 carries the chat ([400](400-chat.md#compatibility-security-and-decisions), Q7).

## What never enters this path

Financial envelopes, files, pictures, calls and service bodies never enter this path; Cashu bearer tokens are refused as text. A short pasted Lightning invoice can fit as text, but publishing it starts no payment. A contact whose capability record lacks `dht-text/1` receives nothing on this path: the sender queues for layer 1 instead ([03](03-capabilities.md#layer-0-capability-record)).

## Runtime and conformance

DHT only avoids stream discovery/dialing. Native uses Pkarr; browser/extension use HTTP relays. A security rejection never triggers this path. See [implementation](../../packages/core/src/dhtDelivery.ts). Check exact packet budgets, restart/expiry, pin substitution, rejected publication, duplicate receipts and cross-path message deduplication. For revision 0.2 add: first contact with every stream blocked; first contact where the stream and the DHT pin different keys (rejected on both); the second text of a burst queued, not lost; `live` to `on-dht` to `live` with no duplicate or reordered text.

## Revision log

- 0.2 (2026-09-25): the floor and first contact of every chat; states instead of invite modes; queueing, expiry per state, poll pace, DHT only as a per-chat choice.
- 0.1 (2026-09-22): bounded DHT text profile.
