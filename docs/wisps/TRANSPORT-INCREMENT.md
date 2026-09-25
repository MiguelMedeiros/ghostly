# Experimental native transport increment

> **Revision 0.2 of the chat family (2026-09-25).** The transports here are layer 1 of the one chat ([400](400-chat.md)); the DHT underneath is its rendezvous and floor ([100](100-transports.md#the-dht-floor-upgrade-and-downgrade-revision-02)). "No DHT message fallback" below is about the **Allow fallback** toggle between adapters: that toggle never picks the DHT. When no adapter connects, the chat falls to DHT text regardless of the toggle, as it already does after a drop, unless the contact refuses DHT text.

Implemented locally on 2026-09-20, after the [paired-chat base](PAIRED-CHAT-INCREMENT.md). All WISPs remain Draft. This is the exact bounded implementation profile, not full conformance to every candidate requirement in WISPs 100 to 103.

## What runs

The same `GhostLink`, participation proofs, chat framing, IndexedDB history, receipt handling and outbox now run over `webrtc/1`, `iroh/1` and `hyperdht/1`. Native adapters are injected by the desktop host. Browser and extension hosts inject neither native adapter and advertise only available WebRTC. This does not establish that upstream Iroh can never support browsers.

The product's **initial pairing still uses WebRTC**. Once both people confirm, native descriptors are exchanged inside the authenticated session and saved locally. Later native reconnects use those descriptors; they do not need a fresh WebRTC connection or new invite. Headless integration tests explicitly provision initial native descriptors as fixtures rather than claiming a new public invite format.

Each adapter gets a separate random, persistent seed per conversation, distinct from the participation seed and the other transport's seed. Switching adapters leaves the conversation ID, participation pins, message IDs and history untouched. There is a controlled close/reconnect and fresh authentication, not seamless migration of an in-flight stream.

## Real transport bindings

- **Iroh 1.2.0:** native Rust endpoint, ALPN `ghostly/paired-chat/1`, one bidirectional QUIC application stream. The adapter obtains both actual endpoint IDs and a 32-byte TLS exporter using label `EXPORTER-Ghostly-paired-chat-v1` and the ALPN bytes as context. Endpoint IDs are sorted in the transcript. The exporter differs on reconnect and agrees on both sides of one connection. [Upstream Connection API](https://docs.rs/iroh/1.2.0/iroh/endpoint/struct.Connection.html).
- **HyperDHT 6.34.0:** native UDP discovery/hole punching and NoiseSecretStream. The adapter obtains the stream's actual local/remote public keys and its 64-byte `handshakeHash`; it does not accept a hash supplied by an application message. [Upstream HyperDHT API](https://github.com/holepunchto/hyperdht#serveronconnection-socket).
- Existing WebRTC continues to bind the actual DTLS fingerprints. Native adapters do not fabricate DTLS fingerprints or reuse them as native channel bindings.

For native sessions the canonical signed transcript uses `[transportId, sortedEndpointIds, connectionContextHex]` in the binding slot, and the actual selected transport in the selection tuple. Both ordered offers, fresh nonces, rendezvous keys and `chat/1` remain signed. Participation pins are checked before application messages. A proof from another channel, endpoint, transport or rendezvous does not verify.

Both native streams use a 4-byte big-endian length and a nonempty UTF-8 frame of at most 60 KiB. HyperDHT exchanges the fixed application preface in both directions; the Iroh initiator writes that preface to make its stream visible to the accepter. Application text retains the existing 16 KiB limit. Native bridge queues and unfinished connections are bounded; closing a channel leaves unacknowledged messages uncertain.

## Agreement and fallback

Available adapters are ordered by local preference, then the fixed fallback order. Disabling **Allow fallback** offers only the selected available adapter. The intersection is ranked symmetrically by the sum of its positions in both offers, breaking ties in `iroh/1`, `hyperdht/1`, `webrtc/1` order. This differs from the coordinator proposal still under review in WISP 100; it is the implemented experimental rule.

An empty intersection fails explicitly. Both sessions recompute the ranking. A lower-ranked active transport needs both peers' authenticated `transport-fallback/1` capability; there is no DHT message fallback. The selected adapter can differ from one person's preference, and the panel reports the actual connection separately from the preference control. A control-plane acknowledgement on the established authenticated session coordinates an intentional reconnect; the replacement session independently authenticates its channel and offers.

Iroh uses its N0 preset and HyperDHT its upstream default discovery. **The fallback toggle controls the choice of adapter, not relay-versus-direct routing inside an adapter.** This increment has no separate relay prohibition, address-class policy, anonymity mode or external identity requirement. Those broader draft policies are not claimed as implemented.

## Native packaging and lifecycle

Iroh is linked into the Rust app. HyperDHT runs in a fixed packaged Node process, reached through private stdin/stdout pipes, with no localhost administration server. The main window alone can invoke the transport commands; contact service windows remain denied. No arbitrary executable/module/path is accepted from a peer or UI command. Node options/module-path injection is removed from the child's environment; seeds travel through stdin rather than process arguments.

`node scripts/prepare-native-runtime.mjs` installs the separate locked dependency graph, copies the build host's Node executable and packages the runtime. Generated files are ignored under `src-tauri/native-runtime`; dependency versions remain in the checked-in lockfile. The local tested bundle is macOS arm64. Cross-architecture packaging and signed release distribution need their own platform validation; a successful local app is not evidence for Windows/Linux/mobile release support. The bundled runtime adds approximately 137 MiB before app packaging in this environment.

Each runtime limits native endpoints to eight per adapter and two admitted channels per endpoint. Iroh descriptors keep at most eight addresses, prioritizing IPv4 so temporary IPv6 addresses cannot displace every LAN route. Startup/dial timeouts surface failure. A lost native runtime closes its channels and is removed from runtime availability; uncertain messages are queued and sent again once a channel is back ([automatic resend](PAIRED-CHAT-INCREMENT.md#automatic-resend)).

## Reproducible validation

```sh
cargo build -p ghostly-transports --example iroh-peer
cargo test -p ghostly -p ghostly-transports
TEST_NATIVE=1 npm run test -w @ghostly/browser -- irohInterop nativeMigration
npm test
npm run typecheck
npm run lint
```

The native integration tests use real QUIC endpoints in separate Rust processes, real HyperDHT/Noise endpoints with a three-node local UDP testnet, the shared `GhostLink`, and IndexedDB transactions through fake-indexeddb. They exercise confirmation, lost receipts, reconnect, retry with the same message ID, receiver deduplication and Iroh → HyperDHT → Iroh switching. These are real transport tests with controlled discovery/storage, not independent implementations of the application authentication profile.

Manual validation in two separate Tauri bundles used the public default infrastructure: WebRTC pairing, Iroh without fallback, bidirectional messages/receipts, app restart, HyperDHT without fallback and bidirectional messages/receipts, all within the same conversation.

## Deliberate limits

Only paired text chat is exposed on these adapters. Files, media, payments, localhost services, external proofs and groups are not added. Existing legacy features remain separate. Bootstrap credentials are still retained; signed discovery and pinned participation prevent invite reuse from impersonating the paired participant but do not prevent DHT suppression or erase old records. Receipts mean remote local persistence; device loss and deleted history limit deduplication. No distributed exactly-once, global revocation, erasure, independent crypto audit or uninterrupted hot migration is claimed.
