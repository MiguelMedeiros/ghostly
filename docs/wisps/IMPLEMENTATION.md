# Implementation evidence and security limits

Inspection date: 2026-09-20. Baseline commit: `bbe142f08d88cefa173d1dc586608f64b00e9a6c`, with pre-existing local website edits preserved. This is a source inspection, not a cryptographic audit or a claim that network/device tests passed today. Later implementation increments must update this ledger separately from draft status.

The subsequent [paired-chat increment](PAIRED-CHAT-INCREMENT.md) adds an opt-in participation-pinned WebRTC chat profile; the table below remains explicitly the pre-increment baseline.

## Current matrix (2026-09-27)

What `dev` runs on each client today. The sections after this one are dated history; update this table, not them.

| Capability | Web app | Extension | Desktop | Evidence |
|---|---|---|---|---|
| DHT (Pkarr) | HTTP relays | HTTP relays | Mainline DHT read directly; writes to the DHT and the relays | #289, #293 |
| One chat: `ghostly1` invite, DHT first contact and floor, self-upgrade | Yes | Yes | Yes | #209, #210, #229 |
| WebRTC | Yes | Yes | macOS and Windows (Linux WebKitGTK has none) | [101](101-webrtc.md) |
| Iroh | Relay only, on by default | Relay only, on by default | Native | #225, #270 |
| HyperDHT | Only through a relay the person sets | Same | Native sidecar | #187, #231 |
| Files (`files/2`, `files/3` of any size) | Yes | Yes | Yes | #233 |
| Calls, screen share inside a call | Yes | Yes | macOS; Linux with its own media (webrtc-rs, GStreamer), no screen share yet; Windows untested | #207, #253, #331 |
| Shared apps (host / open) | No / No | Yes / Yes | Yes / Yes | #207, #268 |
| Profiles and backups | Yes | Yes | Yes | #171 |
| Wallets (per network) | Yes; WebLN web only | Yes | Yes; Bitcoin Core RPC Desktop only | #276, #277, #314, #317 |
| Identity proofs | Yes | Yes | Yes | [300](300-peer-proofs.md) |
| Groups (mesh, community) | Yes | Yes | Yes | [900](900-group-sessions.md) |
| Headless CLI (`ghostly`) | The app's engine on Node, for bots: `ghostly1` invites, one chat, groups, wallets (not Bark or Fedimint), files, identity proofs, shared apps; DHT through relays only | | | [11xx](11xx-headless.md), #323 to #327 |
| Rust `ghostly-cli` | Compatibility client only: older DHT records, no `ghostly1` codes, no chat sessions | | | [CLI](../CLI.md) |


## Observed baseline

| Area | Evidence | What it establishes / does not establish |
|---|---|---|
| Link identity/invite | [invite.ts](../../packages/core/src/invite.ts), [identity.ts](../../packages/core/src/identity.ts) | Two seeds plus shared symmetric key generated at creation. Creator initially knows both seeds. No cryptographic consumption/rotation in this legacy invite format. |
| Browser admission | [node.ts](../../packages/browser/src/engine/node.ts) `joinLink`, `onMessage` | Local duplicate lookup by seed; saved invite removed from UI state after incoming message. Neither prevents reuse of a copied invite on another device. |
| Persistence | [db.ts](../../packages/browser/src/engine/db.ts), [desktop host](../../src/desktop/host.ts) | Keys/messages persist locally; offline is not deletion. CLI callers supply their secrets explicitly. |
| Records | [records.ts](../../packages/core/src/records.ts), [crypto.ts](../../packages/core/src/crypto.ts) | TTL 300; 1000-byte DNS budget; secretbox with random nonce; plaintext `_ts`/`_ack`. No ratchet/key erasure schedule provides forward secrecy for stored records. |
| Messaging | [link.ts](../../packages/core/src/link.ts), [ghostlink.ts](../../packages/core/src/ghostlink.ts) | Small DHT fallback, live WebRTC, timestamp-based deduplication. Handing pending messages to a reliable channel is not remote durable acknowledgement. |
| Data transport | [ghostlink.ts](../../packages/core/src/ghostlink.ts), [datalink.ts](../../packages/core/src/datalink.ts) | WebRTC directly composed today. `PkarrTransport` abstracts rendezvous, not interchangeable data adapters. |
| Capabilities | [services.ts](../../packages/core/src/services.ts) | Validated advertisements and updates, not general version/permission negotiation. |
| Files/services/media | [files.ts](../../packages/core/src/files.ts), [http.ts](../../packages/core/src/http.ts), [callSignal.ts](../../packages/core/src/callSignal.ts), [React hooks](../../packages/react/src/useWebRTC.ts) | Existing bounded 1:1 capabilities, with platform constraints. Not group features. |
| Payments | [core payments](../../packages/core/src/payments.ts), [wallet](../../packages/browser/src/engine/wallet.ts), [coordinator](../../packages/browser/src/engine/payments.ts) | Cashu/Lightning application integration exists. Generic external wallet selection and every payment method do not. |
| Invoice display | [bolt11.ts](../../packages/core/src/bolt11.ts) | Checksum/display parser explicitly does not verify invoice signatures; the executing wallet must validate. |
| Proposed adapters/groups | Source search in core/browser/CLI/native directories | No Iroh, HyperDHT, external identity proof, MLS/group session or GossipSub adapter found. Pkarr/Paykit references are not proof of Pubky identity integration. |

