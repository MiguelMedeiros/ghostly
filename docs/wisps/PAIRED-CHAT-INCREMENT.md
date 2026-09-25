# Experimental paired chat increment

> **Revision 0.2 of the chat family (2026-09-25).** This increment is now the layer-1 session of the one chat ([401](401-paired-chat.md)); "paired chat" is no longer a kind of chat the person picks. The DHT is the rendezvous and floor of every chat ([400](400-chat.md), [403](403-dht-text.md)). The transcript constant `"no-dht-payload"` below stays byte for byte: it says the *session* carries no DHT payload, not that the chat has no DHT fallback. Statements below that pairing needs WebRTC describe today's code; revision 0.2 proposes a first contact on the DHT in parallel.

**Subsequent implementation:** the [native transport increment](TRANSPORT-INCREMENT.md) extends this base to Iroh and HyperDHT on desktop. WebRTC-only statements below describe the initial base; initial product pairing still requires WebRTC.

Status: local experimental implementation, not a Final WISP or security audit. This additive profile exercises parts of candidates 02-03, 100-101, 400 and 800. It does not implement their entire proposed lifecycle or a general multi-adapter framework. Existing chats keep the legacy profile unchanged.

## What is implemented

The **New** panel and Home action **Try paired chat · experimental** creates a distinct `pair1/` bootstrap invitation. Both peers generate a separate participation Ed25519 key locally and persist it before connecting. Once WebRTC DTLS is established, they agree on the only implemented profile: version 1, `webrtc/1`, `chat/1`, with no DHT application payload fallback. Required overlap is validated; no compatible version/transport/chat capability produces an explicit failure.

Each peer proves possession of its participation key by signing a transcript bound to this WebRTC connection. Before first admission, both users compare a code through a trusted channel and explicitly confirm. Confirmation atomically pins the other participation key in local IndexedDB before sending readiness. New attempts with a different participation key fail against that pin. Reconnection reuses the stored participation, uses fresh nonces/DTLS context and automatically verifies the stored peer; the invite is not needed again.

This is **local admission consumption**, not destruction of the bootstrap secret on the global network. The old rendezvous credentials remain in local storage for finding the same peer. A copied invite still reveals those bootstrap credentials and may disrupt rendezvous/signaling or expose associated metadata. It cannot, by itself, supply the pinned participation's signature for a new bound application session. No new private chat text is placed in those DHT records. If trusted local pin/participation state is erased, there is no global revocation service to recover it. Migration to rotated rendezvous credentials, recovery and general single-use admission remain Draft work.

## Exact experimental wire profile

Bootstrap code: `pair1/<joining-bootstrap-seed-base64url>/<peer-rendezvous-key-z32>/<bootstrap-secretbox-key-base64url>`. The last three fields retain the legacy validated lengths. An unknown prefix is rejected, never downgraded. Private participation seeds are NOT included in the invite or engine's UI export.

The existing ordered/reliable `ghostly/1` WebRTC DataChannel carries these compact JSON objects. Canonical emitters put `t` first and use `JSON.stringify` without whitespace; handshake dispatch recognizes that canonical prefix. Handshake messages are limited to 4096 characters, all queued input to 60 KiB per message and 64 pending tasks. Negotiation/confirmation times out after 180 seconds. Legacy frames are not processed as applications in this profile.

