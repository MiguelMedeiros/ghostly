# WISP 403: DHT Text

| Field | Value |
|---|---|
| Candidate number | 403; editorial family allocation |
| Status | Draft |
| Revision | 0.3 |
| Updated | 2026-09-26 |
| Document kind | Profile |
| Dependencies | [400](400-chat.md), [01](01-ghost-core.md), [03](03-capabilities.md) |
| Implementation | The floor and first contact of every new chat (web, extension, desktop); DHT only per chat; pinned mailboxes. Native clients read the Mainline DHT directly; browsers go through Pkarr relays. |
| Summary | The floor of every chat: very short text through DHT records when no live link is up. Bounded, not a mailbox. |
| Availability | Available |
| Notes | 256 bytes, retried for five minutes: the first contact of every chat, after a live link drops, or in a chat set to DHT only. Chats with 0.4 contacts: up to 500 bytes (WISP 402). |

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

(Every new chat, since revision 0.2.)

1. The invite's secret and the ordered pair of rendezvous keys derive the envelope key and the two directional mailboxes ([DHT delivery](../DHT-DELIVERY.md#invitation-bootstrap-and-encryption)).
2. The joiner generates and stores its participation key, then publishes a first-contact envelope in its mailbox: intended recipient `invite`, signed by its participation key, sealed with the invitation-derived key. It carries the joiner's `mode` and MAY carry a first text. At the same moment the joiner publishes its capability record ([03](03-capabilities.md#layer-0-capability-record)) and starts a stream attempt ([100](100-transports.md)).
3. The inviter reads the joiner's mailbox at the signaling pace (every 4 s) for two minutes once the joiner shows up (a fresh presence packet), and at the chat's pace otherwise, so an invite nobody opened spends no relay budget. The joiner reads at 4 s for its first two minutes. It verifies the signature, durably pins the participation key, stores any text, and answers with its own envelope (its key hint in `_dmk`, sealed with the post-pin key) and a receipt.
4. The joiner already pinned the inviter's participation key from the invite ([801](801-invitation-profiles.md#exact-layout)); it verifies the answer against that pin, and refuses an answer signed by any other key as a security rejection. The chat is now `on-dht`, or `live` if the stream attempt verified first. Every later envelope uses the post-pin key. (Codes made before revision 0.2 carry no participation key; for them the joiner pins from the first answer, as today.)
5. If the stream path pins first, the DHT path MUST find the same participation key when its envelope arrives. An envelope signed by a different key is ignored, not a security rejection: this mailbox's key comes from the invite, so anyone holding a copy can publish there (revision 0.3; [400](400-chat.md#candidate-requirements-for-the-one-chat), requirement 8). It is never stored, never remembered as a stop, and never replaces the pin. Possession of the invite is enough to compete for first admission, as before; the comparison code shown on both sides verifies the pin independently.

## Pinned mailboxes (revision 0.3)

A newer packet under a mailbox key replaces the older one, and a copy of the invite derives both invite mailbox keys: it could overwrite the contact's envelope, texts included, about once a minute. Once both sides are pinned, each moves to a mailbox derived from the X25519 agreement of the two participation keys, which the invite alone does not give ([DHT delivery](../DHT-DELIVERY.md#invitation-bootstrap-and-encryption)).