## Security language to preserve

- Per-link identities reduce direct key reuse, but IP addresses, timing, capabilities, nicknames and optional external proofs can correlate activity. No anonymity guarantee.
- Pkarr signatures authenticate publishing keys; secretbox protects private values. Anyone who learns the link symmetric key can attempt to decrypt previously recorded ciphertext under that key. Unique links and random nonces do not provide forward secrecy by themselves.
- TTL and stopping refresh are availability/cache semantics. DHT nodes, relays, contacts or observers can retain copies; expiry is not verified erasure. Local history can outlive network presence.
- Legacy invite holders obtain sensitive signing/decryption credentials. Removing an invite from the screen cannot revoke them. A future consumed invite requires actual credential/state transition and explicit migration.
- Authenticated transport is not a human identity check, an authorization to spend, or permission to access every local service. Group routing is not group encryption.

## Platform evidence: implemented, available, selected

These are separate questions: **implemented** means a code path exists; **available** means this runtime and permission state can use it; **selected** means both peers and local policy agreed on its profile. Current service advertisements are not the proposed general negotiation.

| Capability | Web app baseline | Extension baseline | Native baseline | Session/runtime gate |
|---|---|---|---|---|
| Pkarr access | HTTP relays | HTTP relays | Injected Rust DHT/relay transport | Reachability, relay/network limits; an extension does not acquire native UDP merely by being installed |
| WebRTC data/chat/files | Shared core/engine | Shared core/engine in offscreen peer | Shared engine in WebView | WebRTC support, ICE path, peer compatibility; connectivity can fail |
| Voice/video | Shared UI/hook | Shared UI/hook | Shared UI/hook | Capture APIs, secure context, permissions, engine compatibility |
| Screen capture | When `getDisplayMedia` exists | Runtime dependent | WebView/OS dependent | Must detect availability; mobile support is not assumed |
| Host/open localhost | Host flags disabled | Host permissions and isolated viewer | Rust local fetch and viewer | Explicit enabled service, target validation; per-peer audience is not implemented in baseline |
| Persistent local state | IndexedDB; tab lifetime | IndexedDB; browser/offscreen lifecycle | Shared engine storage; app lifetime | Profile/device loss, storage failure, concurrent owner protection |
| Cashu/Lightning | Application integration | Same integration | Same integration | Mint/component access and explicit payment authorization |
| CLI | Separate Rust text client | Not an extension capability | Invokable CLI | No implied WebRTC/media/file support from sharing record format |
| Iroh/HyperDHT/proofs/groups | Proposed | Proposed | Proposed | Availability and interoperability unproven |

Sources: [host contract](../../packages/browser/src/host.ts), [web host](../../web/src/host.ts), [desktop host](../../src/desktop/host.ts), [extension source](../../extension/src), [web constraints](../WEB.md), [CLI](../CLI.md). Older release-specific prose in BROWSER.md is not evidence that the current native checkout ignores services; inspect the injected current engine/host wiring.

## Implementation sequence

Use a shared library for validated wire objects, version agreement and state machines, with host adapters for storage, keys, permissions and networking. Work in vertical flows: Draft → implementation → cross-platform tests → review/update Draft. First demonstrate pairwise invite, confirmation, negotiated WebRTC, message and restart/reconnect across web/native, then extension lifecycle. Preserve the legacy profile and make migration explicit; do not label automatic DHT fallback as a negotiated privacy choice.

Next, prove a second data adapter before claiming interchangeable transports. Groups follow with three peers, an agreed distribution/security profile, admission/removal and bounded failure cases. Runtime availability and negotiated compatibility should produce different user-visible unavailable/incompatible states. Reusing core across clients proves portability; independent implementation is a separate interoperability gate.


## One chat, revision 0.2 (2026-09-25): implemented versus decided

Inspection of `dev` at `802b48bc`, rechecked at `8670aeab`. The chat family's revision 0.2 describes one chat with the DHT as rendezvous and floor ([400](400-chat.md)); its decisions were recorded on 2026-09-25. The three implementation cards then queued have merged: the `ghostly1` invite and its ghostly.tools link (#210), DHT fallback and self-upgrade in every chat (#209, #229), and calls in the chat session (#207). The "Today" column is the 2026-09-25 inspection; rows it marks as different from the decision are now as decided.

