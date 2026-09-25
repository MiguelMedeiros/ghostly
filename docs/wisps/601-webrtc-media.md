# WISP 601: WebRTC Media

| Field | Value |
|---|---|
| Candidate number | 601; editorial family allocation |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-22 |
| Document kind | Profile |
| Dependencies | [600](600-media.md) |
| Implementation | Compatible legacy WebRTC chats; capture varies by platform; not current paired sessions. |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Concrete signaling and media

The implemented 1:1 profile uses compact `_call` signaling and live `call` control frames, with ICE/fingerprint/candidate validation and a freshness window. Its v2 behavior pre-negotiates video so camera/screen changes can use `replaceTrack`; picture state is signaled separately. [Call signal validation](../../packages/core/src/callSignal.ts) and [the protocol](../PROTOCOL.md) define exact fields and legacy compatibility.

WebRTC is the media path. Voice, camera and screen permission must remain separate user choices; neither an invite nor a negotiated chat capability starts capture. End/hangup must stop capture tracks and release resources. Report permission denial or unavailable capture on the actual browser/native runtime.

## Scope and evidence

This is a legacy WebRTC capability, not an implemented paired/Iroh/HyperDHT media adapter. It does not add group calls, an SFU or an end-to-end encrypted forwarding-service claim. See [React call hooks](../../packages/react). Exercise accept/reject/hangup, stale signals, simultaneous calls, denied permissions and camera/screen transitions on supported platforms.
