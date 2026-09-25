# WISP 100: Transport Negotiation

| Field | Value |
|---|---|
| Candidate number | 100; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.2 |
| Updated | 2026-09-25 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [01](01-ghost-core.md), [02](02-peer-keys.md), [03](03-capabilities.md), [403](403-dht-text.md) |
| Implementation | Experimental paired-chat negotiation; see increment |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## The DHT floor, upgrade and downgrade (revision 0.2)

Every 1:1 chat of [400](400-chat.md) has two layers. Layer 0 is the DHT: the rendezvous, and the floor that carries short text ([403](403-dht-text.md)) when nothing else connects. Layer 1 is the transport this document selects: WebRTC ([101](101-webrtc.md)), Iroh ([102](102-iroh.md)) or HyperDHT ([103](103-hyperdht.md)).

**The DHT is not a candidate.** It is never in a `pair-offer`'s `transports`, never in the rank sum, and never "selected". It is always there underneath. An empty intersection, or every candidate failing, does not fail the chat: it leaves it `on-dht` ([400](400-chat.md#states-of-a-chat)). The explicit no-common-transport result of the candidate negotiation below is reported as the reason (`no-common-transport`), not as an error.

### Inputs

Each side's candidates come from its layer-0 capability record ([03](03-capabilities.md#layer-0-capability-record)) before any stream exists, and from the transcript-bound `pair-offer` once a session is ready ([401](401-paired-chat.md)). The record carries, per native transport, a minimal descriptor that is enough to dial: the Iroh endpoint id, the HyperDHT public key (new). Today native descriptors are exchanged only inside an authenticated WebRTC session, so two desktops whose WebRTC never connects never try Iroh or HyperDHT; with descriptors on layer 0 they can.

### Upgrade

Once the contact is pinned, and unless either side is `dht-chosen`:

1. The dialling side (the lower rendezvous key, as today) ranks the intersection of both sides' transports by the implemented rank sum ([TRANSPORT-INCREMENT](TRANSPORT-INCREMENT.md#agreement-and-fallback)).
2. It tries them in that order, each within its own bounded attempt (WebRTC 15 s for a first pairing and 90 s later, as the pairing-latency work sets; Iroh and HyperDHT their dial timeouts). The first transport whose session authenticates ([401](401-paired-chat.md)) is used. With **Allow fallback** off, only the preferred transport is tried, as today, and the chat stays `on-dht` when it does not connect.
3. The chat moves to `live` on that transport, and the outbox flushes in order.

### Downgrade