- The signed body gains an optional tenth element (the ninth, the capability revision, is then `null` when absent): `1` = the author can use the pinned mailbox; `2` = the author knows the reader can, and reads the pinned mailbox first. Readers from before ignore it.
- Only an envelope sealed to the reader (a post-pin envelope with `_dmk`) counts: its author has pinned the reader, so it can derive the mailbox.
- A side reads the contact's pinned mailbox first once the contact sent `1`, and the invite mailbox only when the pinned one held nothing from the contact. It publishes in its own pinned mailbox once the contact sent `2`. Once the contact's envelope was seen in the pinned mailbox, the invite mailbox is not read any more.
- Before the contact sent either, a read of the invite mailbox that finds a packet but nothing from the contact (expired, or someone else's) looks in the pinned mailbox too, at most once a minute: the contact may have moved while this side was away.
- A contact whose envelopes carry no tenth element keeps the invite mailboxes both ways, and costs no extra read while its own envelope is there.

The move costs one extra read per poll only while it is under way (the contact said `1` or `2` but was not seen in the pinned mailbox yet).

## When text goes over the DHT

| Chat state ([400](400-chat.md#states-of-a-chat)) | A new text of at most 256 bytes | A longer text |
|---|---|---|
| `rendezvous` (joiner) | May ride the first-contact envelope | Queued until pinned |
| `live` | Layer 1 | Layer 1 |
| `on-dht` | DHT, under its stable id | Held ([4xx](4xx-store-and-forward.md)) if both allow; otherwise queued for layer 1 |
| `dht-chosen` | DHT | Held if both allow; otherwise queued until someone leaves DHT only |

A text already sent on layer 1 that loses its session before the receipt is sent again over the DHT under the same id, when it fits (exists today). A text first sent over the DHT whose layer 1 comes back goes again on layer 1 at once; the first receipt on either path ends the other path's retries, and the receiver shows it once.

**Queueing (Q4 of [400](400-chat.md#compatibility-security-and-decisions)).** Only one DHT text per direction may await a receipt. A second text goes to the outbox, in order, and is published when the previous one is confirmed or expires, or sent on layer 1 when that comes back. The wire rule does not change.

**Expiry.** A DHT text that expires unconfirmed is queued for layer 1 in `on-dht` (exists today for `pair1/` chats), and becomes **Delivery unconfirmed** at once in `dht-chosen` (exists today for DHT-only chats), because nothing else would carry it.

## Choosing DHT only

Either side choosing DHT only keeps both off layer 1, so leaving it takes both, and each learns the other's choice from its envelopes. The new mode goes out in an envelope at once, not after the usual spacing between publications. After this side leaves DHT only, it reads a contact still on DHT only every 4 s for two more minutes. A DHT-only contact runs no stream discovery, so as soon as it advertises itself on the link's Pkarr record again, its mailbox is read right away; once neither side is blocked, the link is dialled or answered at once. All of this exists today ([DHT delivery](../DHT-DELIVERY.md#one-conversation-two-delivery-methods)).

What changes is where the choice is made: not in the invite, but in the chat's Connection menu, as the **DHT only** entry beside Automatic, WebRTC, Iroh and HyperDHT ([400](400-chat.md#pairing-progress-and-transport-rows)). Store-and-forward still works while DHT only is chosen: it dials nobody.

## Poll pace

| Situation | Pace |
|---|---|
| This side DHT only, or it left DHT only less than two minutes ago while the contact is still there | 4 s |
| Inviter: the joiner just showed up (fresh presence packet); joiner: its first two minutes | 4 s, for two minutes |
| A text of ours awaits its receipt | 4 s |
| `on-dht`, chat open and app in front | 10 s |
| `on-dht`, in the background | 30 s |
| `live` | 5 min, and at once when layer 1 is lost |

`on-dht` with the chat open was 4 s in the proposal; 10 s leaves room in the relays' budget for presence reads and hold pointers while layer 1 is redialled.

With every chat running this profile, reads multiply by the number of chats. The relays' per-IP budget (50 requests a minute on pkarr.pubky.org; a browser client keeps its own budget of 30 a minute per relay) is the binding limit, which is why reads slow down while layer 1 carries the chat. A request over the budget waits for it to free; it is never a pairing or delivery error, and a held-back envelope is not one of the eight publication attempts ([400](400-chat.md#compatibility-security-and-decisions), Q7).

## What never enters this path

Financial envelopes, files, pictures, calls and service bodies never enter this path; Cashu bearer tokens are refused as text. A short pasted Lightning invoice can fit as text, but publishing it starts no payment. A contact whose capability record lacks `dht-text/1` receives nothing on this path: the sender queues for layer 1 instead ([03](03-capabilities.md#layer-0-capability-record)).

## Runtime and conformance

DHT only avoids stream discovery/dialing. Native clients read the Mainline DHT directly and publish to the DHT and the relays; browser/extension use HTTP relays ([01](01-ghost-core.md#open-decisions)). A security rejection never triggers this path. See [implementation](../../packages/core/src/dhtDelivery.ts). Check exact packet budgets, restart/expiry, pin substitution, rejected publication, duplicate receipts and cross-path message deduplication. For revision 0.2 add: first contact with every stream blocked; first contact where the stream and the DHT pin different keys (rejected on both); the second text of a burst queued, not lost; `live` to `on-dht` to `live` with no duplicate or reordered text.

## Revision log

- 0.3 (2026-09-26): another key on the invite mailbox after the pin is ignored, not a stop; pinned mailboxes, told by the envelope's tenth element, so a copy of the invite cannot overwrite the contact's texts.
- 0.2 (2026-09-25): the floor and first contact of every chat; states instead of invite modes; queueing, expiry per state, poll pace, DHT only as a per-chat choice.
- 0.1 (2026-09-22): bounded DHT text profile.
