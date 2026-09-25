# WISP 601: WebRTC Media

| Field | Value |
|---|---|
| Candidate number | 601; editorial family allocation |
| Status | Draft |
| Revision | 0.3 |
| Updated | 2026-09-25 |
| Document kind | Profile |
| Dependencies | [600](600-media.md) |
| Implementation | Compatibility chats (`_call`) and the chat session of every new chat (`calls/1`); capture varies by platform. |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Concrete signaling and media

The implemented 1:1 profile uses compact `_call` signaling and live `call` control frames, with ICE/fingerprint/candidate validation and a freshness window. Its v2 behavior pre-negotiates video so camera/screen changes can use `replaceTrack`; picture state is signaled separately. [Call signal validation](../../packages/core/src/callSignal.ts) and [the protocol](../PROTOCOL.md) define exact fields and legacy compatibility.

WebRTC is the media path. Voice, camera and screen permission must remain separate user choices; neither an invite nor a negotiated chat capability starts capture. End/hangup must stop capture tracks and release resources. Report permission denial or unavailable capture on the actual browser/native runtime.

## Paired profile

In the chat session ([401](401-paired-chat.md#calls-and-shared-apps)) calls are on while both sides offer `calls/1` on the live session.

Signaling: each compact signal above (offer `o`, answer `a`, hang-up `h`, picture state `v`: the JSON a compatibility chat keeps in `_call`) travels as `{"t":"paired-call","s":"<signal>"}` on the session, at most 8,192 characters. The receiver validates it as it would a `_call` record (anchored patterns, candidates re-serialized from their parts, the 120 second freshness window) and drops anything else, and drops every `paired-call` frame unless both sides offer `calls/1`. Nothing about a call is published on the DHT in this profile. A signal that could not go (the session dropped between two frames) is sent again on the next ready session while it is still fresh; clearing it (after a hang-up) means there is nothing left to say.

Media: always a WebRTC peer connection of its own, separate from the session, whatever carries the chat (WebRTC, Iroh or HyperDHT). Iroh and HyperDHT carry the session's text frames, not RTP; the call's connection gathers its own ICE candidates (STUN) and runs DTLS-SRTP end to end, as in a compatibility chat. The offer and answer carry that connection's DTLS fingerprint inside the authenticated session, so the media is bound to the contact the session authenticated, which a `_call` record read from the DHT does not give. A separate connection also means a transport switch of the chat does not interrupt a call.

An app without WebRTC (Desktop on Linux: WebKitGTK has none) does not offer `calls/1`, and says "Calls are not available in this app"; its contact's app says the contact cannot take calls. If the session drops during a call, the media goes on; the call ends on hang-up (sent on the next session while fresh) or when the media connection fails.

## Scope and evidence

This covers the calls of compatibility chats ([402](402-legacy-chat.md)) and of the chat session ([401](401-paired-chat.md)). It does not add group calls, an SFU or an end-to-end encrypted forwarding-service claim. See [React call hooks](../../packages/react), [paired calls](../../packages/core/src/pairedCalls.ts). Exercise accept/reject/hangup, stale signals, simultaneous calls, denied permissions and camera/screen transitions on supported platforms, and in the chat session the live-only rule and a contact without `calls/1`.

## Revision log

- 0.3 (2026-09-25): paired profile: `paired-call` signals on the live session, media on a WebRTC connection of its own whatever carries the chat.
- 0.2 (2026-09-25): scope named as compatibility chats; calls in the chat session being implemented.
- 0.1 (2026-09-22): WebRTC media profile.