Layer 1 is lost when its channel closes, when its runtime goes away (the native bridge exits, the browser suspends the page), or when liveness gives up (three pings in a row unanswered, [401](401-paired-chat.md#liveness-and-reconnection)). The chat then:

1. moves to `on-dht` at once and says so ("Live connection lost · texts go through the DHT");
2. marks every unconfirmed layer-1 text `queued`, and sends the ones that fit over the DHT under the same ids ([403](403-dht-text.md#when-text-goes-over-the-dht));
3. keeps files, payment requests and long texts waiting, or holds them ([4xx](4xx-store-and-forward.md)) where both sides allow it;
4. speeds its DHT mailbox reads back up ([403](403-dht-text.md#poll-pace)) and starts the background retry below.

A security rejection is not a downgrade: it stops the chat on both layers ([400](400-chat.md#candidate-requirements-for-the-one-chat)).

### Background retry and upgrade

Layer 1 is retried for as long as the app runs and the chat is not `dht-chosen`. There is no give-up timer (Q3 of [400](400-chat.md#compatibility-security-and-decisions)). The pace is today's, made the rule:

| Trigger | What happens |
|---|---|
| The contact is seen (a fresh presence packet under 30 s old) after being away, or a link that worked has just dropped | Dial at once |
| An attempt failed while the contact is online | Wait 20 s, doubling to at most 3 min, then the next attempt over the full ranked list |
| The person opens the chat, or brings the app to the front | Look for the contact at once and restart the wait; the non-dialling side republishes its presence |
| The network changes (online event, a new interface) | Restart the wait |
| The contact is not seen | Do not dial; keep reading its presence at the background pace |
| Both sides leave DHT only | Dial or answer at once, replaying a held offer ([403](403-dht-text.md#choosing-dht-only)) |

A transport that fails three attempts in a row while the contact is online MUST be moved to the end of this side's local order for an hour, so a path that is always blocked (a firewall eating UDP) does not delay the others at every retry. Its place is restored when it succeeds or the hour passes.

While `live`, the chat does not probe for a higher-ranked transport by itself; it changes only when the current one drops or someone switches ([transport switch](TRANSPORT-INCREMENT.md#agreement-and-fallback)). Probing while live was considered and decided against (below).

### DHT only as a choice

The per-chat Connection menu lists **DHT only** beside Automatic and the transports both apps support ([400](400-chat.md#pairing-progress-and-transport-rows)). Choosing it closes layer 1 and releases native endpoints for that chat, exactly as today's DHT-only mode does. It travels as the envelope's `mode` ([403](403-dht-text.md)), not as a `paired-policy` intent, because it must reach a contact that has no layer-1 session.

## Local native implementation (2026-09-20)

The [native transport increment](TRANSPORT-INCREMENT.md) documents the implemented wire profile, negotiation rule, platform evidence and remaining limitations. It does not make this Draft Final or establish independent implementation conformance. Baseline absence statements below describe the initial inspection before that increment.

## Local experimental increment

The opt-in [paired chat increment](PAIRED-CHAT-INCREMENT.md) now exercises a limited subset of this draft. It is not full conformance or a replacement for the broader candidate design below. Read its exact wire profile, local admission boundary and limitations separately from the legacy baseline.

## Scope and baseline

Choose an application transport without a global winner. Today `GhostLink` constructs `DataLink` directly; `PkarrTransport` abstracts rendezvous access, not data transport selection. PeerJS is a WebRTC implementation choice, not another adapter. Raw QUIC is not a separate milestone in this series.

## Candidate deterministic negotiation

This is a reviewable algorithm proposal, not an agreed wire standard:

1. Each authenticated offer contains the attempt context, allowed adapter/profile versions in local preference order, connectivity parameters and hard policy constraints. Exclude options prohibited by local privacy/security policy before ranking.
2. Intersect compatible adapter profiles and all hard constraints. Return an explicit no-common-transport result when empty. Missing optional external proofs need not prevent an otherwise allowed transport.
3. For two peers, use the lexicographically lower participation public key as selection coordinator. Follow that peer's advertised order within the common set; resolve any tied entries by canonical adapter/profile identifier. Both peers recompute and explicitly confirm the same choice and offer transcript before use. This simple asymmetric preference rule is a candidate for review, not an established fairness guarantee.
4. Attempt the selected adapter within a bounded, profile-defined timeout. Bind its authenticated remote endpoint to the participation keys and negotiation transcript before application traffic.
5. On failure, agree an incremented attempt and the next untried common candidate. Limit retries per attempt; the chat as a whole falls back to layer 0 and retries later (above), rather than failing. Never silently enable a relay, expose an address class or send DHT text to a party whose capability record forbids it (no `dht-text/1`). Changed policy/offer requires fresh agreement.

The adapter contract needs connect/accept, authenticated remote identity binding, send/receive with framing boundaries, backpressure, cancellation, error and close semantics. Support for reliable streams, datagrams and media is declared explicitly; adapters are not assumed interchangeable for every capability.

## Compatibility and security

Legacy WebRTC negotiation remains a distinct profile. New offers MUST NOT be interpreted as legacy `_rtc`. Compare signed/authenticated offers, selected versions and endpoint bindings to detect downgrade/substitution. A successful socket alone is insufficient. Group routing selection follows 900; the two-peer coordinator rule is not a group consensus algorithm.

## Open decisions

Decided (2026-09-25): a `live` chat does not probe for a higher-ranked transport in the background; a switch is explicit or follows a drop, which avoids churn on a working chat. The demotion window is three failures, one hour: long enough to stop paying for a blocked path, short enough to notice a network that changed. The native descriptors in the capability record carry no direct addresses: the Iroh endpoint id and the HyperDHT key are dialable through their own discovery, and addresses would expose network location in a record any invite holder can read before the pin.

Fix canonical encodings, adapter IDs, timeout/retry values, simultaneous negotiation resolution, transcript binding and protection against forced repeated failures. Latency measurement and weighted scoring are experiments, not requirements. Browser/native availability must be reported honestly; a bridge is a separate trust/visibility choice.

## Conformance

Revision 0.2: with every transport blocked the chat ends `on-dht` and chats; unblocking one moves it to `live` without action; two native peers whose WebRTC is blocked reach Iroh or HyperDHT from layer-0 descriptors; a drop mid-conversation falls back and returns with no loss or duplicate; a transport that always fails is demoted and restored.

Reverse offer arrival order and still choose the same result; exercise disjoint sets, crossed attempts, policy-prohibited relay fallback, timeout, stale selection and substituted endpoint keys. Demonstrate the same chat capability over at least two adapters before claiming interchangeability.

## References

[Current composition](../../packages/core/src/ghostlink.ts), [rendezvous interface](../../packages/core/src/transport.ts), [WebRTC adapter](101-webrtc.md), [group session](900-group-sessions.md).

## Revision log

- 0.2 (2026-09-25): the DHT as the floor under every transport, never a candidate; inputs from the layer-0 capability record; upgrade, downgrade and background retry rules; DHT only as a per-chat choice.
- 0.1 (2026-09-20): initial review draft.
