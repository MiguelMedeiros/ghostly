# WISP 01: Ghost Core Protocol

| Field | Value |
|---|---|
| Candidate number | 01; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.2 |
| Updated | 2026-09-25 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [00](00-process.md) |
| Implementation | Existing rendezvous and DHT text; the DHT as rendezvous and floor of every chat (decided 2026-09-25; being implemented) |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## The DHT as rendezvous and floor (revision 0.2)

Ghost is layer 0 of every 1:1 chat ([400](400-chat.md)). It is always the **rendezvous**: where the invite's keys meet, where the first contact and handshake happen ([403](403-dht-text.md#first-contact)), where each side publishes its presence, its capability record ([03](03-capabilities.md#layer-0-capability-record)) and the signaling or descriptors a peer-to-peer transport needs ([100](100-transports.md)). It is also the **floor**: when no peer-to-peer transport connects, or the one in use drops, short text and its receipts travel in bounded records ([403](403-dht-text.md)), and a pointer can say where held items wait ([4xx](4xx-store-and-forward.md)). Everything larger leaves the DHT: it goes over layer 1, or into the sender's own storage.

What Ghost records may carry, per chat and per direction:

| Record | Content | Profile |
|---|---|---|
| Presence and signaling (the link's own key) | Online marker, `_rtc` WebRTC signaling, service advertisement | [PROTOCOL.md](../PROTOCOL.md), [101](101-webrtc.md) |
| DHT mailbox (`_dm`, `_dmk`) | One signed envelope: delivery mode, at most one text of 256 bytes, a receipt | [403](403-dht-text.md) |
| Capability record (new) | Transports, capabilities, minimal native descriptors, shared name | [03](03-capabilities.md#layer-0-capability-record) |
| Hold pointer (`_hold`) | Where the sender's held items are, what it received | [4xx](4xx-store-and-forward.md) |
| Compatibility `_msgs` | Timestamp text batches of v0.4 chats | [402](402-legacy-chat.md) |

## Purpose and current behavior

Ghost is a minimal, ephemeral rendezvous and small-record exchange primitive over Pkarr/Mainline DHT. Records can contain small encrypted messages and signaling, not only pointers to a homeserver. Ghostly currently composes it with WebRTC and application services. Local history is separate from network presence.

The existing profile is [PROTOCOL.md](../PROTOCOL.md): signed Pkarr DNS packets, at most 1000 DNS bytes; secretbox-encrypted values except plaintext `_ts` and `_ack`; record TTL 300 seconds. `records.ts` prioritizes signaling, then advertisements, then messages that fit. This is not a new WISP wire version.

## Candidate requirements

1. Verify packet signature and expected publishing key before parsing private payloads; authenticate encrypted fields, validate lengths and treat all content as untrusted.
2. Keep rendezvous records bounded. Publish only enough discovery, small data and signaling to establish an allowed session. Bulk files, media, group fanout, history replication and payment tokens MUST leave the DHT.
3. Small DHT text is the floor of every 1:1 chat, not an accident of a failed transport: each side declares whether it accepts it (`dht-text/1` in its capability record, on by default), and a sender falls back to it only for a recipient that does. A failed data transport MUST NOT silently relax a recipient's refusal: without `dht-text/1`, text waits for layer 1. (Revision 0.1 treated automatic small-text fallback as legacy behavior; revision 0.2 makes it the declared rule. Compatibility chats of [402](402-legacy-chat.md) keep their own `_msgs` fallback.)
4. Unknown optional record labels are ignored. A future mandatory extension or incompatible version needs explicit negotiation; adding a label MUST NOT silently reinterpret existing `_msgs`, `_call` or `_rtc` values.
5. Histories and peer state remain local unless a separately authorized synchronization capability is selected. A homeserver is not required by Core.

## Compatibility and privacy

Keep the current wire profile unchanged until a migration is specified. Pkarr relay access and direct DHT access are ways of reaching rendezvous, not alternative application data transports. A relay can observe public keys, activity, packet sizes and plaintext metadata. DHT records are publicly retrievable by address; the shared secret protects contents. Presence expiry neither proves deletion nor hides network addresses. See [limitations](IMPLEMENTATION.md).

## Open decisions

Revision 0.3: native clients read the DHT directly. Desktop and the CLI resolve on the Mainline DHT and publish to the DHT and the relays; relay reads are an opt-in. They still write to the relays because a relay keeps serving the copy it holds for minutes, and browser contacts read only relays. Every client keeps a circuit breaker per relay. Records, sequence numbers and the relays' compare-and-swap (409, `If-Match`) are unchanged. The relay list and how one is chosen: [RELAYS.md](../RELAYS.md).

Revision 0.2: the read budget. Every chat now reads its contact's mailbox, and the relays' per-IP limit (50 requests a minute on pkarr.pubky.org) is shared by all of them; the pace table of [403](403-dht-text.md#poll-pace) slows reads while a chat is live. Whether a Ghostly-operated relay is needed for launch is a deployment question, not a protocol one.

Fix the extensible Core version envelope, record budget per future capability, replay watermark persistence, expiry/clock-skew rules and publication/poll budgets across platforms. Specify what happens when mandatory signaling alone exceeds the packet budget; do not split arbitrary heavy data across DHT records as a workaround.

## Conformance

Exchange current TypeScript/Rust fixtures; reject wrong signatures and tampered ciphertext; ignore unknown optional labels; exercise full packet budgets, stale packets and relay failures. Demonstrate a chat that pairs and talks with every stream blocked, a chat that chose DHT only, and a recipient without `dht-text/1` that receives nothing on the DHT while the sender queues. See [test plan](INTEROP.md).

## References

[Records](../../packages/core/src/records.ts), [Pkarr validation](../../packages/core/src/pkarr.ts), [link polling](../../packages/core/src/link.ts), [Pkarr](https://github.com/pubky/pkarr).

## Revision log

- 0.2 (2026-09-25): the DHT as rendezvous and floor of every chat; what records a chat may carry; small DHT text as a declared rule rather than legacy behavior; read budget.
- 0.1 (2026-09-20): initial review draft.
