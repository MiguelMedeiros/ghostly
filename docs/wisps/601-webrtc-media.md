# WISP 601: WebRTC Media

| Field | Value |
|---|---|
| Candidate number | 601; editorial family allocation |
| Status | Draft |
| Document kind | Profile |
| Dependencies | [600](600-media.md) |
| Implementation | Compatibility chats (`_call`) and the chat session of every new chat (`calls/1`); capture varies by platform. Desktop on Linux runs WebRTC in Rust and media in GStreamer (#331), with no screen sharing yet. The headless CLI calls with voice only (node-datachannel, the audio on a Unix socket, [11xx](11xx-headless.md#calls)). |
| Summary | One-to-one calls over WebRTC media, with compact call signaling. |
| Availability | Available |
| Notes | Screen sharing needs a computer; phone browsers can't share a screen. |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Concrete signaling and media

The implemented 1:1 profile uses compact `_call` signaling and live `call` control frames, with ICE/fingerprint/candidate validation and a freshness window. Its v2 behavior pre-negotiates video so camera/screen changes can use `replaceTrack`; picture state is signaled separately. [Call signal validation](../../packages/core/src/callSignal.ts) and [the protocol](../PROTOCOL.md) define exact fields and legacy compatibility.

WebRTC is the media path. Voice, camera and screen permission must remain separate user choices; neither an invite nor a negotiated chat capability starts capture. End/hangup must stop capture tracks and release resources. Report permission denial or unavailable capture on the actual browser/native runtime.

## Paired profile

In the chat session ([401](401-paired-chat.md#calls-and-shared-apps)) calls are on while both sides offer `calls/1` on the live session.

Signaling: each compact signal above (offer `o`, answer `a`, hang-up `h`, picture state `v`: the JSON a compatibility chat keeps in `_call`) travels as `{"t":"paired-call","s":"<signal>"}` on the session, at most 8,192 characters. The receiver validates it as it would a `_call` record (anchored patterns, candidates re-serialized from their parts, the 120 second freshness window) and drops anything else, and drops every `paired-call` frame unless both sides offer `calls/1`. Nothing about a call is published on the DHT in this profile. A signal on the session carries up to eight candidates (a `_call` record keeps one host and one server reflexive, a DHT packet's worth): host candidates on local networks first, then the server reflexive one and relay ones, IPv6, and last the host candidates a browser marks as costly (a VPN tunnel). A computer often has several interfaces, and the one listed first is not always one the contact can reach: on a Mac whose default route is a VPN, it is the tunnel's address, which nothing on that machine can answer. A call uses the STUN servers of the apps and then the profile's own ICE servers (Settings → Network), so a TURN relay set there carries the calls a direct path cannot: a VPN that takes every packet through its tunnel, or a NAT that maps each destination apart. The Linux Desktop's own call connection uses only the apps' STUN server so far, not the profile's ICE servers (`STUN` in `src-tauri/src/native_call/engine.rs`). A signal that could not go (the session dropped between two frames) is sent again on the next ready session while it is still fresh; clearing it (after a hang-up) means there is nothing left to say.

Media: always a WebRTC peer connection of its own, separate from the session, whatever carries the chat (WebRTC, Iroh or HyperDHT). Iroh and HyperDHT carry the session's text frames, not RTP; the call's connection gathers its own ICE candidates (host, STUN and, with the profile's TURN relay, relay ones) and runs DTLS-SRTP end to end, as in a compatibility chat. The offer and answer carry that connection's DTLS fingerprint inside the authenticated session, so the media is bound to the contact the session authenticated, which a `_call` record read from the DHT does not give. A separate connection also means a transport switch of the chat does not interrupt a call.

**Offering again.** A caller whose connection did not come up may send one new offer, on a new connection (the headless CLI does when its WebRTC library refused a good answer, #403). An answerer that took a call whose connection never reached connected (ICE and DTLS) answers a second offer by starting over: it closes that connection and answers on a new one with the same microphone and camera, asking nothing again. When that connection fails first, it waits 8 s for such an offer before it ends the call, once: a failure after starting over is final. A call this side placed, or one whose connection came up, ignores offers as before (`RESTART_GRACE_MS` in `packages/react/src/useWebRTC.ts`, #407). An older answerer rings a second offer as a new call.

**Both call at once.** An offer that arrives while this side is calling (its own offer sent or still gathering) is glare. Both sides decide the same way from the two offers: the one with the earlier `ts` wins, and at the same millisecond the one whose DTLS fingerprint (`f`) sorts lower. An offer still gathering counts as later. The side whose offer lost drops its own attempt and releases its microphone and camera. It sends no hang-up, because that would end the winner's call, and it rings with the winner's offer like any incoming call. The winner goes on calling. The apps do this: the web app, the extension and Desktop, whose Linux native media runs under the same call logic (`packages/react/src/useWebRTC.ts`; its Rust engine only makes the offer and answer it is asked for). The headless CLI does too (`packages/cli/src/calls/manager.ts`): its call that lost ends as `crossed`, and the contact's call rings as `call.incoming`.

**Ringing.** An unanswered call rings for 60 s. The caller then hangs up (a hang-up `h`, as when the person cancels) and says "No answer". The side it rang stops ringing on its own after 60 s from when the offer arrived, sends nothing, and keeps a "Missed call" line in the chat; so does a caller's hang-up that arrives while it rings. Each side times its own ring, so an older caller that never gives up still stops ringing here. The apps time both sides with `RING_MS` in `packages/react/src/useWebRTC.ts`. The headless CLI rings a call it places for the same 60 s (`RING_MS` in `packages/cli/src/calls/manager.ts`) and reports a call it was rung for as missed when the caller hangs up or the offer goes stale (120 s). No signal was added.

An app that cannot call does not offer `calls/1` and says why on its call buttons ("Calls are not available in this app", or its own reason); its contact's app says the contact cannot take calls. If the session drops during a call, the media goes on; the call ends on hang-up (sent on the next session while fresh) or when the media connection fails.

## Desktop on Linux

WebKitGTK, the WebView of Ghostly Desktop on Linux, is built without WebRTC by Ubuntu (22.04, 24.04), Debian 13 and Fedora 42: there is no `RTCPeerConnection`, and turning on WebKit's `enable-webrtc` setting changes nothing. So the Linux app runs the media connection itself, in Rust, and nothing on the wire changes: the same compact signals, the same WebRTC (ICE with STUN, DTLS-SRTP, Opus and VP8), so it calls browsers and other Desktops alike.

- **WebRTC** is `webrtc-rs`. Its host candidates end at `typ host` (browsers add `generation 0`), which a signal must still read as a host candidate; a socket on an unspecified address (`::` where there is no IPv6) gives no candidate.
- **Media** is GStreamer: the microphone to Opus, the camera to VP8, and back through a jitter buffer to the speakers and to the page, which shows the peer's picture as JPEG frames drawn on a canvas. Only gst-plugins-base and gst-plugins-good are used; WebKitGTK depends on both, so an installed app has them. Not GStreamer's `webrtcbin`: its libnice links libsoup 2 on Ubuntu 22.04 and Debian 12, and loading libsoup 2 into a WebKitGTK 4.1 process (libsoup 3) aborts it.
- **Devices** are GStreamer's, known to the page by name: Settings lists them and the calls use the chosen ones. The page cannot hear that microphone or play on that speaker, so Settings' level meter reads GStreamer's `level` element on the chosen microphone, and its test sound is a one-second tone GStreamer plays on the chosen speaker.
- **Missing plugins**: the app checks for every element it uses when it starts. When one is missing it does not offer `calls/1`, and its call buttons name the packages to install.
- **Screen sharing** is not available on Linux yet (it needs the desktop portal): the share button stays in the call window, turned off, with that reason.

Permissions are the same choices: capture starts only when the person places or answers a call, or turns the camera on, and stops on hang-up.

## Headless Ghostly

The headless CLI ([11xx](11xx-headless.md#calls)) calls and answers in the chat session too, voice only, with its media in libdatachannel and Opus in WebAssembly, and hands the audio to a program. Nothing on the wire changes. Its offers have an audio section alone; it answers a contact's video section and drops what comes on it. Its signals carry up to eight candidates, every IPv4 host first (a server often has several interfaces), which a receiver already accepts.

## Scope and evidence

This covers the calls of compatibility chats ([402](402-legacy-chat.md)) and of the chat session ([401](401-paired-chat.md)), in browsers and in the Linux Desktop's native media (`src-tauri/src/native_call`, `src/desktop/nativeCalls.ts`). It does not add group calls, an SFU or an end-to-end encrypted forwarding-service claim. See [React call hooks](../../packages/react), [paired calls](../../packages/core/src/pairedCalls.ts). Exercise accept/reject/hangup, stale signals, simultaneous calls, denied permissions and camera/screen transitions on supported platforms, and in the chat session the live-only rule and a contact without `calls/1`.

## Revision log

One file per change in [changes/601-webrtc-media/](changes/601-webrtc-media/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
