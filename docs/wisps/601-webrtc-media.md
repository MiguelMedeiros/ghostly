# WISP 601: WebRTC Media

| Field | Value |
|---|---|
| Candidate number | 601; editorial family allocation |
| Status | Draft |
| Revision | 0.5 |
| Updated | 2026-09-26 |
| Document kind | Profile |
| Dependencies | [600](600-media.md) |
| Implementation | Compatibility chats (`_call`) and the chat session of every new chat (`calls/1`); capture varies by platform. Desktop on Linux runs WebRTC in Rust and media in GStreamer (#331), with no screen sharing yet. |
| Summary | One-to-one calls over WebRTC media, with compact call signaling. |
| Availability | Available |
| Notes | Screen sharing needs a computer; phone browsers can't share a screen. |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Concrete signaling and media

The implemented 1:1 profile uses compact `_call` signaling and live `call` control frames, with ICE/fingerprint/candidate validation and a freshness window. Its v2 behavior pre-negotiates video so camera/screen changes can use `replaceTrack`; picture state is signaled separately. [Call signal validation](../../packages/core/src/callSignal.ts) and [the protocol](../PROTOCOL.md) define exact fields and legacy compatibility.

WebRTC is the media path. Voice, camera and screen permission must remain separate user choices; neither an invite nor a negotiated chat capability starts capture. End/hangup must stop capture tracks and release resources. Report permission denial or unavailable capture on the actual browser/native runtime.

## Paired profile

In the chat session ([401](401-paired-chat.md#calls-and-shared-apps)) calls are on while both sides offer `calls/1` on the live session.

Signaling: each compact signal above (offer `o`, answer `a`, hang-up `h`, picture state `v`: the JSON a compatibility chat keeps in `_call`) travels as `{"t":"paired-call","s":"<signal>"}` on the session, at most 8,192 characters. The receiver validates it as it would a `_call` record (anchored patterns, candidates re-serialized from their parts, the 120 second freshness window) and drops anything else, and drops every `paired-call` frame unless both sides offer `calls/1`. Nothing about a call is published on the DHT in this profile. A signal that could not go (the session dropped between two frames) is sent again on the next ready session while it is still fresh; clearing it (after a hang-up) means there is nothing left to say.

Media: always a WebRTC peer connection of its own, separate from the session, whatever carries the chat (WebRTC, Iroh or HyperDHT). Iroh and HyperDHT carry the session's text frames, not RTP; the call's connection gathers its own ICE candidates (STUN) and runs DTLS-SRTP end to end, as in a compatibility chat. The offer and answer carry that connection's DTLS fingerprint inside the authenticated session, so the media is bound to the contact the session authenticated, which a `_call` record read from the DHT does not give. A separate connection also means a transport switch of the chat does not interrupt a call.

An app that cannot call does not offer `calls/1` and says why on its call buttons ("Calls are not available in this app", or its own reason); its contact's app says the contact cannot take calls. If the session drops during a call, the media goes on; the call ends on hang-up (sent on the next session while fresh) or when the media connection fails.

## Desktop on Linux

WebKitGTK, the WebView of Ghostly Desktop on Linux, is built without WebRTC by Ubuntu (22.04, 24.04), Debian 13 and Fedora 42: there is no `RTCPeerConnection`, and turning on WebKit's `enable-webrtc` setting changes nothing. So the Linux app runs the media connection itself, in Rust, and nothing on the wire changes: the same compact signals, the same WebRTC (ICE with STUN, DTLS-SRTP, Opus and VP8), so it calls browsers and other Desktops alike.

- **WebRTC** is `webrtc-rs`. Its host candidates end at `typ host` (browsers add `generation 0`), which a signal must still read as a host candidate; a socket on an unspecified address (`::` where there is no IPv6) gives no candidate.
- **Media** is GStreamer: the microphone to Opus, the camera to VP8, and back through a jitter buffer to the speakers and to the page, which shows the peer's picture as JPEG frames drawn on a canvas. Only gst-plugins-base and gst-plugins-good are used; WebKitGTK depends on both, so an installed app has them. Not GStreamer's `webrtcbin`: its libnice links libsoup 2 on Ubuntu 22.04 and Debian 12, and loading libsoup 2 into a WebKitGTK 4.1 process (libsoup 3) aborts it.
- **Missing plugins**: the app checks for every element it uses when it starts. When one is missing it does not offer `calls/1`, and its call buttons name the packages to install.
- **Screen sharing** is not available on Linux yet (it needs the desktop portal): the share button stays in the call window, turned off, with that reason.

Permissions are the same choices: capture starts only when the person places or answers a call, or turns the camera on, and stops on hang-up.

## Scope and evidence

This covers the calls of compatibility chats ([402](402-legacy-chat.md)) and of the chat session ([401](401-paired-chat.md)), in browsers and in the Linux Desktop's native media (`src-tauri/src/native_call`, `src/desktop/nativeCalls.ts`). It does not add group calls, an SFU or an end-to-end encrypted forwarding-service claim. See [React call hooks](../../packages/react), [paired calls](../../packages/core/src/pairedCalls.ts). Exercise accept/reject/hangup, stale signals, simultaneous calls, denied permissions and camera/screen transitions on supported platforms, and in the chat session the live-only rule and a contact without `calls/1`.

## Revision log

- 0.5 (2026-09-26): Desktop on Linux calls: WebRTC in Rust (webrtc-rs), media in GStreamer, no wire change; a host candidate may end at `typ host`. Tested between two Linux Desktops (e2e/desktop/calls.spec.ts) and against Chromium both ways (e2e/desktop/calls-interop.spec.ts).

- 0.4 (2026-09-25): signals carry the Opus/VP8 payload types when not 111/96 (`ap`, `vp`; PROTOCOL.md §4.2) and accept an IPv6 related address: WebKit's offers rang nowhere or showed one picture. Found by two Desktop apps on a Mac (e2e/desktop-macos/).
- 0.3 (2026-09-25): paired profile: `paired-call` signals on the live session, media on a WebRTC connection of its own whatever carries the chat.
- 0.2 (2026-09-25): scope named as compatibility chats; calls in the chat session being implemented.
- 0.1 (2026-09-22): WebRTC media profile.
