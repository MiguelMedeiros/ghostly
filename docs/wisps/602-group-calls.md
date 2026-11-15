# WISP 602: Group Calls through a Forwarding Node

| Field | Value |
|---|---|
| Candidate number | 602; editorial family allocation (600-699, Voice and video) |
| Status | Draft |
| Document kind | Profile |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [02](02-peer-keys.md), [600](600-media.md), [601](601-webrtc-media.md), [902](902-group-mesh.md), [903](903-group-community.md) |
| Implementation | Not built. This draft is the contract the core, the node, the engine and the app are built against. |
| Summary | A community group names a node that forwards its calls, and a member asks that node for a call pass with a signed request. |
| Availability | Planned |
| Notes | Community groups only. Media goes through the node's forwarding server (an SFU, LiveKit), not from each member to each other. End-to-end encryption of the media is optional in this revision. |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Purpose

A call in [601](601-webrtc-media.md) is one connection between two apps. A group of 50 cannot call that way: each member would send its camera 49 times. Here every member sends its media once, to a forwarding server (a selective forwarding unit, SFU) run by a Ghostly node that is a member of the group, and the server sends each member the others' media. 1:1 calls (`calls/1`) do not change.

Three things are fixed here: how a group names its node, how a member proves to that node that it is in the group, and what the node answers. This revision covers `group-community/1` groups ([903](903-group-community.md)) only; a `group-mesh/1` member ignores the field below.

## The group names its node

The group's metadata body ([902 § Metadata](902-group-mesh.md#metadata), [903 § Metadata](903-group-community.md#metadata)) gets one optional field:

```
"call": { "sfu": "https://call.ghostly.tools" }
```

- `sfu` is an `https` origin and nothing else: no path, query, fragment or userinfo, at most 200 characters, written as the URL standard serializes an origin (lower-case host, default port left out, no trailing `/`). A reader checks that the string equals `new URL(sfu).origin` and that its scheme is `https:`. The string is signed into every token request (below), so it has one spelling.
- Other keys inside `call` are ignored. A `call` that does not hold is no `call`: the group has no calls, and the name and picture beside it still show, as with a hub policy that does not hold.
- Only the admin sets it, as only the admin sets the name and the picture: it is in the admin's signed statement, outside the membership chain. A member's app shows the group's call only while the statement it keeps has a `call` that holds.
- The body is the whole metadata, so an app that renames the group or changes its picture keeps `call` in the new body. Leaving it out turns the group's calls off.

## The token request

To join the group's call, a member's app asks the node for a pass:

```
POST <sfu>/sfu/group-token
Content-Type: application/json

{ "v": 1, "g": "<group id>", "k": "<member key>", "room": "g_<group id>", "ts": 1794700800, "n": "<nonce>", "name": "Ana", "sig": "<signature>" }
```

