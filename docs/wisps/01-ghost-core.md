# WISP 01: Ghost Core Protocol

| Field | Value |
|---|---|
| Candidate number | 01; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [00](00-process.md) |
| Implementation | Rendezvous and DHT text in every client; the DHT as rendezvous and floor of every chat; Desktop and the Rust CLI read the Mainline DHT directly, the headless CLI when every relay fails (#392); a circuit breaker per Pkarr relay in every client, asked again every 15 s when all are down (#382, #395) |
| Summary | Find a peer through small signed records on the Mainline DHT, without turning discovery into storage. |
| Availability | Available |
| Notes | The rendezvous exists since the first release; the modular boundary is a proposal. |
| Feature | [The meeting on the DHT](https://ghostly.tools/#dht) |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## The DHT as rendezvous and floor (revision 0.2)

Ghost is layer 0 of every 1:1 chat ([400](400-chat.md)). It is always the **rendezvous**: where the invite's keys meet, where the first contact and handshake happen ([403](403-dht-text.md#first-contact)), where each side publishes its presence, its capability record ([03](03-capabilities.md#layer-0-capability-record)) and the signaling or descriptors a peer-to-peer transport needs ([100](100-transports.md)). It is also the **floor**: when no peer-to-peer transport connects, or the one in use drops, short text and its receipts travel in bounded records ([403](403-dht-text.md)), and a pointer can say where held items wait ([404](404-store-and-forward.md)). Everything larger leaves the DHT: it goes over layer 1, or into the sender's own storage.

What Ghost records may carry, per chat and per direction:

| Record | Content | Profile |
|---|---|---|
| Presence and signaling (the link's own key) | Online marker, `_rtc` WebRTC signaling, service advertisement | [PROTOCOL.md](../PROTOCOL.md), [101](101-webrtc.md) |
| DHT mailbox (`_dm`, `_dmk`) | One signed envelope: delivery mode, at most one text of 256 bytes, a receipt | [403](403-dht-text.md) |
| Capability record (`_caps`) | Transports, capabilities, minimal native descriptors, shared name | [03](03-capabilities.md#layer-0-capability-record) |
| Hold pointer (`_hold`) | Where the sender's held items are, what it received | [404](404-store-and-forward.md) |
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
6. A packet's time orders the packets of its key (it is the BEP44 sequence number): the relays and the DHT keep the one dated latest, and a relay answers 409 to one dated before the one it holds. A key is not always one device's with one clock: every member writes a group's rendezvous records, an inviter warms the key it gives its contact with an empty packet, and a device's clock may be set back. So a writer dates a packet by its own clock and past every packet it has put or read under that key; when a relay answers 409, it reads the packet that relay holds and, if that one is dated later, publishes again dated just past it, once. An empty packet put under a key for another device to write is dated a day before the writer's clock, so that device's first packet is the later one whatever its clock says. (Until 1.0.2 a packet was dated by its writer's clock alone: a joiner whose clock was behind its inviter's stayed unread until its clock passed the warm packet's time, two minutes or an hour, and a member whose clock was behind could not write a group's records. Dating a packet past a later one read under its key is a client rule, no wire change; the Desktop's own Pkarr client does not do it yet.)

## Compatibility and privacy

Keep the current wire profile unchanged until a migration is specified. Pkarr relay access and direct DHT access are ways of reaching rendezvous, not alternative application data transports. A relay can observe public keys, activity, packet sizes and plaintext metadata. DHT records are publicly retrievable by address; the shared secret protects contents. Presence expiry neither proves deletion nor hides network addresses. See [limitations](IMPLEMENTATION.md).

## Open decisions

Revision 2026-09-28 (implemented, client policy, no wire change): how one app shares the relays. A browser keeps 30 requests a minute per relay for all its links (`REQUESTS_PER_MINUTE` in `packages/core/src/relay.ts`), 60 on `pkarr.pubky.app` (#435). A 1:1 chat that polls fast, or whose request was refused, keeps the last 10 of each minute (`CHAT_RESERVE`); group requests stop at 20 meanwhile, until that chat reads its contact at a slow pace again; background reads drop from 20 to 5 while any link polls fast (#401, #434). A 1:1 chat's new WebRTC offer or answer, its fast reads for the answer to its own offer, and the reads of a DHT-only contact's mailbox once the contact shows it is leaving (up to three while it still says DHT only), may go over a relay's minute by a fifth of it (`SIGNALING_ALLOWANCE_SHARE`: 6 on 30, 12 on 60, 1 on relay.pkarr.org's 5), the reads leaving the last of those to a write. A group edge's requests for a member that may be back (its reads of a member that went away and its packet written meanwhile, `watch`; its offer, answer and reads for the answer, `signal`) may go over by less (`GROUP_SIGNALING_ALLOWANCE_SHARE`: 4 on 30, 8 on 60), its reads one at a time on a relay every 5 s, past the groups' ration and a waiting write, and leaving the last to a write. Groups' fast reads take at most a quarter of a relay's minute in any 15 s (never fewer than one link polling fast takes), a group's edges reading for members that went away from a live session and have not shown themselves back (`watch` on the request) take at most a third of it, spread over the minute (`WATCH_SHARE`), and once a group's read finds the minute full, the groups' reads are spread over it for a minute (a sixth in any 10 s, `GROUP_RATION_WINDOW_MS`), the key read longest ago first in both, and an offer to a saved contact is looked at every 2 s for 10 s, then every 4 to 8 s for as long as it stands, its attempt counted from when it reached the relays (bug hunt r5a). A read of a key answered under 500 ms ago is answered from memory (#427). A relay whose budget (or rate limit) held back a packet another relay took gets the newest packet of that key once it frees a request, as a background write (bug hunt r7a). While every relay is left alone for failing, the one whose wait ends first is asked every 15 s, and a new network forgets every breaker, in the TypeScript client and the Desktop's Rust client (#382, #395). The CLI publishes to the DHT beside the relays and reads the DHT when every relay fails (#392). Details: [TRANSPORTS.md](../TRANSPORTS.md#relay-budget-a-wait-not-an-error). These are one client's limits, not requirements on a peer; the open decision below on budgets across platforms stays open.

Revision 0.3 (implemented): native clients read the DHT directly. Desktop and the CLI resolve on the Mainline DHT and publish to the DHT and the relays; relay reads are an opt-in. They still write to the relays because a relay keeps serving the copy it holds for minutes, and browser contacts read only relays. Every client keeps a circuit breaker per relay. Records, sequence numbers and the relays' compare-and-swap (409, `If-Match`) are unchanged. The relay list and how one is chosen: [RELAYS.md](../RELAYS.md).

Revision 0.2: the read budget. Every chat now reads its contact's mailbox, and the relays' per-IP limit (50 requests a minute on pkarr.pubky.org) is shared by all of them; the pace table of [403](403-dht-text.md#poll-pace) slows reads while a chat is live. Whether a Ghostly-operated relay is needed for launch is a deployment question, not a protocol one.

Fix the extensible Core version envelope, record budget per future capability, replay watermark persistence, expiry/clock-skew rules and publication/poll budgets across platforms. Specify what happens when mandatory signaling alone exceeds the packet budget; do not split arbitrary heavy data across DHT records as a workaround.

## Conformance

Exchange current TypeScript/Rust fixtures; reject wrong signatures and tampered ciphertext; ignore unknown optional labels; exercise full packet budgets, stale packets and relay failures. Demonstrate a chat that pairs and talks with every stream blocked, a chat that chose DHT only, and a recipient without `dht-text/1` that receives nothing on the DHT while the sender queues. See [test plan](INTEROP.md).

## References

[Records](../../packages/core/src/records.ts), [Pkarr validation](../../packages/core/src/pkarr.ts), [link polling](../../packages/core/src/link.ts), [Pkarr](https://github.com/pubky/pkarr).

## Revision log

One file per change in [changes/01-ghost-core/](changes/01-ghost-core/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
