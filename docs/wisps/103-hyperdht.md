# WISP 103: HyperDHT

| Field | Value |
|---|---|
| Candidate number | 103; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.3 |
| Updated | 2026-09-25 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [100](100-transports.md) |
| Implementation | Experimental native adapter of the chat session (desktop); browsers through a HyperDHT relay (web app, extension); descriptors on the DHT (decided 2026-09-25; being implemented) |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Place in the one chat (revision 0.2)

HyperDHT is a native layer-1 candidate of the one chat ([400](400-chat.md), [100](100-transports.md#the-dht-floor-upgrade-and-downgrade-revision-02)). Its DHT is not the chat's layer 0: layer 0 is Pkarr on the Mainline DHT, and a HyperDHT lookup is part of dialling this transport. Proposed: its public key is published in the layer-0 capability record ([03](03-capabilities.md#layer-0-capability-record)), so it can be tried without a WebRTC session first. A failed attempt leaves the chat `on-dht`; a dropped session sends it there until a transport is back.

## Browser profile: through a HyperDHT relay (revision 0.3)

A browser has no UDP, so it cannot run HyperDHT itself. It can reach it through a **HyperDHT relay**: a server that runs the UDP half of HyperDHT and talks to the browser over one WebSocket (Holepunch's `@hyperswarm/dht-relay` protocol, [implementation](../../native-transports/hyperdht-relay/)). The chat session and its wire are the Desktop's: the same preface, the same length-prefixed frames, the same binding. A browser and a Desktop talk HyperDHT to each other.

**Non-custodial only.** dht-relay's client can hand its secret key to the relay, which then runs the handshake and the stream for it ("custodial", the library's default). A Ghostly client MUST NOT do that. In the non-custodial mode:

- the browser keeps its keypair and runs the Noise IK handshake; the relay forwards the handshake messages;
- the browser runs the encrypted stream (SecretStream) over the bytes the relay carries; the relay forwards ciphertext;
- the browser signs its own announcements; the relay asks for each signature;
- the binding below (the handshake hash and both keys) is computed by the two endpoints, so pinning, the transcript and the rank sum work unchanged.

**What the relay sees:** the browser's address; the HyperDHT keys it listens on and dials (per-chat transport keys, never the participation key); when and how much it sends; the holepunch secret and the stream id, which are hashes of the handshake and give no session key. It never sees a frame, a secret key or the handshake hash. For an incoming stream the relay also reports the dialling key; a relay that lies there makes the two transcripts differ, so the session fails ([401](401-paired-chat.md)): it cannot impersonate anyone, only drop the session, which it can do anyway.

**Descriptor.** A browser's descriptor is `{ "publicKey": <64 hex>, "relayed": true }`. `relayed` marks an endpoint reached only through a relay; a session that uses it ranks after every direct transport ([100](100-transports.md#relayed-transports-revision-03)). A Desktop ignores the field when dialling.

**Relay.** One WebSocket per relay per app, shared by the chats; each chat listens on its own transport key. The relay URL is a setting (`wss://`, or `ws://` to the device itself for development); none is set by default until a Ghostly relay is run. A browser offers `hyperdht/1` only once the relay answered and let it listen. When the relay goes away, the endpoints close, and the app listens again 30 s later or when a chat is opened. A relay limits each client (connections per address, listens, dials per minute, bytes per second) and refuses topic lookups and announcements, which Ghostly never uses.

**Browser crypto.** HyperDHT's Noise curve needs libsodium's `crypto_scalarmult_ed25519_noclamp`, which the browser build of sodium-universal lacks. A browser client supplies the same function (a canonical point of the prime-order subgroup, never the identity, the scalar taken modulo the group order) and MUST refuse the inputs libsodium refuses.

**First contact.** A browser learns a contact's HyperDHT key inside an authenticated session, so a first pairing still needs WebRTC (or both sides' keys on layer 0, [03](03-capabilities.md#layer-0-capability-record), once implemented).

**Implementation found and fixed (dht-relay 0.4.3, its latest release).** Relayed listening could not sign announcements on hyperdht 6.x; a failed incoming stream made the relay throw out of an event handler (one client could stop the process); a relay closing a gone browser's server waited forever for its signature. Ghostly's relay fixes all three.

## Local native implementation (2026-09-20)

The [native transport increment](TRANSPORT-INCREMENT.md) documents the implemented wire profile, negotiation rule, platform evidence and remaining limitations. It does not make this Draft Final or establish independent implementation conformance. Baseline absence statements below describe the initial inspection before that increment.

## Purpose and evidence

Evaluate HyperDHT as another optional data adapter. No adapter was found locally. [Upstream HyperDHT](https://github.com/holepunchto/hyperdht) documents encrypted connections addressed by public key, remote key inspection and a session handshake hash. Its DHT is not interchangeable with Pkarr's Mainline DHT record layer.

## Candidate contract

Ghost rendezvous exchanges an authenticated, bounded endpoint descriptor. Bind the HyperDHT public key and resulting secure connection to the participation key and negotiation attempt. Validate the remote endpoint; possession of an unrelated transport key is not Ghost admission.

Specify a framed byte-stream mapping with size limits, flow control, cancellation and bounded concurrent operations. Applying current JSON/chunk frames to a stream requires explicit length delimiting; a stream is not a DataChannel message boundary. Publish/listen lifetime must end according to local policy, without claiming remote caches are erased.

## Compatibility, security and open decisions

Pin the upstream version, bootstrap policy, firewall rules and endpoint-binding construction. Browser access goes through a HyperDHT relay (above); any other bridge needs its own feasibility evidence and threat analysis. Do not confuse a successful HyperDHT connection with Keet identity proof or Keet compatibility. Avoid global transport ranking; [100](100-transports.md) selects among permitted profiles.

## Conformance

Demonstrate chat over HyperDHT and another adapter without changing application semantics; reject substituted remote keys and truncated/oversized frames. Test bootstrap failure, prohibited connectivity paths, backpressure and reconnect. Results remain pending.

## References

[Transport negotiation](100-transports.md), [Keet feasibility](303-keet.md), [current frame definitions](../../packages/core/src/frames.ts).

## Revision log

- 0.3 (2026-09-25): browser profile through a non-custodial HyperDHT relay; the `relayed` descriptor field.
- 0.2 (2026-09-25): place in the one chat; not the chat's layer 0; public key in the layer-0 capability record (proposed).
- 0.1 (2026-09-20): initial review draft.
