# The Ghost Protocol

Ghostly is an ephemeral, identity-addressed peer-to-peer service layer. Chat, voice, video and web applications are services on top of it. A peer's live endpoints are reachable while the peer is online; local history and other retained state can remain afterwards.

This document describes the protocol as implemented in [`packages/core`](../packages/core), which Ghostly Desktop, Ghostly Browser and the CLI share. The [WISP working catalogue](wisps/README.md) separates this implemented profile from proposed modular extensions and groups. Sections marked **v1** or **v2** are additions; everything else is the protocol Ghostly has always spoken, unchanged.

Every new chat uses the [chat session](wisps/401-paired-chat.md) (`paired-chat/1`, first described as the [paired-chat increment](wisps/PAIRED-CHAT-INCREMENT.md)): version agreement and participation-key pinning over WebRTC, or Iroh and HyperDHT between desktops ([native transports](wisps/TRANSPORT-INCREMENT.md)), with [DHT text](wisps/403-dht-text.md) as its fallback. The one-chat model of [WISP 400](wisps/400-chat.md) (DHT rendezvous and floor, peer-to-peer upgrade, one `ghostly1` invite) was decided on 2026-09-25 and is being implemented. The sections below describe the record and signaling profile of compatibility chats ([WISP 402](wisps/402-legacy-chat.md), Ghostly 0.4 contacts), which current apps still read and write.

## 1. Identities and links

An identity is an Ed25519 keypair. Its public key, z-base-32 encoded (52 characters), is the peer's [Pkarr](https://github.com/pubky/pkarr) address.

Two peers are connected by a **link**:

| Field | Meaning |
|---|---|
| my seed | 32 byte Ed25519 seed of my identity for this link |
| peer public key | the peer's identity for this link |
| encryption key | 32 byte NaCl secretbox key shared by both |

The peer that creates a link generates both keypairs and the key, keeps one side and hands the other to its peer as an invite:

```
<seed, base64url>/<peer public key, z-base-32>/<encryption key, base64url>
```

Every link has its own identities, persisted locally for reconnection. This avoids reusing one identity across links, but network addresses, timing or application data can still correlate peers. The creator initially knows both seeds. Any holder of a copied invite has the joining seed and shared encryption key; the legacy format is not cryptographically consumed after joining. Removing its display does not revoke a copy. See the proposed [key lifecycle](wisps/02-peer-keys.md) and [admission protocol](wisps/800-invite-join.md).

The invite is a bearer secret and must travel over a private channel.

## 2. Discovery: Pkarr records

Each peer publishes one Pkarr signed packet under its link identity and polls the peer's. A packet is a DNS message with TXT records, signed per BEP44 and stored in the Mainline DHT. The DNS message is at most **1000 bytes**.

All values except `_ts` and `_ack` are `base64(nonce(24) || secretbox(plaintext))` with XSalsa20-Poly1305 under the link key. TTL is 300 seconds. This is not guaranteed erasure: observers, contacts and infrastructure can retain copies. A later leak of the symmetric link key can expose previously recorded values encrypted under that key; per-link identities alone do not provide forward secrecy.

| Label | Content | Since |
|---|---|---|
| `_msgs` | JSON array of `{ "t": <ms timestamp>, "m": <text> }`, oldest first, the messages the peer has not acknowledged yet | v0 |
| `_ts` | timestamp of the newest message in `_msgs`, plaintext | v0 |
| `_ack` | newest peer message timestamp I have received, plaintext | v0 |
| `_nick` | my nickname | v0 |
| `_call` | voice/video signaling, see §4 | v0 |
| `_svc` | service advertisement, see §3 | **v1** |
| `_rtc` | data link signaling, see §5 | **v1** |

Clients ignore labels they do not know. A v0 client therefore keeps working with a v1 peer: it chats and calls, and simply does not see services.

**Packet budget.** When everything does not fit in 1000 bytes, space goes to `_ts`, `_ack`, `_nick`, `_call` and `_rtc` first, then `_svc`, then as many of the newest messages as fit (the encrypted batch is also capped at 800 characters, as before). If it still does not fit, `_svc` is left out; the data link repeats the advertisement (§6.1).