1. `pair-offer`: `versions` (positive integer array), `transports` (identifier array), `capabilities` (identifier array), `key` (52-character z-base-32 participation key), `nonce` (32 random bytes, unpadded base64url). Each list is nonempty, unique and at most eight entries. Current offer is `[1]`, `["webrtc/1"]`, `["chat/1", "signed-signal/1"]`. An optional `extensions` list (same identifier rules, at most 32 entries) names behaviour that grants nothing, outside `capabilities` (which apps before 0.5 cap at 16 entries) and outside the transcript; a malformed one reads as absent and never fails the offer. The only entry is `ping/1`: this app answers `paired-ping` from the open ([401](401-paired-chat.md#liveness-and-reconnection)).
2. `pair-proof`: `sig` is an Ed25519 signature of the canonical transcript bytes, unpadded base64url (64-byte signature). The expected remote public key is checked against any stored participation pin.
3. `pair-ready`: `context` is the full lower-case SHA-256 transcript digest. Send only after local pin transaction completion. Application traffic is enabled only after valid remote proof plus both readiness decisions.

Canonical transcript is UTF-8 JSON of this array:

```text
[
  "ghostly-paired-chat", 1,
  sortedRendezvousPublicKeys,
  sortedDtlsSha256Fingerprints,
  offersSortedByParticipationPublicKey,
  [1, "webrtc/1", "chat/1", "no-dht-payload"]
]
```

Each offer tuple is `[key, nonce, versions, transports, capabilities]`. Sort keys/fingerprints lexicographically; fingerprints are lower-case 64-hex values extracted from the actual local and remote SDP of this peer connection. Every participating offer is included, so modification changes the proof context. The displayed comparison code is the first 24 hex characters of SHA-256, grouped by four. It is a comparison aid, not a password or an encryption key. A relayed proof from different DTLS endpoints, rendezvous context or fresh offers fails verification.

The implementation uses existing Ed25519 signing/verification and WebRTC DTLS. It does not implement a custom cipher, group ratchet or replacement for TLS. This particular application authentication composition still needs independent review; using standard primitives alone is not proof of protocol security.

## Chat, receipts and storage

Application objects:

- `paired-message`: `id` (16 random bytes, 22 unpadded base64url characters), `ts` (positive safe integer milliseconds), `m` (text, at most 16 KiB UTF-8).
- `paired-received`: matching `id`, sent after the receiving engine has completed its local message-storage transaction. It does not mean a human read it. Core callers supplying another storage callback must honor that contract.

Receiver storage deduplicates on link plus random message ID, including concurrent receipt/restart cases. Outgoing paired messages are persisted before transmission with a stable random `wireId`, `delivery` state and optional error. UI states are **Sending…**, **Sent · waiting for receipt**, **Not confirmed yet · sends again by itself** (`queued`), **Received by peer**, and **Delivery unconfirmed** (`failed`). A receiver-storage receipt is the only transition to delivered; timestamp aggregation is not used for these messages. Old history lacking per-message receipts remains unchanged and does not acquire invented delivery evidence.

A 20-second missing receipt, closed connection or engine restart leaves an unconfirmed message `queued`: it is sent again by itself (below), with the same wire ID and text, and the receiver acknowledges a duplicate without adding another message. A received message can therefore have an unconfirmed sender until the next attempt's receipt. Delivered is terminal in an IndexedDB transaction, so late send/timeout callbacks cannot undo it. Deleted rows are never resurrected by a receipt. Sender data, delivery states and the resend deadline persist across restart. The core keeps at most 128 in-flight receipt IDs, evicting the oldest when full; an evicted receipt cannot change the UI until the next attempt registers it again. Device storage loss/deleted tombstones limit deduplication; no distributed exactly-once claim is made. Group/global ordering is not implemented.

### Automatic resend

The policy lives in `RESEND_POLICY` ([outbox.ts](../../packages/browser/src/engine/outbox.ts)):

- **What is queued.** A text whose send failed, whose connection closed before its receipt, whose 20-second receipt wait ran out, or which was unconfirmed when the app closed. Any of these becomes `queued`, never `failed`, while its window and attempts last.
- **When it goes again.** A queued text is sent only while the chat can carry it: the live link, or the DHT text path with nothing else awaiting a receipt ([403](403-dht-text.md)). It is looked at after 5 s, 15 s, 30 s, 1 min, 2 min, then every 5 min. The data link opening skips the wait: every queued text goes at once, oldest first. What was sent on the old link and still awaits a receipt goes too, and so does a text still awaiting its receipt from the DHT fallback. A receipt on the link also ends the DHT's own retries.
- **The other paths.** In a live chat whose link is down, a queued text may take the DHT fallback, under the same ID. If that DHT text expires unconfirmed, it is queued for the live link, not published again. When both sides allow held items ([4xx](4xx-store-and-forward.md)) and the contact is still away after about a minute, the text is handed to store-and-forward under the same ID. From then on it follows the held states. The receiver stores every path under `peer_<id>`, so it is shown once whichever copy arrives first.
- **When it truly fails.** Queued for 7 days since it was first queued (the same week a held item lasts), or sent 8 times without a receipt: it becomes `failed`, **Delivery unconfirmed**, with **Retry message**. Retry starts a new window and a new count. In a DHT-only chat, a DHT text that expires unconfirmed is `failed` at once. Queuing it would publish it again every few minutes for as long as the contact is away.
- **Legacy chats** (the old, unpaired format) have no per-message receipts and are unchanged: a message is sent once, and nothing is resent.

Calls, files, payments and localhost are deliberately unavailable in this profile at both UI and core operation boundaries. They continue to work in legacy chats. Runtime availability of WebRTC is a precondition; no extension UDP assumption or automatic transport/identity bridge is introduced. General implemented/available/allowed capability negotiation beyond this fixed chat profile remains Draft.

## Failure and restart behavior

A durable compare-and-set admits at most one participation per stored link. Two different confirmation attempts cannot overwrite the winner. A duplicate confirmation of the same key is idempotent. A storage failure never enables chat. If one side persisted confirmation but the other did not, reconnect authenticates the pinned side and asks the unconfirmed side to compare the new code. A stale confirmation code is rejected. Losing all local keys is not silently repaired by reimporting the invite.

## Signed signaling migration and residual threat

Updated paired clients add an `auth` field to the existing compact RTC signal: the participation public key and Ed25519 signature of UTF-8 JSON `["ghostly-paired-signal", 1, senderRendezvousKey, recipientRendezvousKey, canonicalSignal]`. Canonical signal uses the validated fields in this order: `t, ts, o (when present), u, p, f, s, c`. Direction, timestamp, ICE parameters and DTLS fingerprint are covered. Before signing, the sender measures the actual encrypted DNS packet against the 1000-byte Pkarr budget. When necessary it removes duplicate candidate types, then less preferred host/server-reflexive routes while retaining at least one candidate. The final candidate set is signed anew; no authenticated field is truncated afterward. This can reduce alternate network routes, and a packet that still cannot fit fails explicitly. Signature verification happens before the DataLink state machine can update timestamps, handle glare or construct SDP. Existing signal age and answer/offer correlation checks still apply; replay of a legitimately signed still-fresh offer may affect availability.

The transcript-bound `signed-signal/1` capability is advertised by updated clients. Only after an authenticated connection to another supporting client does the durable pin transaction enable `requireSignedSignals`. This monotonic flag survives restart and thereafter rejects unsigned discovery. First-increment peers can continue to reconnect before this negotiated migration; participation keys, contact routes and history are retained. Both sides must stay on supporting versions after migration: restoring an old binary is not an authorized downgrade. If an older client cannot reconnect after upgrade, update both clients; do not erase pins as a repair. Lost participation state requires a new chat and comparison, not reuse of the old invite.

This reduces forged ICE/DTLS signaling and timestamp poisoning by a copied-invite holder. It does **not** rotate the rendezvous addresses or secretbox key: that holder can still read bootstrap metadata, overwrite/suppress records or replay valid observations. No global revocation, discovery availability or metadata secrecy is promised. Rotation with crash-safe two-party commit and recovery remains deferred rather than inventing a new key-exchange/ratchet in this patch.

 Neither perfect forward secrecy for old records, recovery from device compromise, global atomic invite use nor anonymity is claimed. No group implementation, MLS library, second data transport or external proof adapter is included.

## Source and validation

- [Session state machine](../../packages/core/src/pairedSession.ts), [data-link binding](../../packages/core/src/datalink.ts), [application gate](../../packages/core/src/ghostlink.ts).
- [Durable admission/message storage](../../packages/browser/src/engine/db.ts), [shared engine](../../packages/browser/src/engine/node.ts), [confirmation UI](../../src/components/PairingBanner.tsx).
- [Session tests](../../packages/core/test/pairedSession.test.ts), [invite tests](../../packages/core/test/pairedInvite.test.ts), [policy boundary test](../../packages/core/test/pairedLink.test.ts), [storage races/deduplication](../../packages/browser/test/pairedStorage.test.ts).

Cross-platform clients share code and are not two independent implementations of this profile.
