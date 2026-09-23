# WISP 401 — Paired Chat

| Field | Value |
|---|---|
| Candidate number | 401; editorial family allocation |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-22 |
| Document kind | Profile |
| Dependencies | [400](400-chat.md) |
| Implementation | Current paired WebRTC; native Iroh/HyperDHT where supported. |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Wire binding

This profile binds the independent [chat contract](400-chat.md) to the implemented `paired-chat/1` session and negotiated `chat/1` capability. Both peers authenticate participation keys and the agreed channel before application traffic. Data travels over the selected WebRTC, Iroh or HyperDHT adapter where that runtime provides it; a particular adapter is not part of the message identity.

Stable message IDs and the durable local outbox survive reconnect and transport changes. The receiver MUST store accepted content before returning the implemented storage acknowledgement. A retry reuses its message ID; an acknowledgement is not a read receipt. Local failures must not be reported as confirmed remote storage. No total ordering or globally exactly-once delivery is promised.

### Name and picture

Once the session is ready, and whenever they change, each side says how it wants to be shown: `{"t":"paired-nick","n":"<name>"}` and `{"t":"paired-avatar","a":"<picture>"}`. The picture is a square JPEG as a `data:image/jpeg;base64,` URL of at most 48,000 characters whose frame header declares no side over 512 pixels; an empty `a` means the picture was removed. A receiver MUST ignore any other value (another format, an address to fetch, a larger or malformed image) and MUST NOT fetch anything for it. A sender SHOULD redraw the chosen picture at 128×128 before sending, so no metadata of the original file (location, camera, edit history) travels. These frames carry no message ID; older apps drop them. Legacy chats ([402](402-legacy-chat.md)) have no room for a picture.

### Liveness and reconnection

A connection can die without either side being told (a laptop asleep, an app suspended in the background, a network change). While a session is ready, each side sends `{"t":"paired-ping"}` every 15 seconds and answers each one with `{"t":"paired-pong"}`. Any frame from the peer counts as a sign of life. Once a peer has answered a ping, three pings in a row with nothing back close the session and its connection, and the dialling side tries again. A peer that never answered a ping (an older app) is never cut off for it. Missed pings are counted, not timed, so a throttled background tab is not mistaken for a dead peer.

The side that dials waits 20 seconds after a failed attempt, doubling up to 3 minutes. A link that worked and then dropped is dialled again as soon as the contact is seen. Opening a chat, or bringing the window back, looks for the contact at once and starts the wait over; the side that does not dial republishes its presence so the other one sees it fresh. A chat whose contact was never seen (an invite just sent) keeps polling at the active pace for ten minutes even in the background.

## Runtime boundary and compatibility

Initial product pairing uses supported WebRTC behavior; native transport availability is negotiated separately. Legacy timestamp messages use [402](402-legacy-chat.md). Bounded DHT text uses [403](403-dht-text.md), preserving conversation/history without treating DHT as a stream adapter. Files, media, services and payments require their own capability rules.

## Evidence and checks

[Paired implementation profile](PAIRED-CHAT-INCREMENT.md), [paired session](../../packages/core/src/pairedSession.ts), [GhostLink](../../packages/core/src/ghostlink.ts), [durable outbox](../../packages/browser/src/engine/outbox.ts). Exercise commit-before-ack, duplicate IDs, disconnect before receipt, restart, adapter switch and unsupported capability rejection.