| Field | Value |
|---|---|
| `v` | `1` |
| `g` | The group id, base64url without padding, 22 characters ([903 § Identity](903-group-community.md#identity-and-declaration)). |
| `k` | The member's key in this group, z-base32, 52 characters, in its one canonical spelling, as `GroupMemberView.key` and `ghostly group show --json` print it. |
| `room` | `"g_" + g`, 24 characters. |
| `ts` | Unix time in seconds, an integer, on the member's clock. |
| `n` | 16 random bytes, base64url without padding (22 characters), new for each request. |
| `name` | Optional: the member's display name, at most 64 code points. Not signed: the node prefers its own roster's name for `k` (below). |
| `sig` | base64url (86 characters) of the Ed25519 signature, by the member's group key `k`, over the bytes below. |

**Signed bytes.** `sig` signs, exactly:

```
utf8(JSON.stringify(["ghostly-sfu/1 token", sfuOrigin, g, room, k, ts, n]))
```

an array, as the leave statement of [903](903-group-community.md#membership-chain) is, where `sfuOrigin` is the group's `call.sfu` string as the member's app read it, and `ts` a JSON number. Signing the origin keeps a request made for one node from being used at another.

**Room.** A group's call room is `"g_" + g`, which fits LiveKit's and the node's room names (`^[A-Za-z0-9_-]{1,64}$`). The `g_` prefix belongs to group rooms: any other way the node lets someone into a room (a guest pass for its own call page, for example) refuses a room name that starts with `g_`.

### Test vector

| Input | Value |
|---|---|
| Seed (hex) | `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` |
| Public key (hex) | `03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8` |
| `k` | `yqooxx9u3aemh8mo5wcqq16yufu6jitouq1o4za751dger1igghy` |
| `sfuOrigin` | `https://call.ghostly.tools` |
| `g` | `oKGio6SlpqeoqaqrrK2urw` (the bytes `a0` to `af`) |
| `room` | `g_oKGio6SlpqeoqaqrrK2urw` |
| `ts` | `1794700800` (2026-11-15 00:00:00 UTC) |
| `n` | `EBESExQVFhcYGRobHB0eHw` (the bytes `10` to `1f`) |

The signed text (195 bytes):

```
["ghostly-sfu/1 token","https://call.ghostly.tools","oKGio6SlpqeoqaqrrK2urw","g_oKGio6SlpqeoqaqrrK2urw","yqooxx9u3aemh8mo5wcqq16yufu6jitouq1o4za751dger1igghy",1794700800,"EBESExQVFhcYGRobHB0eHw"]
```

Its bytes in hex:

```
5b2267686f73746c792d7366752f3120746f6b656e222c2268747470733a2f2f63616c6c2e67686f73746c792e746f6f6c73222c226f4b47696f36536c7071656f71617172724b32757277222c22675f6f4b47696f36536c7071656f71617172724b32757277222c2279716f6f787839753361656d68386d6f3577637171313679756675366a69746f7571316f347a6137353164676572316967676879222c313739343730303830302c2245424553457851564668635947526f62484230654877225d
```

The signature, in hex and as `sig`:

```
f8333f5a27ee87d6dac18b5e0a69828a8329aee6f846b645b2cecb5f24394ca03d9ed56072acd9902bd852e2a72f8ad9ee60dd9dc9bfed27c1050b0785df8d0b
-DM_Wifuh9bawYteCmmCioMprub4RrZFss7LXyQ5TKA9ntVgcqzZkCvYUuKnL4rZ7mDdncm_7SfBBQsHhd-NCw
```

Ed25519 signatures are deterministic, so any implementation gets these bytes. `node:crypto` signs and verifies them with no other dependency: the seed as PKCS#8 DER behind the prefix `302e020100300506032b657004220420`, the public key as SPKI DER behind `302a300506032b6570032100`.

## What the node checks

The node is a member of the group: it follows the chain and knows the roster. It answers a request only when all of these hold:

1. The body is JSON of at most 4 KiB with the fields above in their shapes, and `room` is `"g_" + g`.
2. `|now - ts| <= 60`, on the node's clock.
3. `n` was not seen in the last 120 s. Any `n` it accepts it keeps that long, so a request cannot be replayed while its `ts` is still fresh.
4. `sig` verifies under `k` over the signed bytes, with `sfuOrigin` the node's own origin.
5. `k` is in the node's current roster of `g` (its main branch).

Every refusal is the same `403` with the same body, so a caller is not told which check failed. Past 30 requests in a minute from one address, or for one `k`, the node answers `429` with a `Retry-After` header.

## The reply

```
200 OK
{ "url": "wss://…", "token": "<LiveKit access token>", "room": "g_<g>", "identity": "<k>", "expiresIn": 600, "iceServers": [ … ] }
```

- `url`: where the client's LiveKit SDK connects. `token`: a LiveKit access token that lets it join `room` and no other room. `room`: as asked.
- `identity`: `k`, so every member sees who is who by the key it knows from the roster. The LiveKit name in the token is the node's roster name for `k`, else the request's `name`, cut to 64 code points.
- `expiresIn`: seconds the token stays valid for joining, at most 3600.
- `iceServers`: optional, an array of `RTCIceServer` (`urls`, and `username` and `credential` for a TURN server). When present, the client uses them for this call's connection to the node. The reference node gives Cloudflare Realtime TURN servers there.

## CORS

The route answers `OPTIONS` (the browser's preflight) with `204` and `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type`, and sends `Access-Control-Allow-Origin: *` on its `200`, `403` and `429` too. The request is authenticated by its signature, never by a cookie, so the web app, Desktop's WebView and the extension, each on its own origin, can all ask.

## End-to-end encryption

The media is DTLS-SRTP between each member and the node, which forwards it. The node is a member and could read the group's messages anyway; still, a group may want its call media sealed from the server too.

This is optional in this revision. A group turns it on with `"e2ee": 1` in `call`, signed by the admin like the rest. A reader takes `true` as on too, the same as `1`, so a body that writes it as a JSON flag never leaves a call unsealed; a writer writes `1`, and an app that keeps or writes a body again writes `1`. Any other value, or none, is off. Every member of a group reads the same statement, so a room never has members with it on and members with it off. An app that cannot seal call media does not join a call whose `call` turns it on and says why.

An app in a call that is sealed checks, once it is in the room, that its own media is sealed: its E2EE worker runs, its SFU client's end-to-end encryption is on, and each track it sends goes through that worker. If any of these fails, it leaves the room at once, stops every track it captured, and says why. It never stays in a sealed call unsealed.

When it is on, the key is:

```
callKey = HKDF-SHA256(ikm = epoch secret, salt = utf8(g + "/" + e), info = utf8("ghostly-group-call/1 " + room), length = 32)
```

where the epoch secret is the 32-byte secret of the newest commit on the member's main branch and `e` that commit's epoch number in decimal: the same secret and salt as the group's message keys (`epochKeys`), under its own `info`, so a call key is never a message key. Each member sets it into LiveKit's shared key ring (shared-key mode, no ratchet, a ring of 16) at slot `e mod 16`, and seals with that slot from then on; LiveKit writes the slot in each frame's last byte, and a member opens a frame with the key in the slot the frame names. When the group moves to a new epoch, a member sets the new key in its slot and keeps the key of the epoch it was on for 10 seconds, so frames still sealed with it (in flight, or from members whose commit is still on its way) open; then it overwrites that slot with a random key, and any older slot at once. Two epochs 16 apart share a slot: a call never has both in use. A member taken out of the group (`leave`, `remove`) gets no later epoch's secret ([903](903-group-community.md#membership-chain)), so it cannot derive the key of the epoch after; while it is still in the room (§ Removal), what it sends with the key it holds opens for the others for those 10 seconds after they move, and no longer.

## Removal

A member taken out of the roster gets no new token: check 5 refuses it. A participant already in the room may stay until its token expires; the node may remove it from the room when it takes the commit, and this revision does not require it.

## Compatibility

`parseGroupMetaBody` drops keys it does not know, so an app from before this WISP reads a body with `call` as before and shows no call. An admin on such an app who renames the group or changes its picture writes a body without `call`, which turns the group's calls off until the admin sets it again from an app that knows it. Nothing changes in the membership chain, in the frames between members, or in 1:1 calls.

## Security and privacy

The node learns who joins the call, when, from which address, and the name it gives them; with end-to-end encryption off it can also see and hear the media. It learns nothing a member does not already know. The token request proves a key of the roster asked, for this node, within the last minute; a request seen by someone else cannot be used at another node or again later. `name` is not signed and is used only when the node has no name for `k`. A TURN server in `iceServers` sees the media as the node sends it: DTLS-SRTP, and sealed once more when end-to-end encryption is on.

## Open decisions

- Removing a removed member's live participant from the room at once, not when its token expires.
- Turning end-to-end encryption on by default once every client that can join supports it.
- Group calls in `group-mesh/1` groups.

## Conformance

The test vector above. An implementation of the node refuses each of the five checks with the same `403`, answers the preflight, and never admits a request to a room that is not `"g_" + g`.

## Revision log

One file per change in [changes/602-group-calls/](changes/602-group-calls/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
