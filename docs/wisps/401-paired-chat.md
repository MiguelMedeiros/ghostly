# WISP 401: Chat Session

| Field | Value |
|---|---|
| Candidate number | 401; editorial family allocation |
| Status | Draft |
| Revision | 0.12 |
| Updated | 2026-09-27 |
| Document kind | Profile |
| Dependencies | [400](400-chat.md), [100](100-transports.md), [403](403-dht-text.md) |
| Implementation | The layer-1 session of every new chat (`paired-chat/1`): WebRTC, and native Iroh/HyperDHT where supported. First contact on the DHT in parallel, and automatic upgrade; calls (`calls/1`, screen sharing inside a call), shared apps (`services/1`), `files/3`, the typing indicator (`typing/1`), reactions (`react/1`) and edits (`edit/1`) on the live session; replies on texts and files. |
| Summary | The live session of every chat: pinned keys, a durable outbox, names and pictures, over WebRTC, Iroh or HyperDHT. |
| Availability | Available |
| Notes | Every new chat on web, desktop and extension, calls included while it is live. The typing indicator goes over the live session only, and each person can turn it off. |
| Feature | [Chat](https://ghostly.tools/#next) |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Role in the one chat (revision 0.2)

This is the **layer-1 session** of the one chat of [400](400-chat.md). Formerly "paired chat", it is no longer a kind of chat the person picks: every new chat is a `paired-chat/1` chat, whose layer 0 is the DHT ([403](403-dht-text.md)) and whose layer 1 is this session, when a transport connects. The wire identifiers (`paired-chat/1`, `chat/1`, the frame names) are unchanged.

What changes around this session:

- **First contact** can complete on the DHT ([403](403-dht-text.md#first-contact)) before any stream exists. When it does, this session later opens with the participation key already pinned: the handshake verifies against the pin exactly as a reconnect does today, and no comparison is asked again. When the stream wins the race instead, pinning happens here as today. Either way both paths MUST carry the same participation key; a mismatch is a security rejection on both layers.
- **Losing the session is not losing the chat.** When this session closes or its liveness gives up, the chat moves to `on-dht` ([400](400-chat.md#states-of-a-chat)) and the outbox sends unconfirmed text over the DHT under the same ids. This already happens today for a paired chat whose contact has announced DHT support; revision 0.2 makes it the rule, because every contact announces it from the first contact.
- **Coming back.** The dialling side redials with the backoff of [100](100-transports.md#background-retry-and-upgrade); when this session is ready again, everything queued goes in order, oldest first ([automatic resend](PAIRED-CHAT-INCREMENT.md#automatic-resend)).
- **The transcript label.** The selection tuple of the transcript ends with the constant `"no-dht-payload"` ([exact profile](PAIRED-CHAT-INCREMENT.md#exact-experimental-wire-profile)). It stays byte for byte, so proofs keep verifying with every app that pairs today. It means that *this session* carries no DHT payload; it does not mean the chat has no DHT fallback. Whether a contact accepts DHT text is said by `dht-text/1` in its capability record ([03](03-capabilities.md#layer-0-capability-record)).

## Wire binding

This profile binds the independent [chat contract](400-chat.md) to the implemented `paired-chat/1` session and negotiated `chat/1` capability. Both peers authenticate participation keys and the agreed channel before application traffic. Data travels over the selected WebRTC, Iroh or HyperDHT adapter where that runtime provides it; a particular adapter is not part of the message identity.

Stable message IDs and the durable local outbox survive reconnect and transport changes. The receiver MUST store accepted content before returning the implemented storage acknowledgement. A retry reuses its message ID; an acknowledgement is not a read receipt. Local failures must not be reported as confirmed remote storage. No total ordering or globally exactly-once delivery is promised.

### Name and picture

Once the session is ready, and whenever they change, each side says how it wants to be shown: `{"t":"paired-nick","n":"<name>"}` and `{"t":"paired-avatar","a":"<picture>"}`. The picture is a square JPEG as a `data:image/jpeg;base64,` URL of at most 48,000 characters whose frame header declares no side over 512 pixels; an empty `a` means the picture was removed. A receiver MUST ignore any other value (another format, an address to fetch, a larger or malformed image) and MUST NOT fetch anything for it. A sender SHOULD redraw the chosen picture at 128×128 before sending, so no metadata of the original file (location, camera, edit history) travels. These frames carry no message ID; older apps drop them. Compatibility chats ([402](402-legacy-chat.md)) have no room for a picture. On the DHT the name travels in the capability record ([03](03-capabilities.md#layer-0-capability-record)); the picture waits for this session.

Both sides send both frames on every ready session, the first one after an invite included, so a change made while the other side was away arrives on its next session. An empty `n` means there is no name to show (never set, removed, or not shared); a receiver MUST then stop showing the name it had, and MUST ignore an `n` that is not a string. The latest frame is the contact's current choice: a receiver SHOULD keep it with the chat and prefer it over a name read out of older messages (such as a join notice), while a name the user gave the chat on their own device still wins. A contact with no name SHOULD be shown by something stable drawn from its key (Ghostly shows `Contact · ` and the key's first six characters, with a pattern drawn from the key), not a generic label shared by every such contact.

Each local profile ([04](04-profiles.md)) decides whether contacts are told its name and picture (on by default). Off, it sends an empty `n` and an empty `a` on every session and on the switch itself, and its join notice names nobody; the name and picture stay on the device, and switching back on sends them again.

### Link previews

A `paired-message` MAY carry `pv`, a preview of one of its text's links, made by the **sender's** app when the message was written (revision 0.5). The reader shows it from the message and MUST NOT contact the site for it: not for the page, not for its picture. Older apps ignore the field and show the text.

`pv` is an object:

| Field | Meaning |
|---|---|
| `u` | The link, as it appears in the text without tracking parameters (`utm_*`, `fbclid`, `gclid`, `si` and similar). At most 2,048 characters, http(s) only. |
| `t` | The page's title, at most 200 characters. Optional. |
| `d` | Its description, at most 300 characters. Optional. |
| `s` | The site's name ("YouTube"), at most 80 characters. Optional. |
| `i` | A thumbnail: a `data:image/jpeg;base64,` URL of at most 20,000 bytes of JPEG whose frame header declares no side over 640 pixels. Optional. |

A receiver MUST drop `pv` (and keep the message) when it is not an object, when `u` is not an http(s) URL, when `u` without tracking parameters matches none of the text's links compared the same way (so a card never points somewhere the text does not), or when it has no `t`, `d` or `i`. It MUST drop a thumbnail in any other format, over the size, or declaring a larger picture, and keep the rest. It shows texts as plain text on one line, cut to the limits above, and never renders HTML from them. The card opens `u` outside the app; a video site (YouTube, Vimeo) is a card with its thumbnail and a play mark, never an embedded player.

The sender reads the page's Open Graph and Twitter card tags (for YouTube and Vimeo, the provider's own oEmbed endpoint), with no cookies and no referrer, and SHOULD redraw the picture itself (at most 320 pixels wide, as a fresh JPEG), so nothing of the site's file but its pixels travels. It MUST NOT read a page on this machine or the local network (`localhost`, `.local`, private and link-local addresses), nor follow a page's picture or redirect there: a page must not make the sender's app carry a local device's picture to the contact. Ghostly's desktop app fetches through the system (no CORS), resolving every name itself and refusing any non-public address; the web app and the extension can only read sites that allow it (CORS), and make no preview otherwise. No Ghostly-run proxy is involved. The person sees the preview in the composer before sending and can remove it; previews can be turned off (Settings → Security → Link previews).

The frame with `pv` stays under 56 KiB, below the 60 KiB a session takes: a sender leaves `pv` out rather than send a larger frame. `pv` travels only on this session. The DHT ([403](403-dht-text.md)) and held items ([4xx](4xx-store-and-forward.md)) carry the text without it. Groups ([900](900-group-sessions.md)) do not carry previews yet: their sealed boxes are bounded for 16 KiB of text, and a larger box would make older members drop the frame.

### Replies

A `paired-message` MAY carry `r`, the message it answers ([400](400-chat.md#replies), revision 0.7): `{"i": <id>, "s": <line>, "f": "sender" | "recipient"}`. `i` is the original's id as both sides know it: the `id` of a `paired-message` (22 characters), a payment's `id`, or a file's wire `id`; never the local row id, which each side makes up for itself. `f` is from the side of the reply's author: `"sender"` when the author wrote the original, `"recipient"` when the reader did.

```
{ "t": "paired-message", "id", "ts", "m", "pv"?, "r"?: { "i", "s", "f" } }
```

The reader looks for `i` among this chat's own messages only; what it finds there gives the line and the author, and the wire's `s` and `f` are shown only when it finds nothing, marked as unchecked. A reply is a few hundred bytes at most and always goes: when the frame would pass 56 KiB, `pv` is left out, never `r`. Over the DHT only `i` travels ([403](403-dht-text.md#replies)); a held text carries `r` in its header ([4xx](4xx-store-and-forward.md#bundle)). A text sent again after a lost session goes with the same `r`. A file can answer a message too (revision 0.9): the same `r` rides on its announcement (`pf-offer` and `pf-start`, [501](501-paired-files.md)) or in a held file's `meta` ([4xx](4xx-store-and-forward.md#bundle)), and is read the same way. Older apps ignore the field.

### Liveness and reconnection

A connection can die without either side being told (a laptop asleep, an app suspended in the background, a network change). While a session is ready, each side sends `{"t":"paired-ping"}` every 15 seconds and answers each one with `{"t":"paired-pong"}`. Any frame from the peer counts as a sign of life. Three pings in a row with nothing back close the session and its connection, and the dialling side tries again. This counts from the open for a peer whose `pair-offer` lists `ping/1` in `extensions`, so a contact that freezes before the first ping (a laptop closed right after connecting) is noticed too; for a peer that does not say so, it counts once that peer has answered a ping, and a peer that never answers one (an older app) is never cut off for it. Missed pings are counted, not timed, so a throttled background tab is not mistaken for a dead peer.

An app going away (it quits, its page closes) first sends `{"t":"paired-bye"}` on every ready session. The contact closes the session at once instead of waiting for its liveness, and watches for the app to come back ([100](100-transports.md#back-after-a-restart-revision-06)). The frame carries no id, so older apps drop it. Only on a ready session: before it, the contact's handshake would fail on it anyway.

The side that dials waits 20 seconds after a failed attempt, doubling up to 3 minutes. A link that worked and then dropped is dialled again as soon as the contact is seen. Opening a chat, or bringing the window back, looks for the contact at once and starts the wait over; the side that does not dial republishes its presence so the other one sees it fresh. A chat whose contact was never seen (an invite just sent) keeps polling at the active pace for ten minutes even in the background. The side that does not dial, when it sees the other side just appear (a packet of its that is new and under 30 seconds old), polls at the signaling pace for 30 seconds: the offer follows that side's presence by a moment, and left to the background pace it waited up to 30 seconds on the relays. A contact that has been online a while is not waited on this way (nothing is coming now), so an app opening with many contacts does not spend the relays' budget on it.

## Capabilities on this session

The `pair-offer` lists what this session can carry: `chat/1`, `signed-signal/1`, and, when both apps offer them, `tofu/1`, `files/2`, `payments/1` with its per-method entries, `transport-switch/1`, `transport-fallback/1`, `hold/1`, proof and identity entries. Older apps cap `capabilities` at 16 entries, so behaviour that grants nothing goes in `extensions` ([liveness](#liveness-and-reconnection)). The layer-0 capability record ([03](03-capabilities.md#layer-0-capability-record)) repeats the same identifiers so the DHT side knows them before this session exists; once this session is ready, its transcript-bound offer is authoritative for what the session carries.

### Calls and shared apps

Calls ([600](600-media.md)) and hosted local services ([700](700-local-services.md)) are what the one chat needs to do everything a compatibility chat ([402](402-legacy-chat.md)) did ([400](400-chat.md#what-each-state-can-carry)). Once the session is ready, each side sends `{"t":"paired-capabilities","c":[...]}` with what it offers on this session beyond the offer: `calls/1` (voice and video calls, [601](601-webrtc-media.md#paired-profile)) and `services/1` (shared local web apps, [701](701-http-services.md#paired-profile)), and `files/3` (files of any size, offered, resumed and checked, [501](501-paired-files.md#files3-files-of-any-size-revision-03)). It sends the frame on every ready session, a transport switch included, and again when what it offers changes. A capability is on only while both sides list it on the current session. A peer that never sends the frame (an older app) offers nothing here. A receiver MUST ignore a malformed frame (not a list, more than 32 entries, an entry that is not 1 to 40 characters of `a-z`, `0-9`, `/` and `-`) and keep what the peer said before; it MUST keep identifiers it does not know, and enable nothing for them. The frame carries no message ID; older apps drop it.

These are not in the offer's `capabilities`, which are full at 16 for older apps. The frame grants no more than an offer entry would: it travels on the authenticated session, after the transcript is signed and bound to this connection. An app offers `calls/1` only where it can place a call: WebRTC and capture exist, or, on Desktop on Linux (no WebRTC in its WebView), its own call media and the GStreamer plugins it needs ([601](601-webrtc-media.md#desktop-on-linux)). It offers `services/1` only where it can serve granted apps and open a contact's (not the web app).

Both need a live session. On the DHT ([403](403-dht-text.md)), or while connecting, there is no call and no shared app, and an app SHOULD say so where the action is ("Calls need a live connection"), and why when the contact's app is the reason.

### Typing

A contact can see that the other side is writing (revision 0.6). Both sides list `typing/1` in `paired-capabilities`; then either side may send `{"t":"paired-typing","s":"start"}` and `{"t":"paired-typing","s":"stop"}` on this session. It is presence, not a message: it carries no message ID (older apps drop it), is never stored, never counted as unread, never held ([4xx](4xx-store-and-forward.md)) and never sent on the DHT ([403](403-dht-text.md)). While the session is down there is no typing indicator. A side that does not offer `typing/1`, or whose contact does not, sends none.

The writer sends `start` when a keystroke leaves text in the composer, again at most every 3 seconds while the typing goes on, and `stop` once, after a `start`, when the text is cleared, the message is sent, the chat is left, the app goes to the background, or nothing was typed for 5 seconds. The reader shows the contact typing from a `start` until a `stop`, a message from that contact, the end of the session, or 6 seconds with no new `start`, so a dropped link never leaves it showing. A reader MUST ignore a frame whose `s` is anything else, and SHOULD drop typing frames past a small rate (Ghostly: 8 in 10 seconds). The frame counts only on the authenticated session with the pinned contact ([400](400-chat.md) requirement 8): a connection that has not authenticated as that key never reaches it.

A `start` may say what the contact is doing (revision 0.11): `{"t":"paired-typing","s":"start","kind":"recording"}` while a voice note is being recorded, `"kind":"thinking"` while a bot works on an answer, and, for bots, a short `status` line shown in place of the kind's words, such as `{"t":"paired-typing","s":"start","kind":"thinking","status":"Transcribing your audio…"}`. Both fields are optional and belong to `start` only; a `stop` carries neither. With no `kind`, or a kind the reader does not know, the reader shows typing, so an older app that reads only `s` keeps showing "typing…" and the capability stays `typing/1`. A `status` is plain text: the reader makes it one line (line breaks and runs of spaces become one space), removes invisible and direction-changing characters as it does for names ([#301](https://github.com/MiguelMedeiros/ghostly/pull/301)), keeps at most 40 characters, and drops it (showing the kind instead) when it holds a link (a `scheme://`, `www.`, or a scheme such as `nostr:` or `javascript:`) or a tag; it never goes through the message renderer, so it can carry no link, mention or formatting. A writer sends a `start` with a new kind or status at once rather than at the next refresh, and keeps under the reader's rate (Ghostly sends at most 6 frames in 10 seconds, leaving room for the `stop`). Ghostly's apps say `recording` from the moment the microphone opens (held or locked hands-free) until the voice note is sent or thrown away, told again every second since there are no keystrokes; `thinking` and `status` come from bots ([11xx](11xx-headless.md#typing)). The `sendTyping` choice below covers every kind.

Each local profile ([04](04-profiles.md)) decides whether contacts are told (on by default; Settings, "Send typing indicator"). Off, it sends no `start`, ends any standing one with a `stop`, and still shows its contacts' typing: the choice is about what this side says, not what it hears.

Groups ([900](900-group-sessions.md)) do not carry it yet. A mesh group would send one frame per member edge for every refresh, and a community's typing would tell every member, most of them strangers, when each person is present; both need their own decision on cost and privacy.

### Reactions

Reactions ([400](400-chat.md#reactions), revision 0.8) go on this session once both sides list `react/1` in `paired-capabilities`, and the contact confirms each one it took:

```
{"t":"paired-reaction","id":"<message id>","e":"❤️","n":1790000000000}
{"t":"paired-reacted","n":1790000000000}
```

`id` is the message's id as both sides know it (a reply's `i`, [above](#replies)); `e` one emoji, or `""` to take the reaction back; `n` the reactor's number. The reader takes a reaction (shows it, keeps it for a message not here yet, or finds it older than what it shows) and confirms its `n`; one it could not keep (no room left to wait) goes unconfirmed. It counts reaction frames before it reads them and drops those past 30 in 10 seconds unconfirmed, so a flood costs as much as the limit. The reactor keeps every reaction not confirmed (the newest per message, at most 32, in the order of their numbers), says them on each new session, again after 30 seconds without a receipt, and at most 20 in 10 seconds; off this session they ride on the DHT envelopes ([403](403-dht-text.md#reactions)). Both frames count only on the authenticated session with the pinned contact. Neither carries a message ID: older apps drop both, and a reactor whose contact never says `react/1` keeps its reactions waiting (and on the envelopes) without showing anything odd. Group edges never offer it: groups carry reactions in their own frames ([900](900-group-sessions.md)).

### Edits

A text can be edited after it was sent (revision 0.10; what an edit is, [400](400-chat.md#edits)). Both sides list `edit/1` in `paired-capabilities`; then the author sends the whole new text of one of its `paired-message`s, and the reader confirms the number it took:

```
{ "t": "paired-edit", "id", "e", "ts", "m", "pv"? }
{ "t": "paired-edited", "id", "e" }
```

`id` is the edited message's `id` (22 characters). `e` is the edit's number, an integer from 1 to 100, counted by the author for that message. `ts` is when the author made the edit (milliseconds; the reader takes a time ahead of its clock as now). `m` is the whole new text, trimmed, not empty, at most 16 KiB of UTF-8. `pv` is a link preview of the new text ([Link previews](#link-previews)), left out when the frame would pass 56 KiB. Both frames have an id, but a `t` older apps do not know: they drop them.

- **Only the contact's own messages.** The frame counts only on the authenticated session with the pinned contact ([400](400-chat.md) requirement 8), and the reader looks `id` up among the messages **that contact** sent in this chat. An id of one of the reader's own messages, or of another chat, finds nothing.
- **The reader.** It MUST ignore a frame that breaks the bounds above, or comes while `edit/1` is not agreed. A preview that does not hold for `m` is dropped, never the edit. When `e` is higher than the message's current number it shows `m` and keeps the version it replaces; otherwise the message stays as it is. Either way it confirms with `paired-edited`. It also confirms an edit of a message it deleted, so the author stops sending it. An edit whose message is not there yet (it may come another way, the DHT or held storage) waits for it for 60 seconds, at most 32 per chat, unconfirmed; it is confirmed once shown. A reader drops edit frames past 30 in 10 seconds, unconfirmed, so a flood costs it nothing and a well-behaved author sends them again.
- **The author.** It sends the latest version of each message only, oldest edit first, at most 10 frames in 10 seconds per chat; the rest wait. What is not confirmed goes again like an unconfirmed message (the outbox's policy: the backoff, 8 sends, a week; [PAIRED-CHAT-INCREMENT](PAIRED-CHAT-INCREMENT.md)) in a queue of its own, and at once on a new session, after the messages that session sends again, so the contact has the message first. A message that never left (`waiting`) carries its latest text when it goes. While the session is down, an edit may go on the DHT floor instead ([403](403-dht-text.md#edits)); a confirmation on either path settles both.
- **Why the session frame and not the offer.** `edit/1` is in `paired-capabilities`, like `typing/1`, rather than in the offer's `extensions`: it is something this session carries, said after the transcript is signed and bound to the connection, and the offer's lists are full for older apps.

Groups do not carry edits yet: 1:1 chats first. A mesh or community edit needs its own frame inside the group's sealed boxes, and a rule for members who joined after the message.

## Runtime boundary and compatibility

First contact runs on the DHT and on a stream in parallel, and native transports are tried from their descriptors in the capability record ([100](100-transports.md)). Compatibility chats use [402](402-legacy-chat.md) and never this session. DHT text uses [403](403-dht-text.md), preserving conversation/history without treating DHT as a stream adapter. Files and payments are negotiated in the offer; calls and shared apps after it ([above](#calls-and-shared-apps)).

## Evidence and checks

[Paired implementation profile](PAIRED-CHAT-INCREMENT.md), [paired session](../../packages/core/src/pairedSession.ts), [GhostLink](../../packages/core/src/ghostlink.ts), [durable outbox](../../packages/browser/src/engine/outbox.ts), [session capabilities](../../packages/core/src/pairedCapabilities.ts), [paired calls](../../packages/core/src/pairedCalls.ts), [typing](../../packages/core/src/pairedTyping.ts), [reactions](../../packages/core/src/reactions.ts), [edits](../../packages/core/src/pairedEdits.ts) and [the edit queue](../../packages/browser/src/engine/edits.ts). Exercise commit-before-ack, duplicate IDs, disconnect before receipt, restart, adapter switch and unsupported capability rejection.

## Revision log

- 0.12 (2026-09-27): `paired-bye`, the goodbye an app sends on its way out.
- 0.11 (2026-09-27): what a typing `start` says: `kind` (typing, recording, thinking) and a bot's `status` line (40 characters, plain text); older apps show typing.
- 0.10 (2026-09-27): edits, `edit/1` with `paired-edit` and `paired-edited` on the live session: the whole new text numbered per message, only the contact's own messages, a receive limit, an edit before its message waits a minute.
- 0.9 (2026-09-27): a file (a voice message included) can be a reply: `r` on its announcement, as on a text.
- 0.8 (2026-09-27): reactions, `react/1` with `paired-reaction` and `paired-reacted`, confirmed by number, capped per window.
- 0.7 (2026-09-27): replies (`r` on `paired-message`): the original's id, a cleaned line and its author, checked by the reader against this chat.
- 0.6 (2026-09-27): the typing indicator, `typing/1` and `paired-typing` on the live session only, 1:1 chats.
- 0.5.1 (2026-09-27): Desktop on Linux offers `calls/1` too, with its own call media (#331).
- 0.5 (2026-09-25): link previews (`pv` on `paired-message`), made by the sender and never fetched by the reader.
- 0.4 (2026-09-25): `files/3` announced in `paired-capabilities` too ([501](501-paired-files.md) 0.3).
- 0.3 (2026-09-25): `calls/1` and `services/1` announced after the handshake in `paired-capabilities`; both need a live session. Shared apps now need `services/1` on both sides.
- 0.2.1 (2026-09-25): hosted local services already run on this session (`ph` frames); only calls are the gap. Implementation status updated.
- 0.2 (2026-09-25): renamed Chat Session; the layer-1 session of the one chat; first contact may complete on the DHT; the `no-dht-payload` transcript constant explained; capabilities list; calls and hosted services named as gaps.
- 0.1 (2026-09-22): paired chat profile.
