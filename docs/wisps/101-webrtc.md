# WISP 101: WebRTC

| Field | Value |
|---|---|
| Candidate number | 101; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [100](100-transports.md) |
| Implementation | Existing adapter in the web app, the extension, Desktop on macOS and Windows (Linux WebKitGTK has no WebRTC) and the headless CLI (node-datachannel); a TURN server of the person's own per profile, also used by the Linux Desktop's native calls (webrtc-rs); WISP binding proposed |
| Summary | Carry a session over a WebRTC data channel, the direct path browsers have. |
| Availability | Available |
| Notes | Browser, extension, desktop and the CLI, except the Linux desktop, whose webview has no WebRTC. Public STUN servers help through home routers, and you can set your own TURN server in Settings, for chats and calls. |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Place in the one chat (revision 0.2)

WebRTC is one layer-1 candidate of the one chat ([400](400-chat.md), [100](100-transports.md#the-dht-floor-upgrade-and-downgrade-revision-02)), and the only direct one in browsers and the extension (they reach Iroh, and HyperDHT when a relay is set, only through a relay: [102](102-iroh.md), [103](103-hyperdht.md)). Its `_rtc` signaling rides layer 0, in the link's own signed record, as today. A WebRTC attempt that does not connect (no ICE path, no TURN, a blocked network) no longer fails a first pairing: the chat stays `on-dht` and retries in the background. A WebRTC session that drops sends the chat to `on-dht` until it or another transport is back. In a compatibility chat ([402](402-legacy-chat.md)) the legacy WebRTC link is that chat's layer 1, with its own frames, calls and files.

## Local experimental increment

The follow-up adds transcript-negotiated signed signaling, durable per-message delivery/retry state and observed extension interoperability; see the [implementation profile](PAIRED-CHAT-INCREMENT.md) for exact partial coverage and residual risks. This does not change Draft status.

The [chat session increment](PAIRED-CHAT-INCREMENT.md), now the live session of every new chat ([401](401-paired-chat.md)), exercises a limited subset of this draft. It is not full conformance or a replacement for the broader candidate design below. Read its exact wire profile, local admission boundary and limitations separately from the legacy baseline.

## Existing profile

WebRTC carries the current live data link. `_rtc` conveys compact ICE credentials, DTLS fingerprint and candidates inside encrypted, signed records. The data channel is `ghostly/1`, negotiated ID 0, ordered and reliable. Simultaneous offers are resolved by the lower peer public key retaining its offer, once it is out: a side still gathering the candidates of its offer has sent nothing, and answers the peer's offer instead, whatever the keys. An offer older than 120 seconds is ignored, and its age is counted on the reader's clock, not by holding the maker's `ts` against it: `ts` is the maker's clock, often minutes from the reader's. An offer is new when a read of the maker's record that the network answered did not have it (a copy a transport kept from before is not such a read) and it is not dated before the maker's own packet that read found; `ts` and that packet's time are the same clock, so the comparison holds whatever the two devices' clocks say. It is then at most as old as the time since that read. When that read found nothing of the maker's, there is no packet to hold the offer against: only a first contact goes by the read alone (a first pairing before the pin, or a group's link, whose records only its two members write), and then only when the offer's `ts` is within ten minutes of the reader's clock; in a chat with a pinned contact such an offer is judged by its `ts`, as one found at the first read of a run is: within 120 seconds of the reader's clock, either way. An offer that comes on a live session is heard when its frame comes. An answer has no age to check: it names the offer it answers, which the reader made in the attempt under way. A signal dated more than ten minutes ahead of the reader's clock is not taken: its time would outrank every later signal of its maker. (Until 1.0.2 every signal was judged that way, so two devices two minutes apart never connected over WebRTC, and such a reader still drops the signals of a contact that far from it.) Connection timeout is 90 seconds and ICE gathering is bounded at five seconds. An answer whose connection fails while the offer still stands in the offerer's record, with more than 15 seconds of the offerer's 90 left, is made again for the same offer, up to twice: the offerer's read of the answer may wait for its relays' budget longer than the answerer's ICE waits for it (about 30 seconds). An offerer that reads a newer answer to the offer it already applied an answer to gives that attempt up at once and dials again: the connection the applied answer belonged to is gone.

The expected DTLS fingerprint is authenticated by the link's rendezvous context. STUN helps discover addresses; configured TURN can relay encrypted traffic. Direct paths do not guarantee IP anonymity. Media uses a separate peer connection in the current implementation.

## Your own TURN server

A network that lets no direct path through (a strict NAT, a firewall that drops UDP) still connects over a TURN relay. Each profile may name one in Settings, Network: a `turn:` or `turns:` address (a host, an optional port and `?transport=udp|tcp` at most), a username and a credential. A TURN server without both is refused when saved. The apps add it after their built-in STUN servers, for chats over WebRTC and for calls ([601](601-webrtc-media.md)): in the web app, the extension, Desktop on macOS and Windows, the Linux desktop's native calls (webrtc-rs, which then gathers until it has a relay candidate, as a browser does) and the CLI. The relay sees only encrypted packets and the two addresses. The credential is a secret: it is never logged, and a backup leaves it out ([05](05-backups.md)), so a restored profile shows the server and asks for the credential again, and calls skip that server until it is entered.

## Candidate WISP binding

Preserve current signaling as a legacy adapter profile. A future profile MUST bind WebRTC fingerprint, both participation keys, selected capabilities and fresh transport attempt context before accepting data. Advertise data/media capability separately. ICE privacy policies, candidate filtering and TURN consent must survive fallback negotiation.

Keep frame limits and backpressure from the existing data link: 16 KiB binary chunks, 60 KiB accepted control frames, pause above 1 MiB buffered and resume below 256 KiB. These are distinct limits, not a claim that every WebRTC message is at most 16 KiB. Never infer application persistence from reliable channel delivery.

## Compatibility and open decisions

Specify migration between legacy link-secret authentication and future participation-key binding, restart/renegotiation states, supported candidate policies and media coexistence. A PeerJS-based implementation must still implement the selected wire profile; using PeerJS alone does not imply interoperability.

## Conformance

Connect independent engines; verify simultaneous offers, stale signaling rejection, wrong fingerprint failure, direct and explicitly allowed TURN paths, reconnect and backpressure. Include browser permission denials and platform-specific unavailable capabilities.

## References

[DataLink](../../packages/core/src/datalink.ts), [signaling](../../packages/core/src/signal.ts), [frames](../../packages/core/src/frames.ts), [current protocol](../PROTOCOL.md).

## Revision log

One file per change in [changes/101-webrtc/](changes/101-webrtc/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