**Presence.** A peer that advertises services publishes on start and republishes every 4 minutes. It is considered online while its packet carries `_svc` and is younger than 10 minutes. When it goes offline it publishes once more without `_svc` and `_rtc`. If it cannot (the machine lost power), the packet goes stale on its own. Presence is a hint; the real test is whether the data link comes up.

**Transports.** Desktop and the CLI talk to the DHT directly and to Pkarr relays (the Rust client's defaults). Browsers cannot open UDP sockets and use relays only: `PUT /<key>` and `GET /<key>` with `<signature(64)><timestamp µs, u64 BE><DNS packet>`. A relay is an HTTP bridge to the DHT. It sees public keys, signed packets, plaintext `_ts`/`_ack`, sizes and activity. Without link secrets it cannot decrypt protected values or forge the expected signature. It carries the small application messages present in records, but not bulk data-link traffic. Browser peers publish to every configured relay and read from them in turn, one request per poll, keeping the newest validly signed packet seen; the relay list is user-configurable. Public relays rate limit by IP (120 requests a minute when this was written), so relay clients poll slower than DHT clients (4 s active, 2 s while signaling for at most 45 s or for 30 s when the peer's offer is due, 30 s in the background, 60 s while the data link is up), back off from a relay that answers 429 (or fails at the network level, which is how a browser sees a 429 without CORS headers), keep to a budget of 30 requests a minute per relay, send `If-Match: <timestamp of the packet being replaced>` so that a burst of publishes is not refused with 428 while the previous put is still in flight, and open the data link on their own when the peer is online so that chat and call signaling leave Pkarr alone.

## 3. Services (v1)

`_svc` advertises what a peer offers right now:

```json
{ "v": 1, "s": ["chat", "voice", "video", { "i": "atlas", "t": "http", "n": "Atlas", "p": "ghostly-http/1" }] }
```

| Key | Meaning |
|---|---|
| `i` | service id, `[a-z0-9][a-z0-9-]{0,31}`, unique per peer. **The only way a remote peer can name a service.** |
| `t` | type: `chat`, `voice`, `video`, `http`, or a future type |
| `n` | display name, at most 48 characters |
| `p` | protocol spoken over the data link, e.g. `ghostly-http/1` |
| `m` | optional string metadata, at most 8 entries |

A bare string is shorthand for `{ "i": x, "t": x }`. At most 16 services. Receivers drop entries that fail validation and keep the rest; unknown types are kept so new service types need no protocol change. A peer without `_svc` is a v0 client and implicitly offers `chat`, `voice` and `video`.

