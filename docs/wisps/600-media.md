# WISP 600: Voice and Video

| Field | Value |
|---|---|
| Candidate number | 600; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [03](03-capabilities.md), [100](100-transports.md) |
| Implementation | 1:1 calls, with screen sharing from inside a call, in every chat: compatibility chats (`_call`) and the chat session (`calls/1`, live only) |
| Summary | Voice, video and screen sharing, coordinated apart from the data stream. |
| Availability | Available |
| Notes | In every chat while it is live, the Linux desktop included (with media of its own, its webview having no WebRTC; no screen sharing there yet). The microphone, camera and speaker are chosen in Settings and switched during a call. Not in groups. |
| Feature | [Calls](https://ghostly.tools/#next) |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Contract and concrete profiles

This document defines common responsibilities and proposed extensions. Exact implemented encodings and runtime limits belong to [601 · WebRTC Media](601-webrtc-media.md). Supporting a concrete profile does not establish full conformance to this Draft.

## Implemented scope

See the concrete profiles above for current fields, limits, receipt semantics and runtime availability. Contract requirements below are separately reviewable; proposed extensions are not shipped merely because a profile exists.

## Candidate requirements

Negotiate voice, camera and screen as distinct capabilities and preserve platform permission/consent. An invitation or identity proof is not permission to activate capture. Map a call ID and fresh session context to media endpoints; terminate capture and related resources when the user ends the operation. Report unavailable capture modes honestly on each platform.

Media transport is negotiated for its actual properties, not assumed to work because chat works over the adapter. Keep media and heavy signaling off the DHT after connection whenever possible. Bounded initial signaling may remain in Core. The chat session profile ([601](601-webrtc-media.md#paired-profile)) takes all call signaling off the DHT: the signals travel on the authenticated live session and the media on a WebRTC connection of its own, whatever transport carries the session, so a call needs a live chat.

## Compatibility, privacy and open decisions

The implemented profile depends conditionally on 101. Other media adapters, group calls, SFU topology, congestion policy and end-to-end media encryption through a forwarding service require separate validation within this draft/900. Do not equate group transport encryption to end-to-end encryption against the forwarding node. No group media guarantee is made here.

## Conformance

Test independent WebRTC engines, accept/reject/hangup, stale call replay, simultaneous attempts, camera/screen transitions, permission denial and reconnect. Document which capture combinations and legacy behaviors pass per platform.

## References

[Call signal validation](../../packages/core/src/callSignal.ts), [shared React hooks](../../packages/react), [current calls](../PROTOCOL.md), [WebRTC](101-webrtc.md).

## Revision log

One file per change in [changes/600-media/](changes/600-media/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
