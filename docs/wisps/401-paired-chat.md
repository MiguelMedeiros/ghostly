# WISP 401: Chat Session

| Field | Value |
|---|---|
| Candidate number | 401; editorial family allocation |
| Status | Draft |
| Revision | 0.2 |
| Updated | 2026-09-25 |
| Document kind | Profile |
| Dependencies | [400](400-chat.md), [100](100-transports.md), [403](403-dht-text.md) |
| Implementation | The layer-1 session of every new chat (`paired-chat/1`): WebRTC, and native Iroh/HyperDHT where supported. First contact on the DHT and automatic upgrade (decided 2026-09-25; being implemented); calls planned. |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Role in the one chat (revision 0.2)

This is the **layer-1 session** of the one chat of [400](400-chat.md). Formerly "paired chat", it is no longer a kind of chat the person picks: every new chat is a `paired-chat/1` chat, whose layer 0 is the DHT ([403](403-dht-text.md)) and whose layer 1 is this session, when a transport connects. The wire identifiers (`paired-chat/1`, `chat/1`, the frame names) are unchanged.

What changes around this session:

- **First contact** can complete on the DHT ([403](403-dht-text.md#first-contact)) before any stream exists. When it does, this session later opens with the participation key already pinned: the handshake verifies against the pin exactly as a reconnect does today, and no comparison is asked again. When the stream wins the race instead, pinning happens here as today. Either way both paths MUST carry the same participation key; a mismatch is a security rejection on both layers. (New: today first contact needs this session.)
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

### Liveness and reconnection

A connection can die without either side being told (a laptop asleep, an app suspended in the background, a network change). While a session is ready, each side sends `{"t":"paired-ping"}` every 15 seconds and answers each one with `{"t":"paired-pong"}`. Any frame from the peer counts as a sign of life. Three pings in a row with nothing back close the session and its connection, and the dialling side tries again. This counts from the open for a peer whose `pair-offer` lists `ping/1` in `extensions`, so a contact that freezes before the first ping (a laptop closed right after connecting) is noticed too; for a peer that does not say so, it counts once that peer has answered a ping, and a peer that never answers one (an older app) is never cut off for it. Missed pings are counted, not timed, so a throttled background tab is not mistaken for a dead peer.

The side that dials waits 20 seconds after a failed attempt, doubling up to 3 minutes. A link that worked and then dropped is dialled again as soon as the contact is seen. Opening a chat, or bringing the window back, looks for the contact at once and starts the wait over; the side that does not dial republishes its presence so the other one sees it fresh. A chat whose contact was never seen (an invite just sent) keeps polling at the active pace for ten minutes even in the background. The side that does not dial, when it sees the other side just appear (a packet of its that is new and under 30 seconds old), polls at the signaling pace for 30 seconds: the offer follows that side's presence by a moment, and left to the background pace it waited up to 30 seconds on the relays. A contact that has been online a while is not waited on this way (nothing is coming now), so an app opening with many contacts does not spend the relays' budget on it.

## Capabilities on this session

The `pair-offer` lists what this session can carry: `chat/1`, `signed-signal/1`, and, when both apps offer them, `tofu/1`, `files/2`, `payments/1` with its per-method entries, `transport-switch/1`, `transport-fallback/1`, `hold/1`, proof and identity entries. Apps before 0.5 cap `capabilities` at 16 entries, so behaviour that grants nothing goes in `extensions` ([liveness](#liveness-and-reconnection)). The layer-0 capability record ([03](03-capabilities.md#layer-0-capability-record)) repeats the same identifiers so the DHT side knows them before this session exists; once this session is ready, its transcript-bound offer is authoritative for what the session carries.

Hosted local services ([700](700-local-services.md)) already run on this session: the HTTP frames of [701](701-http-services.md) travel inside `ph` application frames, without a negotiated capability, so an older app drops them ([pairedHttp.ts](../../packages/core/src/pairedHttp.ts)). Calls ([600](600-media.md)) do not: the app ignores call signals in a chat with this profile, so today calls exist only in compatibility chats ([402](402-legacy-chat.md)). Bringing calls here is required before the one chat can claim everything the old chat did (see [400](400-chat.md#what-each-state-can-carry)); it is being implemented.

## Runtime boundary and compatibility

Initial pairing currently uses WebRTC; revision 0.2 proposes first contact on the DHT in parallel and native transports tried from their descriptors in the capability record ([100](100-transports.md)). Compatibility chats use [402](402-legacy-chat.md) and never this session. DHT text uses [403](403-dht-text.md), preserving conversation/history without treating DHT as a stream adapter. Files, media, services and payments require their own capability rules.

## Evidence and checks

[Paired implementation profile](PAIRED-CHAT-INCREMENT.md), [paired session](../../packages/core/src/pairedSession.ts), [GhostLink](../../packages/core/src/ghostlink.ts), [durable outbox](../../packages/browser/src/engine/outbox.ts). Exercise commit-before-ack, duplicate IDs, disconnect before receipt, restart, adapter switch and unsupported capability rejection.

## Revision log

- 0.2.1 (2026-09-25): hosted local services already run on this session (`ph` frames); only calls are the gap. Implementation status updated.
- 0.2 (2026-09-25): renamed Chat Session; the layer-1 session of the one chat; first contact may complete on the DHT; the `no-dht-payload` transcript constant explained; capabilities list; calls and hosted services named as gaps.
- 0.1 (2026-09-22): paired chat profile.
