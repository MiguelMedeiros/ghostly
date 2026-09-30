# WISP 403: DHT Text

| Field | Value |
|---|---|
| Candidate number | 403; editorial family allocation |
| Status | Draft |
| Document kind | Profile |
| Dependencies | [400](400-chat.md), [01](01-ghost-core.md), [03](03-capabilities.md) |
| Implementation | The floor and first contact of every new chat (web, extension, desktop, CLI); DHT only per chat; pinned mailboxes. Desktop reads the Mainline DHT directly, the headless CLI when every relay fails; browsers go through Pkarr relays. |
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

Only text is admitted: at most 256 UTF-8 bytes, and complete encrypted/authenticated DNS packets must fit 992 bytes ([What a mailbox shows](#what-a-mailbox-shows-revision-07)). Escaping/receipts can lower the usable text budget. Refuse oversized content intact; do not fragment or truncate. Keep one outstanding message per direction, a five-minute lifetime and at most eight bounded publication attempts. Save original expiry/sequence/attempt state before publishing. A mode switch cannot reset the budget.

Persist received content before advancing replay state or acknowledging its stable ID. Publishing is not delivery confirmation. Expiry stops acceptance/retransmission; it does not erase caches, screenshots or recipient history. This construction has no forward-secrecy guarantee.

The envelope's `mode` field (`"stream"` or `"dht"`) is unchanged. In revision 0.2 its reading is: `"dht"` = this side is `dht-chosen`; `"stream"` = this side wants layer 1 whenever it connects.

## What a mailbox shows (revision 0.7)

A mailbox's packet can be read by anyone who has its address, without the envelope key: a holder of the invite for the invite mailboxes, and the relays and DHT nodes that store either kind. Every envelope is made to look the same to such a reader:

- Every record carries a TTL of 300 s, whatever the envelope holds. Readers never read the TTL; it only tells caches how long to keep the packet.
- The sealed `_dm` plaintext is padded with spaces after the JSON value, up to the largest length whose packet fits 992 bytes. Every packet of a mailbox then has one size: 992 bytes before the pin (one record), 989 after it (with `_dmk`). JSON allows spaces after the value, so readers from before read these envelopes as ever.
- The sender measures a text against the same 992 bytes, 8 under the DHT's 1,000: the Rust client splits TXT strings at 254 bytes, not 255, so the packet it builds can be a byte or two larger. This can lower the usable text budget a little for a text with many escaped characters.

So one read of a mailbox does not tell whether its envelope carries a text, a receipt, reactions, an edit or only the delivery mode, nor how long a text is, nor how many times it was retried.

What such a reader can still learn:

- That the mailbox exists and is in use, and whether the pin happened (the `_dmk` record appears).
- When each envelope was published: the packet's timestamp is in the clear. With nothing to send, an envelope goes about every four minutes (a paired chat started again sends its first one 15 s after the start, revision 2026-09-29); a text goes at once and again after 4, 8, 16 and 32 s and then every 60 s until its receipt, and a receipt goes at once. Someone reading a mailbox every few seconds can tell activity from that pattern. Hiding it would take envelopes on a fixed schedule whatever happens, which the relays' request budget and the delivery latency do not allow today; it is an open item.
- The relays see the IP address of whoever publishes and reads.

Before this revision a text's TTL was its remaining lifetime (at most 300 s, lower on every retry), a keep-alive's was 600 s, and a packet's size followed its content (in one run: keep-alives of 406 bytes before the pin and 576 after, texts of 474 to 969), so a single read told that a text was pending.

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

## Replies

A text that answers another ([400](400-chat.md#replies), revision 0.4) carries only the original's id, as the signed body's optional **eleventh** element (the ninth and tenth are then present, the ninth `null` when there is no revision to name): 8 to 64 characters of `A-Z a-z 0-9 _ -`. No line and no author travel: the packet has no room for them, and the reader finds both in its own history. An envelope without a text carries no eleventh element. A reader drops an eleventh element that is not such an id and keeps the text; readers from before ignore it (they accept a body of up to 16 elements).

The id costs about 30 bytes of the 1,000-byte packet. A text near the 256 bytes, whose packet does not fit with it, goes **without** it: the text is what matters. Since the reader keeps the first copy of a text it gets, the same text sent again on layer 1 later does not bring the reply back; the reply shows as a plain text on that side.

## Reactions

Reactions ([400](400-chat.md#reactions), revision 0.5) ride on the envelopes while the live session does not carry them. The signed body's **thirteenth** element is the author's reactions the reader has not confirmed, oldest first, `[[id, emoji, n], …]` (at most 8, as many as the packet and the reader's 900 bytes leave room for); the **fourteenth** is the highest `n` of the reader's reactions the author took, or `null`. The eleventh (a reply) and the twelfth (kept for an edit of a text) are then `null` when the envelope carries neither. A reader checks each reaction on its own, as on the session, and skips what does not hold, never the envelope; it takes the ones that hold, and says the highest number it took in every envelope it publishes after. The author drops every reaction up to the number the reader said, and the next envelope carries the rest.

Reactions add no envelope of their own when one goes anyway: they ride on texts, receipts and the envelopes that keep the mode current. A reaction made while nothing else goes publishes one envelope, once the publication spacing allows; a text that leaves no room carries none, and the next envelope does. Readers from before ignore both elements (they accept up to 16).

## Edits

An edit of a text ([400](400-chat.md#edits), revision 0.6) may go on the floor while the chat is not live, to a contact whose capability record ([03](03-capabilities.md#layer-0-capability-record)) lists `edit/1`. It goes as a text of its own: the new text, under an id made from the edited message's id and the edit's number (the first 16 bytes of SHA-256 of `ghostly-edit/1:<id>:<e>`, in base64url), so every send of that edit and its receipt match. The signed body's optional **twelfth** element says what it is: `[<id>, <e>]`, the edited message's id (22 characters) and the edit's number (1 to 100). The eleventh element then goes as `null` (an edit replies to nothing).

A reader that takes edits applies it as the live frame does ([401](401-paired-chat.md#edits)): the contact's message with that id only, the highest number winning. Its text holds as a live edit's must: not blank, no space around it; an edit whose text does not is dropped (and receipted), never shown as a text. It receipts the text's id as for any text. A twelfth element that is not such a pair leaves a text of its own. An app from before edits would show the edit as a new message, which is why it goes only to a contact whose record says `edit/1`; an older app's record never does.

The author sends an edit on the floor only after its message's receipt, since the reader must have the message to find it. The element costs about 40 bytes of the packet: a text near 256 bytes does not fit with it, and its edit waits for a live session instead, never going without the element. It takes the floor's one text slot like any text, with the same retries and expiry; a confirmation of the same edit on the live session ends them.

## Forwards

A forwarded text ([400](400-chat.md#forwards), revision 0.8) carries its hop count as the signed body's optional **fifteenth** element: a whole number from 1 to 255. The eleventh to fourteenth are then present: `null` for no reply and no edit, `[]` for no reactions, `null` for none taken. An edit never carries one. The element costs about 20 bytes: a text whose packet, or whose plaintext against the reader's 900 bytes, has no room for it goes **without** it, and reads as written there. A reader drops a fifteenth element that is not such a number and keeps the text; readers from before ignore it (they accept a body of up to 16 elements).

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
| `live` | Once as layer 1 comes up, then 5 min, and at once when layer 1 is lost |

`on-dht` with the chat open was 4 s in the proposal; 10 s leaves room in the relays' budget for presence reads and hold pointers while layer 1 is redialled.

With every chat running this profile, reads multiply by the number of chats. The relays' per-IP budget (50 requests a minute on pkarr.pubky.org; a browser client keeps its own budget of 30 a minute per relay, 60 on pkarr.pubky.app, which allows 1000) is the binding limit, which is why reads slow down while layer 1 carries the chat. A request over the budget waits for it to free; it is never a pairing or delivery error, and a held-back envelope is not one of the eight publication attempts ([400](400-chat.md#compatibility-security-and-decisions), Q7).

## What never enters this path

Financial envelopes, files, pictures, calls and service bodies never enter this path; Cashu bearer tokens are refused as text. A status card ([4xx · Status Cards](4xx-status-cards.md), revision 2026-09-29) never does either: a card's first message may go here as its fallback text when it fits, and its updates wait for the live session. A short pasted Lightning invoice can fit as text, but publishing it starts no payment. A contact whose capability record lacks `dht-text/1` receives nothing on this path: the sender queues for layer 1 instead ([03](03-capabilities.md#layer-0-capability-record)).

## Runtime and conformance

DHT only avoids stream discovery/dialing. Native clients read the Mainline DHT directly and publish to the DHT and the relays; browser/extension use HTTP relays ([01](01-ghost-core.md#open-decisions)). A security rejection never triggers this path. See [implementation](../../packages/core/src/dhtDelivery.ts). Check exact packet budgets, restart/expiry, pin substitution, rejected publication, duplicate receipts and cross-path message deduplication. For revision 0.2 add: first contact with every stream blocked; first contact where the stream and the DHT pin different keys (rejected on both); the second text of a burst queued, not lost; `live` to `on-dht` to `live` with no duplicate or reordered text.

## Revision log

One file per change in [changes/403-dht-text/](changes/403-dht-text/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
