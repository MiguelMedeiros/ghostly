# The Ghost Protocol

Ghostly is an ephemeral, identity-addressed peer-to-peer service layer. Chat, voice, video and web applications are services on top of it. A peer's services exist while the peer is online, and nowhere else.

This document describes the protocol as implemented in [`packages/core`](../packages/core), which Ghostly Desktop, Ghostly Browser and the CLI share. Sections marked **v1** are additions; everything else is the protocol Ghostly has always spoken, unchanged.

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

Every link has its own identities. Two of your peers cannot tell they are talking to the same person, and there is no long-lived key to correlate. Holding the invite is what authenticates a peer: only the two holders can decrypt the link's records, and only they can sign for its two keys.

The invite is a bearer secret and must travel over a private channel.

## 2. Discovery: Pkarr records

Each peer publishes one Pkarr signed packet under its link identity and polls the peer's. A packet is a DNS message with TXT records, signed per BEP44 and stored in the Mainline DHT. The DNS message is at most **1000 bytes**.

All values except `_ts` and `_ack` are `base64(nonce(24) || secretbox(plaintext))` with XSalsa20-Poly1305 under the link key. TTL is 300.

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

**Transports.** Desktop and the CLI talk to the DHT directly and to Pkarr relays (the Rust client's defaults). Browsers cannot open UDP sockets and use relays only: `PUT /<key>` and `GET /<key>` with `<signature(64)><timestamp µs, u64 BE><DNS packet>`. A relay is an HTTP bridge to the DHT. It sees signed, encrypted packets, cannot forge or read them, and never carries application traffic. Browser peers publish to every configured relay and read from them in turn, one request per poll, keeping the newest validly signed packet seen; the relay list is user-configurable. Public relays rate limit by IP (120 requests a minute when this was written), so relay clients poll slower than DHT clients (4 s active, 2 s while signaling for at most 45 s, 30 s in the background, 60 s while the data link is up), back off from a relay that answers 429 (or fails at the network level, which is how a browser sees a 429 without CORS headers), keep to a budget of 30 requests a minute per relay, send `If-Match: <timestamp of the packet being replaced>` so that a burst of publishes is not refused with 428 while the previous put is still in flight, and open the data link on their own when the peer is online so that chat and call signaling leave Pkarr alone.

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

Unchanged. `_call` carries `{ "t": "o" | "a" | "h", "ts", "u", "p", "f", "s", "m", "c", "ss" }`: ICE credentials, DTLS fingerprint, setup role, media order, at most two candidates and the SSRCs. Each side rebuilds a full SDP around these values, because a real SDP does not fit in a packet.

v1 changes two things, both compatible with v0 peers:

- The rebuilt video section no longer declares the `toffset` header extension. Extension ids differ between WebRTC engines, and Chromium rejects an answer that maps an id differently from the real offer.
- While the data link is open, the same signal is also sent as a `call` frame (§6.1), so a connected peer rings immediately instead of on its next poll.

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
- Limits: 100 MiB per file, 3 incoming files per peer at a time.
- The name is display text and a download suggestion, never a path: path separators, control characters and leading dots are removed, 200 characters at most. An unparseable media type becomes `application/octet-stream`. Receivers store files under their own ids, never the sender's, and must not open or execute what they received on their own.

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
6. The host never follows redirects. A redirect whose `Location` is on the target origin and under its base path is handed to the client with that `Location` made relative; any other redirect, or one whose target the local stack cannot see (a browser's manual redirect), is answered with 502 `redirect-blocked` and its `Location` is not disclosed. Off-target `Location`/`Content-Location` headers on other responses are dropped.
7. From responses, hop-by-hop headers, `Content-Encoding`, `Content-Length`, HSTS, `Alt-Svc` are removed (the body is forwarded decoded), and `Domain` is stripped from `Set-Cookie`.
8. Limits: 8 MiB request bodies, 32 concurrent requests per peer, 60 s for the local service to answer, 30 s body idle time. Clients cap responses at 64 MiB (the browser viewer at 32 MiB) and keep at most 16 requests in flight.

## 7. What is not in the protocol

- **A server.** The host is the server while it is online. Close Ghostly and presence, chat endpoint and services are gone. Relays, STUN and TURN only help peers find and reach each other.
- **Public services.** A service is reachable by the peers you are linked with. Serving strangers needs a rendezvous that Pkarr, being pull-only, does not provide out of the box. One possible design is a published one-time mailbox key that strangers write their offer to; it is deliberately left for later.
- **Per-peer service selection.** Every enabled service is advertised on every link.
- **WebSockets and server-sent events** over `ghostly-http/1`. The framing streams; the mapping for upgrades is not defined yet.
