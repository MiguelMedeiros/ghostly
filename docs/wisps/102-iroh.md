# WISP 102: Iroh

| Field | Value |
|---|---|
| Candidate number | 102; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.3 |
| Updated | 2026-09-25 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [100](100-transports.md) |
| Implementation | Experimental native adapter of the chat session (desktop); relay-only browser build in the web app and the extension (2026-09-25); descriptors on the DHT (decided 2026-09-25; being implemented) |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Place in the one chat (revision 0.2)

Iroh is a native layer-1 candidate of the one chat ([400](400-chat.md), [100](100-transports.md#the-dht-floor-upgrade-and-downgrade-revision-02)). Proposed: its endpoint id is published in the layer-0 capability record ([03](03-capabilities.md#layer-0-capability-record)), so two desktops can try Iroh without a WebRTC session first (today its descriptor is exchanged only inside an authenticated session). The endpoint id is dialled through Iroh's own discovery; no address goes into the record. An Iroh attempt that fails leaves the chat `on-dht`, and a dropped Iroh session sends it there until a transport is back.

## Browser profile: relay only (revision 0.3)

The web app and the extension run the same Iroh (1.2.0, the version the desktop pins) compiled for browsers (`native-transports/iroh-web`, shipped as `@ghostly/iroh-web`). A page cannot send UDP, so a browser endpoint has no direct address: every packet goes through an **Iroh relay** over a WebSocket. The QUIC/TLS session is still end to end between the two endpoints. The relay sees which endpoint ids talk, when, how much and from which IP; it never sees frames.

- **Wire.** Identical to the native adapter: ALPN `ghostly/paired-chat/1`, the stream preface, u32 length-prefixed text frames of at most 60 KiB, and the binding from the TLS exporter (label `EXPORTER-Ghostly-paired-chat-v1`, context = ALPN, 32 bytes). A browser endpoint and a desktop endpoint compute the same binding, so pinning and the paired handshake ([401](401-paired-chat.md)) are unchanged. A browser pairs with a browser and with a desktop, either side dialling.
- **Descriptor.** `{ "id": <endpoint id>, "relay": <relay URL>, "addresses": [], "relayed": true }`. `relayed` marks the path as relayed for the rank ([100](100-transports.md#relayed-transports-revision-03)); a native reader ignores it. A desktop dials the browser through the relay URL in the descriptor; the browser dials a desktop through the desktop's home relay and ignores its direct addresses. A descriptor with no relay cannot be dialled from a browser.
- **Relays.** A list of at most four HTTPS relay URLs (plain HTTP on loopback only, for tests), in Settings, Network. The default is n0's public relays, the ones the desktop's Iroh homes on, so browser and desktop endpoints share relays with no Ghostly server. Self-hosting `iroh-relay` is the way to take this metadata off a third party; no Ghostly relay is deployed yet.
- **Loading.** The wasm (2.9 MB, about 1.1 MB gzipped) loads when a chat first starts an endpoint, never with the app. `iroh/1` is offered only once the endpoint is online at a relay; an endpoint that cannot reach one within 10 s reports why and is not offered.
- **Platforms.** Web: CSP `script-src 'wasm-unsafe-eval'`, `connect-src https: wss:`. Extension: the offscreen document runs it under the manifest's `extension_pages` CSP (`'wasm-unsafe-eval'`, no `connect-src` limit). The desktop keeps its native adapter and does not carry the browser build.

Measured (2026-09-25, Chromium, one machine): through a local relay the endpoint is online in 0.23 s and connects in 24 ms (paired handshake 48 ms, 12.5 MiB/s); through n0's public relays, from Brazil, online in about 2 s, connect in about 0.5 s, 290 to 380 ms per frame round trip (two client-to-relay round trips) and about 1 MiB/s.

## Local native implementation (2026-09-20)

The [native transport increment](TRANSPORT-INCREMENT.md) documents the implemented wire profile, negotiation rule, platform evidence and remaining limitations. It does not make this Draft Final or establish independent implementation conformance. Baseline absence statements below describe the initial inspection before that increment.

## Purpose and evidence

Evaluate Iroh as an optional data adapter, independent of external identity proofs. No Ghost adapter was found in the inspected source. Upstream exposes endpoint identities and application protocol selection; this is not evidence of Ghost compatibility. See [Iroh endpoint source](https://github.com/n0-computer/iroh/blob/main/iroh/src/endpoint.rs) and [protocol examples](https://www.iroh.computer/proto).

## Candidate contract

Exchange a bounded endpoint descriptor through authenticated negotiation, bind that endpoint's key to the Ghost participation and attempt, and verify the remote endpoint before application traffic. Define stream-to-frame mapping, maximum frames, concurrent streams, backpressure, half-close and failure propagation. Do not reuse Ghost secret key bytes as Iroh credentials by convention.

Relay/discovery use and address visibility must be exposed as policy inputs to [100](100-transports.md). Disable prohibited routes or fail clearly. Protocol negotiation/ALPN alone does not prove the remote endpoint belongs to the expected Ghost peer.

## Compatibility, security and open decisions

Pin an upstream version and prove native and browser feasibility separately (browser: revision 0.3, relay only). Select the application protocol identifier only through registry review. Decide reliable framing and media support; Iroh gossip is not the GossipSub profile in [901](901-gossipsub.md). No mandatory Iroh deployment, relay or wallet is introduced.

## Conformance

Two independent Ghost adapter implementations exchange the same capability payload; reject mismatched endpoint binding, reconnect with fresh context, test relay policy and bounds. Native success must not be reported as browser support. All results are pending.

## References

[Transport negotiation](100-transports.md), [participation lifecycle](02-peer-keys.md), [evidence ledger](IMPLEMENTATION.md).

## Revision log

- 0.3 (2026-09-25): browser profile, relay only: same wire and binding, `relayed` descriptor, relay settings, measurements.
- 0.2 (2026-09-25): place in the one chat; endpoint id in the layer-0 capability record (proposed).
- 0.1 (2026-09-20): initial review draft.
