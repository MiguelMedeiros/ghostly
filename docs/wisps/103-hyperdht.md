# WISP 103: HyperDHT

| Field | Value |
|---|---|
| Candidate number | 103; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.2 |
| Updated | 2026-09-25 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [100](100-transports.md) |
| Implementation | Experimental native paired-chat adapter; see increment |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Place in the one chat (revision 0.2)

HyperDHT is a native layer-1 candidate of the one chat ([400](400-chat.md), [100](100-transports.md#the-dht-floor-upgrade-and-downgrade-revision-02)). Its DHT is not the chat's layer 0: layer 0 is Pkarr on the Mainline DHT, and a HyperDHT lookup is part of dialling this transport. Proposed: its public key is published in the layer-0 capability record ([03](03-capabilities.md#layer-0-capability-record)), so it can be tried without a WebRTC session first. A failed attempt leaves the chat `on-dht`; a dropped session sends it there until a transport is back.

## Local native implementation (2026-09-20)

The [native transport increment](TRANSPORT-INCREMENT.md) documents the implemented wire profile, negotiation rule, platform evidence and remaining limitations. It does not make this Draft Final or establish independent implementation conformance. Baseline absence statements below describe the initial inspection before that increment.

## Purpose and evidence

Evaluate HyperDHT as another optional data adapter. No adapter was found locally. [Upstream HyperDHT](https://github.com/holepunchto/hyperdht) documents encrypted connections addressed by public key, remote key inspection and a session handshake hash. Its DHT is not interchangeable with Pkarr's Mainline DHT record layer.

## Candidate contract

Ghost rendezvous exchanges an authenticated, bounded endpoint descriptor. Bind the HyperDHT public key and resulting secure connection to the participation key and negotiation attempt. Validate the remote endpoint; possession of an unrelated transport key is not Ghost admission.

Specify a framed byte-stream mapping with size limits, flow control, cancellation and bounded concurrent operations. Applying current JSON/chunk frames to a stream requires explicit length delimiting; a stream is not a DataChannel message boundary. Publish/listen lifetime must end according to local policy, without claiming remote caches are erased.

## Compatibility, security and open decisions

Pin the upstream version, bootstrap policy, firewall rules and endpoint-binding construction. Browser access and any native bridge need separate feasibility evidence and threat analysis. Do not confuse a successful HyperDHT connection with Keet identity proof or Keet compatibility. Avoid global transport ranking; [100](100-transports.md) selects among permitted profiles.

## Conformance

Demonstrate chat over HyperDHT and another adapter without changing application semantics; reject substituted remote keys and truncated/oversized frames. Test bootstrap failure, prohibited connectivity paths, backpressure and reconnect. Results remain pending.

## References

[Transport negotiation](100-transports.md), [Keet feasibility](303-keet.md), [current frame definitions](../../packages/core/src/frames.ts).

## Revision log

- 0.2 (2026-09-25): place in the one chat; not the chat's layer 0; public key in the layer-0 capability record (proposed).
- 0.1 (2026-09-20): initial review draft.