The advertisement is authenticated twice: by the secretbox (only the link peer could have written it) and by the Pkarr signature (it was published by the peer's key). It never contains the local address a service maps to.

## 4. Calls

`_call` carries `{ "t": "o" | "a" | "h" | "v", "ts", "u", "p", "f", "s", "m", "c", "ss", "v", "k", "ap", "vp" }`: ICE credentials, DTLS fingerprint, setup role, media order, at most two candidates, the SSRCs, what picture the sender has on, and the payload types its SDP gives Opus and VP8 when they are not 111 and 96 (§4.2). Each side rebuilds a full SDP around these values, because a real SDP does not fit in a packet.

Receivers validate a signal before any of it reaches an SDP, whether it came from `_call` or a `call` frame: ICE ufrag/pwd are RFC 8839 ice-chars (4-256 and 22-256 long), `f` is 64 hex digits, `s` is `actpass`, `active` or `passive`, `m` holds one or two distinct `a`/`v`, `ss` holds at most two uint32s, `v` is 0 or 1, `k` is `c` or `s`, `ap` and `vp` are dynamic payload types (35-63 or 96-127) and not the same one, and each of at most eight candidates is parsed and re-serialized from its parts (non-UDP ones are dropped, malformed ones reject the signal). Signals whose `ts` is more than 120 s away from the receiver's clock are ignored, so a stale packet does not ring.

v1 changed two things, both compatible with v0 peers:

- The rebuilt video section no longer declares the `toffset` header extension. Extension ids differ between WebRTC engines, and Chromium rejects an answer that maps an id differently from the real offer.
- While the data link is open, the same signal is also sent as a `call` frame (§6.1), so a connected peer rings immediately instead of on its next poll.

### 4.1 Turning a voice call into a video one (v2)

Renegotiating a call would mean a second offer through the DHT, which is slow and which a v0 peer cannot answer. So a v2 offer always describes a video section, even for a voice call: `m` is `["a", "v"]` either way, the section is `sendrecv`, and nobody sends on it until somebody turns a camera or a screen on. Switching one on is then a `replaceTrack` on a section both sides already agreed on: no signaling, no ringing, nothing the peer has to accept. A peer answering a v2 offer without a camera of its own opens its half of that section before answering, so it can turn one on later too.

Because the media list no longer says who is sending a picture, two fields do:

| Key | Meaning |
|---|---|
| `v` | `1` while the sender has a picture on, `0` while it does not |
| `k` | what the picture is: `c` for a camera, `s` for a screen. Only with `v: 1` |

A `"t": "v"` signal carries nothing else: it is how a peer says mid-call that its picture went on, off, or changed from a camera to a screen. It has no ICE, and a receiver keeps only `ts`, `v` and `k` from it.

Compatible with v0 and v1 peers in both directions, with one cosmetic loss:

- A v1 peer sends no `v`. It only puts an SSRC on a video section it really sends on, so its SSRC count says whether its picture is on, and that is what a v2 peer reads it by.
- A v1 peer rings a v2 voice call as an incoming *video* call, since all it has to go by is the media list. Answering it with audio works as it always did; the v1 side simply cannot turn a camera on later, because it does not know its half of the section is open.
- A v1 peer drops a `"t": "v"` signal as an unknown type, which is what it should do with one.

### 4.2 Payload types (v3)

The rebuilt SDP declares one codec per section: Opus and VP8. Up to v2 it gave them the payload types Chromium
does, 111 and 96, whatever the sender's SDP said. WebKit (Safari, and Ghostly Desktop on a Mac) offers H264 as 96
and VP8 as 106, so when it made the offer, the answer rebuilt from the compact signal said `96 VP8` while its own
offer said `96 H264`: it read the answerer's VP8 as H264 and never showed the answerer's picture. Firefox offers
Opus as 109.

So a v3 signal says which payload types its SDP gives them, and only when they differ from 111 and 96:

| Key | Meaning |
|---|---|
| `ap` | the payload type of Opus in the sender's audio section |
| `vp` | the payload type of VP8 in the sender's video section |

The receiver rebuilds with them (and with 111 and 96 when they are absent), so the answer to a WebKit offer
keeps VP8 at 106 and says so in its own `vp`. A signal between two Chromium apps is unchanged. A v2 peer ignores
both keys and rebuilds with 111 and 96 as before: a call it has with a WebKit offerer still shows only one picture,
as it did.

v3 also leaves an IPv6 related address out of the candidates it sends (`raddr :: rport 0`, WebKit's IPv6 srflx),
and accepts one: a v2 receiver checked `raddr` against the extension-token pattern, which has no colon, and
refused the whole signal, so the call never rang. The related address is informational for ICE.

## 5. The data link (v1)

The data link is one `RTCPeerConnection` per link with a single DataChannel. All application traffic other than v0 chat and call signaling flows through it, peer to peer.

**Signaling** reuses the idea behind `_call`. `_rtc` carries:

```json
{ "t": "o", "ts": 1789712672369, "u": "<ufrag>", "p": "<pwd>", "f": "<sha-256 fingerprint, hex>", "s": "actpass", "c": ["h,192.0.2.10,54400", "s,203.0.113.7,61000"] }
```

An answer has `"t": "a"` and `"o": <ts of the offer it answers>`. Candidates are `<h|s|r>,<address>,<port>` for host, server reflexive and relay; at most two, two and one, UDP only. Each side builds a minimal `m=application … webrtc-datachannel` SDP from the signal. Receivers validate every field against strict patterns before it goes anywhere near an SDP.

- Either peer may offer, on demand. The other answers automatically: the link already authenticated the peer, and only explicitly shared services are reachable.
- Signals older than 120 seconds are ignored.
- If both offer at once, the peer with the lexicographically lower public key keeps its offer and the other answers it.
- A new offer while connected means the peer lost the connection; the receiver drops the old one and answers.
- Both peers poll fast while signaling, clear `_rtc` once the channel is open, and poll slowly while it stays open.
- Clients may open the data link unprompted when the peer is online. To avoid both offering at once, only the peer with the lower public key does.

**Peer authentication.** The DTLS fingerprint travels inside a record that is encrypted with the link key and signed by the peer's identity. A DTLS session with that fingerprint is therefore a session with the peer. WebRTC encrypts everything on the channel (DTLS/SCTP).

**Connectivity.** Standard ICE. Direct paths are preferred; STUN discovers the public address. A user may configure a TURN server, which then relays encrypted packets when no direct path exists. STUN and TURN are generic connectivity infrastructure: they hold no Ghostly state and cannot read the traffic.

**The channel** is `ghostly/1`: negotiated (`id: 0`), ordered, reliable.

## 6. Framing on `ghostly/1` (v1)

Text messages are **control frames**, compact JSON with a `t` discriminator. Binary messages are **body chunks**:

```
<kind u8> <stream id u32 BE> <flags u8> <payload>
kind   1 = request body, 2 = response body, 3 = file
flags  bit 0 = END
```

A DataChannel message is at most 16 KiB (16378 bytes of payload per chunk), a control frame at most 60 KiB. Senders stop writing above 1 MiB of buffered data and resume below 256 KiB. Malformed frames are dropped.

### 6.1 Session frames

| Frame | Meaning |
|---|---|
| `{ "t": "hello", "v": 1, "svc": <§3 object>, "nick"? }` | first frame in each direction; `svc` is the authoritative service list |
| `{ "t": "svc", "svc": … }` | the service list changed |
| `{ "t": "m", "ts", "m" }` | chat message; used instead of `_msgs` while the channel is open. On open, each side first sends the messages the peer had not acknowledged through Pkarr yet. Receivers deduplicate by `ts`. Text may be up to 16 KiB here; the clients send up to 4000 characters, which is what lets a long Lightning invoice or an ecash token through, while `_msgs` stays at a few hundred. |
| `{ "t": "call", "s": "<_call signal JSON>" }` | call signaling, in addition to `_call` |
| `{ "t": "ping" \| "pong", "ts" }` | liveness |

### 6.2 Files

```
→ { "t": "file", "id": 3, "f": "Zk3v…", "ts": 1789712672369, "n": "floor plan.pdf", "s": 482113, "m": "application/pdf" }
→ chunk(kind 3, id 3) … chunk(kind 3, id 3, END)
```

`f` is the sender's id for the file (`[A-Za-z0-9_-]{8,64}`), `n` its name, `s` its size in bytes, `m` its media type. The bytes follow as chunks of kind 3. Files only travel over the data link, never through Pkarr, so both peers have to be online.

- The receiver keeps the file only if exactly `s` bytes arrived before END. More, fewer, or 30 s of silence discard it.
- `{ "t": "rst", "id", "d": "f", "e" }` cancels a transfer from either side; a receiver that does not want the file answers the `file` frame with it.
- Limits: 100 MiB per file, 3 incoming files per peer at a time, 500 MiB of received files kept per peer. A file that would go past a limit, or that reuses an `f` already seen on the link, is refused with `rst`.
- The name is display text and a download suggestion, never a path: path separators, control and other invisible characters (Unicode Cc, Cf, Zl, Zp, so bidi overrides and zero-width characters too), leading whitespace and leading dots are removed, 200 characters at most. An unparseable media type becomes `application/octet-stream`. Receivers store files under their own ids, never the sender's, serve the bytes as `application/octet-stream` unless they are an image they preview, and must not open or execute what they received on their own.

### 6.3 Payments

Ghostly does not move money. It carries payment requests, payments that fit in a message (ecash) and receipts between two linked peers, and a wallet on each side does the rest. The vocabulary is [Paykit](https://github.com/pubky/paykit-rs)'s, so that publishing the same endpoints through Paykit later is a change of transport rather than of model: a *payment endpoint* is an identifier plus a payload, an *amount* is decimal text plus an asset.

```
← { "t": "pay-req", "id": "Qm3…", "ts": 1789712672369, "v": "1000", "u": "sat", "memo": "coffee",
    "e": [["btc-lightning-bolt11", "lnbc10u1…"], ["cashu", "{\"mints\":[\"https://mint.example\"]}"]] }
→ { "t": "pay", "id": "p8Kx…", "ts": 1789712680000, "rid": "Qm3…", "v": "1000", "u": "sat", "e": ["cashu", "cashuB…"] }
← { "t": "pay-res", "id": "p8Kx…", "ok": true, "v": "1000" }
```

| Frame | Meaning |
|---|---|
| `pay-req` | Payment Request. `e` lists every way the payee can be paid, best first: `btc-lightning-bolt11` with an invoice anyone can pay from any wallet, `cashu` with the mints the payee accepts ecash from. |
| `pay` | A payment carried in band: `e` is `["cashu", <token>]`. `rid` names the request it settles. Without `rid` it is a plain transfer. |
| `pay-res` | The payee's word on a `pay` (redeemed, with the amount credited, or refused and why) or on its own `pay-req` (paid some other way, e.g. the invoice). Only the payee of a request may declare it paid. |

- Ids are `[A-Za-z0-9_-]{8,64}`; `v` is decimal text, never a float; `u` is the asset (`sat`). Payloads are at most 32 KiB and requests list at most 8 endpoints.
- Payments only travel over the data link. Tokens and invoices do not fit in a Pkarr packet and should not sit in one.
- An ecash token is a bearer instrument: until the payee redeems it at the mint, the payer can still spend it. Payees redeem on receipt, before answering. Payers keep the token until `pay-res` arrives, and take it back themselves if the payment is refused or never confirmed.
- A payee accepts ecash only from mints it chose. Anything else is refused with `pay-res`, and the payer falls back to the Lightning endpoint, which works across mints.
- A repeated `pay` id is answered with the earlier result and redeemed once.

### 6.3.1 Held items (`hold/1`, experimental)

When both sides of a chat turned **Hold messages** on, what one sends while the other's session is closed is not lost and not squeezed into a DHT record: it is sealed (signed with the sender's participation key, encrypted to a key derived from both participation keys and the invite secret), put in the sender's **own** S3-compatible storage under `<space>/hold/<mailbox>/`, listed in a sealed manifest with presigned read addresses, and pointed at from a small signed, encrypted `_hold` record under a per-link Pkarr key. The contact reads the pointer when it is back, fetches and checks each item in sequence order, and acknowledges on its own pointer; the sender then marks the messages received and deletes the objects. Text (16 KiB), files (8 MiB) and Cashu/Lightning payment requests only; never ecash. At most 64 items and 64 MiB per contact, seven days each; an item is readable until seven days after the sender was last online. On the open session each side says `{ "t": "paired-hold", "on": <bool>, "top": <n> }`; older apps drop it. Exact formats, refusals and bounds: [WISP 4xx](wisps/4xx-store-and-forward.md).

### 6.4 `ghostly-http/1`

```
→ { "t": "req", "id": 7, "s": "atlas", "m": "POST", "p": "/api/items?x=1", "h": [["content-type","application/json"]], "b": true }
→ chunk(kind 1, id 7) … chunk(kind 1, id 7, END)
← { "t": "res", "id": 7, "st": 201, "h": [["content-type","application/json"]], "b": true }
← chunk(kind 2, id 7) … chunk(kind 2, id 7, END)
```

- `id` is chosen by the requester and scoped to its direction; both peers may be client and host at once.
- `s` is a service id. `p` is an origin-form path with query. There is no field for a host, port or URL.
- `b` says whether body chunks follow. Bodies are streamed in chunks and are binary safe.
- `{ "t": "rst", "id", "d": "q" | "s", "e" }` aborts a stream: `q` by the requester, `s` by the responder mid-body.
- Methods: `GET HEAD POST PUT PATCH DELETE OPTIONS`.

Host errors are ordinary responses with an `x-ghostly-error` header, so a browser can render them:

| Status | `x-ghostly-error` | Cause |
|---|---|---|
| 400 | `bad-path` | path did not resolve inside the target |
| 404 | `unknown-service` | id not shared (anymore) |
| 405 | `method-not-allowed` | |
| 408 | `request-timeout` | request body stalled for 30 s |
| 413 | `request-too-large` | request body above 8 MiB |
| 502 | `unreachable`, `redirect-blocked` | local service down, or it redirected off the target |
| 503 | `busy` | more than 32 concurrent requests from this peer (a reset request counts until the local service has answered it) |
| 504 | `timeout` | local service did not answer within 60 s |

**What the host guarantees**

1. A service id resolves only through the list the user configured, and only while the service is enabled. The mapping lives on the host; nothing in a frame can alter it.
2. Targets are loopback only (`localhost`, `127.0.0.1`, `[::1]`), `http` or `https`, without credentials, query or fragment.
3. The request URL is `target origin + base path + p`. `p` must start with a single `/` and contain no whitespace, control characters or backslashes, and its path part (before `?`) no encoded `/`, `\` or `.` (`%2f`, `%5c`, `%2e`), which some servers decode before routing. After URL normalization the result must still have the target's origin and sit under its base path, otherwise the request is refused without touching the network.
4. Hop-by-hop headers, `Host`, `Origin`, `Referer`, `Content-Length`, `Accept-Encoding`, `Sec-*`/`Proxy-*`, forwarding and client-address headers (`Forwarded`, `Via`, `X-Forwarded-*`, `X-Real-IP`, `True-Client-IP`, …), and URL and method overrides (`X-Original-URL`, `X-Rewrite-URL`, `X-HTTP-Method-Override`, …) are removed from requests. Header names and values are validated.
5. Requests are made without the host user's cookies or HTTP credentials, so a peer never inherits the session the host has with its own application.
6. Redirects never leave the target for the client. A redirect whose `Location` is on the target origin and under its base path is handed to the client with that `Location` made relative; any other is answered with 502 `redirect-blocked` and its `Location` is not disclosed. Off-target `Location`/`Content-Location` headers on other responses are dropped. A Desktop host never follows redirects. A browser host has to (its fetch hides where a manual redirect goes) and checks where it ended afterwards, so an open redirect in the shared application can still make the host send one request elsewhere on the machine, whose response is discarded.
7. From responses, hop-by-hop headers, `Content-Encoding`, `Content-Length`, HSTS, `Alt-Svc` are removed (the body is forwarded decoded), and `Domain` is stripped from `Set-Cookie`.
8. Limits: 8 MiB request bodies, 32 concurrent requests per peer, 60 s for the local service to answer, 30 s body idle time. Clients cap responses at 64 MiB (the browser viewer at 32 MiB) and keep at most 16 requests in flight.

### 6.5 Private groups (`group-mesh/1`)

A group of up to eight peers, on top of paired links. Frames are `group-*` control frames and carry no `id`, so an app from before groups drops them; they flow only on a paired session where both sides announced `{ "t": "paired-groups", "v": [1] }` after the handshake. The invitation travels on the inviter's contact chat; everything else on one dedicated paired link per pair of members, whose keys both derive from their member keys and the group id. An admin may also share one link (`group1/<group id>/<entry key>`, `group-entry/1`) that anyone can use: a joiner leaves its member key in a sealed Pkarr record every holder of the link can derive, and the admin's app admits it over a paired session derived from the link's entry key and that member key. The full profile, with its key schedule, membership rules and bounds, is [WISP 9xx · Group Mesh](wisps/9xx-group-mesh.md).

A second profile, `group-community/1`, is for a group whose link (`group2/<group id>/<entry key>`) is meant for a large community: any member lets people in, so joining does not wait for the admin, and it holds up to 256 members. Its commits are version 2 (a roster hash, not the roster; `add` derives the next epoch's secret; concurrent commits by members are a race settled by the longest branch), and its members reach each other through a few hubs they elect in a sealed Pkarr beacon, each other member keeping one paired edge to a hub. Apps announce `{ "t": "paired-groups", "v": [1, 2] }`; community frames carry `v: 2` and flow only where both sides announced 2. See [WISP 9xx · Group Community](wisps/9xx-group-community.md).

```
→ { "t": "group-invite", "g", "name", "admin", "e", "n" }               contact chat: an admin invites
← { "t": "group-accept", "g", "key" }   |   { "t": "group-decline", "g" }
→ { "t": "group-chain", "g", "commits": [ … ] } *                       long chains, 24 commits at a time
→ { "t": "group-welcome", "g", "name", "commits": [ … ], "secrets": [ { "e", "s": { "e", "n", "c" } } ] }
↔ { "t": "group-commit", "g", "commit": { "v": 1, "g", "e", "p", "k", "m", "by", "s"?, "ts", "c", "sig" }, "secret"? }
↔ { "t": "group-msg", "g", "e", "s", "n", "ts", "nn", "c", "sig" }
↔ { "t": "group-sync", "g", "e", "h", "have": { <sender>: { <epoch>: <seq> } }, "secrets": [ <epochs> ], "mt"? }
↔ { "t": "group-secrets", "g", "secrets": [ { "e", "s" } ] }
→ { "t": "group-leave", "g" }                                           to the admin
→ { "t": "group-removed", "g" }                                         contact chat, a courtesy
↔ { "t": "group-pay", "g", "id", "k", "f", "to", "v", "u", "d", "r", "x"?, "m"?, "a"?, "ts", "st", "by"? }   what the group sees of a payment
↔ { "t": "group-meta", "g", "e", "h", "r", "by", "ts", "d", "sig", "k", "nn", "c" }   the group's picture, the admin's word
```

- `g` is a 22-character base64url group id; `e` an epoch, the index of a commit in the chain; member keys are z-base-32 Ed25519 keys made for this group.
- A commit's `m` is the whole roster after it, sorted `[key, role]` pairs with exactly one `admin`; `p` is the SHA-256 of the previous commit's tuple `[v, g, e, p, k, m, by, s, ts, c]`; `sig` is the admin's signature on the same tuple; `c` is an HMAC-SHA-256 of the untagged tuple under the new epoch's confirm key. Kinds: `create`, `add`, `remove`, `role`, `rotate`.
- A sealed secret `{ "e", "n", "c" }` is an ephemeral X25519 public key, a nonce and an XChaCha20-Poly1305 box of the 32-byte epoch secret, keyed by HKDF-SHA-256 of the shared secret and bound to `["ghostly-group/1 secret", g, e, member]`.
- A message's `c` is XChaCha20-Poly1305 of the trimmed UTF-8 text (at most 16 KiB) under the epoch message key, with the JSON of `[g, e, s, n, ts]` as associated data; `sig` is the sender's signature on `["ghostly-group/1 msg", g, e, s, n, ts, nn, c]`. `n` counts from 0 in each epoch, per sender. The stable id is `<s>:<e>:<n>`.
- `group-meta` is the group's metadata (its picture), outside the chain: the admin signs `["ghostly-group meta", g, e, h, r, by, ts, d]`, where `(e, h)` is a commit it is the admin after and `d` the SHA-256 of the JSON body `{ "pic"? }`; the body is sealed under the message key of epoch `k`. Members keep the newest statement (later commit, then higher revision) whose signer is the admin now; a sync's `mt` (`"e.r"`) says which one the sender holds, and whoever holds a newer one sends it. Community frames carry `v: 2` and `k` is a commit hash. The picture is a JPEG data URL of at most 512×512 and 40,000 characters. See [9xx § Metadata](wisps/9xx-group-mesh.md#metadata).
- Receivers accept a message only from the edge of its sender, for an epoch both were members of, once per `(s, e, n)`; a frame ahead of the chain waits, bounded, while the receiver asks the sender to catch it up. Only the author re-sends its messages, from a log of its last 32.
- Payments with a member use the ordinary payment frames of §6.4 on the edge to that member (`pay-ask`, `pay-req`, `pay`, `pay-res`), negotiated on the edge exactly as in a 1:1 chat; they never cross another member. A request to the whole group is one `pay-req` sent on every edge, on one rail (Cashu or Lightning), paid once. `group-pay` tells the other members what happened: `k` is `req` or `pay`, `f` the payer (or `*`, a request anyone may pay), `to` the payee, `v`/`u`/`d` the amount, unit and decimals, `r` the rail, `st` `open`, `sent`, `paid` or `closed`, `by` who paid. A receiver believes it only from the member it is about (the edge's peer): the payee for a request's state and for `paid`, the payer for `sent` and for taking that back. Additive: an app without it drops the frame, and an edge of an app without payments on edges negotiates none. Full rules: [WISP 9xx § Payments](wisps/9xx-group-mesh.md#payments).

## 7. What is not in the protocol

- **A central Ghost message server.** The host serves its enabled services while online. Closing Ghostly ends live connectivity; published presence may remain stale and local history persists. Pkarr relays can carry encrypted small-message records; STUN assists discovery and TURN can relay encrypted live traffic.
- **Public services.** A service is reachable by the peers you are linked with. Serving strangers needs a rendezvous that Pkarr, being pull-only, does not provide out of the box. One possible design is a published one-time mailbox key that strangers write their offer to; it is deliberately left for later.
- **Per-peer service selection.** Every enabled service is advertised on every link.
- **WebSockets and server-sent events** over `ghostly-http/1`. The framing streams; the mapping for upgrades is not defined yet.