| Behaviour | Today | Decided (2026-09-25) |
|---|---|---|
| Invite formats created | `pair1/` (streams first) or `pair2d/` (DHT only), chosen at creation ([invite.ts](../../packages/core/src/invite.ts)); since #210 only `ghostly1…` | One bech32m `ghostly1…` string (or `https://ghostly.tools/#ghostly1…`), no choice; `pair1/`, `pair2d/` and prefix-less still read ([801](801-invitation-profiles.md)) |
| First contact | Both at once in every chat: DHT envelope with recipient `invite` ([dhtDelivery.ts](../../packages/core/src/dhtDelivery.ts)) and a stream; a key mismatch on either path stops both ([ghostlink.ts](../../packages/core/src/ghostlink.ts)) | Both at once; pin on whichever verifies first; same key required on both |
| First pairing without a stream | Ends `on-dht` ([pairingProgress.ts](../../packages/core/src/pairingProgress.ts)) and chats | Ends `on-dht` and chats |
| Short-text fallback after a drop | Exists for `pair1/` chats once the contact announced DHT support (`GhostLink.textDelivery`, [ghostlink.ts](../../packages/core/src/ghostlink.ts)); every chat since #229 | The rule for every chat; every contact announces it from the first contact |
| Upgrade from DHT to a stream | Automatic in every chat that is not `dht-chosen`; a joined `pair2d/` code no longer sets DHT only | Automatic in every chat that is not `dht-chosen` |
| DHT only as a choice | Per chat, `setDeliveryMode("dht")`; either side blocks both | Same, listed as **DHT only** in the per-chat Connection menu |
| Capabilities before a stream exists | Layer-0 capability record ([capsRecord.ts](../../packages/core/src/capsRecord.ts)), revision in the envelope | Layer-0 capability record: transports, capabilities, native descriptors, name ([03](03-capabilities.md#layer-0-capability-record)) |
| Native transports without WebRTC first | Yes: descriptors from the record; demoted for 1 h after 3 failures | Yes, from the capability record |
| Second DHT text while one awaits a receipt | Waits in the outbox (`waiting`) ([outbox.ts](../../packages/browser/src/engine/outbox.ts)) | Queued in the outbox |
| Files, long text, requests while on the DHT | Held if both allow `hold/1` (DHT only too); otherwise wait for live with a cancel | Held in `on-dht` and `dht-chosen`; otherwise queued for layer 1 |
| Mailbox reads while live | Every 5 min, at once on a drop (10 s, not 4 s, while open on the DHT: relay budget) | Every 5 min, at once on a drop |
| Compatibility (prefix-less, v0.4) chats | Read and written, marked in the header, "Continue in a new chat" | Same; never created; "Continue in a new chat" |
| Hosted HTTP in new chats | Yes: `ph` frames on the chat session ([pairedHttp.ts](../../packages/core/src/pairedHttp.ts)) under `services/1` ([pairedCapabilities.ts](../../packages/core/src/pairedCapabilities.ts)), live only | Unchanged |
| Calls in new chats | Yes: `calls/1`, `paired-call` signals on the live session ([pairedCalls.ts](../../packages/core/src/pairedCalls.ts)), media on its own WebRTC connection; on Linux Desktop (no WebRTC in WebKitGTK) that connection runs in Rust, webrtc-rs and GStreamer, with no screen sharing yet | Unchanged |
| Pairing progress | Ends `live` or `on-dht`; `failed` only for key mismatch, rejection, publish, offline | Adds terminal `on-dht`; `failed` only for security or an unreachable DHT |
| CLI | Legacy `_msgs` only | Unchanged by the Drafts; a DHT-only client of 403 is the natural next step |

## Follow-up paired-chat implementation (2026-09-20)

The opt-in is available in both Home and **New**. Updated peers negotiate participation-signed RTC signaling and durably require it after authenticated migration; addresses/bootstrap encryption keys remain unchanged, so record overwrite and metadata exposure remain risks. Paired outgoing text now has a durable random ID and per-message sent/received/unconfirmed status, explicit retry after disconnect/restart and receiver deduplication. Legacy contacts retain their original profile.

Web ↔ extension and native ↔ extension exchanges were observed, including closed extension UI, stopped service worker with live offscreen engine, extension reload, storage retention and automatic reconnection. These clients share the core and do not establish independent implementation conformance. See [exact profile and limitations](PAIRED-CHAT-INCREMENT.md).

## Native paired-chat adapters (2026-09-20)

[Implemented profile](TRANSPORT-INCREMENT.md): Iroh 1.2.0 via Rust QUIC/TLS exporter and HyperDHT 6.34.0 via packaged native UDP/Noise runtime. Both reuse the shared participation/session authentication and durable chat engine. Web/extension advertise only their available WebRTC adapter. Real local transport integration tests and two Tauri app exchanges validated switching without changing conversation IDs, pins or history. No independent application implementation, external proof or group support is implied. The baseline tables above remain historical.

## Optional Nostr proof increment (2026-09-20, history)

The [proof increment](PROOF-INCREMENT.md) recorded external-signer Nostr and local imports of Pubky and Keet-compatible keys in an experimental `proof-*` protocol. It stays off: the rebuilt identity proofs (2026-09-23, [300](300-peer-proofs.md#implementation-2026-09-23-identity-proofs)) replaced it. Ghostly participation remains the default. All WISPs remain Draft; earlier baseline inspections are historical.
