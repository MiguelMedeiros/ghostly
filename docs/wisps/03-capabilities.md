# WISP 03: Capability Negotiation

| Field | Value |
|---|---|
| Candidate number | 03; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.3 |
| Updated | 2026-09-25 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [01](01-ghost-core.md), [02](02-peer-keys.md), [403](403-dht-text.md) |
| Implementation | Existing advertisements and the paired `pair-offer`; the layer-0 capability record (decided 2026-09-25; being implemented) |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Capabilities on two layers (revision 0.2)

The one chat of [400](400-chat.md) negotiates capabilities in two places:

| Where | When | Authority |
|---|---|---|
| **Layer 0 capability record** (new, below) | From the first contact, and whenever there is no layer-1 session | Says what each side accepts on the DHT, and predicts what layer 1 would carry. Enough to decide what to send over the DHT, what to hold and what to queue |
| **`pair-offer`** of the layer-1 session ([401](401-paired-chat.md)) | Each time a session opens | Transcript-bound and signed. Authoritative for everything the session carries |

When the two disagree (an app updated between them, a setting changed), the `pair-offer` wins for layer 1, and the record is corrected at its next publication. Anything queued for a capability the session turns out not to have fails with its reason ("<contact>'s app cannot receive files") instead of waiting forever.

### Layer 0 capability record

(New. Semantic sketch; exact bytes are a blocker before Proposed.)

**Where.** One Pkarr record per direction under its own identity, derived like the [403](403-dht-text.md) mailboxes and the [4xx](4xx-store-and-forward.md) pointer from the invite secret and the ordered rendezvous keys, with its own label (`"caps:" + A`). It is distinct from presence, the mailboxes and the hold pointer, so its size never competes with a text.

**Sealing.** Before the pin, sealed with the invitation-derived envelope key and signed by the author's participation key (the joiner's key is learned from it, as from a first-contact envelope). After the pin, sealed with the post-pin envelope key of [DHT delivery](../DHT-DELIVERY.md#invitation-bootstrap-and-encryption), so a copied invite no longer reads it.

**Contents.** `[1, rev, issued, author, versions, transports, capabilities, extensions, descriptors, name, choice?]`, signed over `["ghostly-caps", from, to, body]`:

| Field | Meaning | Bound |
|---|---|---|
| `rev` | Increases with every change | Safe integer |
| `versions` | Session versions, as in `pair-offer` | At most 8 |
| `transports` | Layer-1 transports this runtime has, in local preference order (`iroh/1`, `hyperdht/1`, `webrtc/1`): every one it can run for this chat, started or not. `descriptors` names the started ones, so a contact tells a transport still starting from one the app lacks ([100](100-transports.md#a-chosen-transport-not-reached-yet-revision-04)) | At most 8; never `dht` ([100](100-transports.md#the-dht-floor-upgrade-and-downgrade-revision-02)) |
| `capabilities` | The same identifiers as `pair-offer`, plus the layer-0 ones: `dht-text/1` (accepts [403](403-dht-text.md) text) and `hold/1` (the **Hold messages** consent of [4xx](4xx-store-and-forward.md)) | At most 32 |
| `extensions` | As in `pair-offer`: behaviour that grants nothing | At most 32 |
| `descriptors` | Per native transport, the minimum to dial: the Iroh endpoint id and the relay it is homed on, the HyperDHT public key (and the relay a browser's goes through). No addresses | At most one per transport |
| `name` | The name this profile shares with contacts ([401](401-paired-chat.md#name-and-picture)); empty when it shares none | At most 64 UTF-8 bytes |
| `choice` | Optional, revision 0.3. The layer-1 transport chosen for this chat in its Connection menu; absent on Automatic. How a contact with no session hears of a choice ([100](100-transports.md#a-choice-made-while-not-live-revision-05)) | One transport identifier, never `dht` |

The complete packet MUST fit 1,000 bytes. If it does not, the author drops `name`, then `extensions`, and fails explicitly if it still does not fit; it never truncates `capabilities` or `transports`.

**Refresh.** Published at first start of the chat, at every change, and hourly while the chat exists. A change includes a native descriptor that changes after its endpoint started: a desktop's Iroh endpoint names the relay it is homed on only a few seconds after it binds, and a browser can dial it through nothing else ([102](102-iroh.md#browser-profile-relay-only-revision-03)). The mailbox envelope carries the record's current `rev` (a new optional trailing element; readers MUST ignore trailing elements they do not know), so a contact re-reads the record only when it changed, when the chat drops to `on-dht`, or at pairing.

**Reading it.** A record just read is the author's latest word on how to dial it: its relay (or a new endpoint) replaces the one the reader knew, keeping the addresses a session gave for the same endpoint, and the transport's failures from before count no more. A record kept from an earlier read only fills what the reader lacks, since a later session may have said more. A reader refuses a record under the wrong key, not decryptable, not signed by the pinned participation key (or, before the pin, by a key other than the one its first-contact envelope carries), dated more than a minute in the future, or with a `rev` lower than one already seen. A refused record leaves the last good one in force; a contact with no readable record is treated as offering `chat/1` and `dht-text/1` only.

**What it enables on layer 0.** Exactly two things: DHT text, when the recipient's record lists `dht-text/1`; and holding, when both records list `hold/1` (the per-session `paired-hold` frame still updates it on layer 1). Every other capability in the record only predicts layer 1, so the UI can say "Sends when live" rather than "Not supported".

**Privacy.** A capability set is a fingerprint that can correlate devices across chats. Before the pin, anyone holding the invite reads it, including the native descriptors; those identify endpoints that accept only authenticated sessions, and carry no network address.

## Local experimental increment

The follow-up adds transcript-negotiated signed signaling, durable per-message delivery/retry state and observed extension interoperability; see the [implementation profile](PAIRED-CHAT-INCREMENT.md) for exact partial coverage and residual risks. This does not change Draft status.

The [chat session increment](PAIRED-CHAT-INCREMENT.md), now the live session of every new chat ([401](401-paired-chat.md)), exercises a limited subset of this draft. It is not full conformance or a replacement for the broader candidate design below. Read its exact wire profile, local admission boundary and limitations separately from the legacy baseline.

## Scope and baseline

Negotiate what a session can do separately from how it connects. Existing `_svc` and `hello.svc` advertise services, not a general capability agreement. `svc` refreshes the authoritative live list. Current limits: 16 services, IDs up to 32 characters, names up to 48, up to eight metadata entries. Legacy peers implicitly offer chat/voice/video.

## Candidate profile

A semantic offer lists capability identifier, supported versions, required/optional status and bounded parameters. A selection chooses an exact version and accepted limits for each capability, authenticated with both offers and the session context. Identifiers and canonical encoding are not assigned here.

Compute the version intersection. Reject a missing required capability or incompatible required version explicitly; omit unsupported optional entries. Unknown optional identifiers are not enabled automatically. Required extensions MUST be understood. Limits are the stricter compatible limits of both peers, not an assumption that the newer client wins. Parameters incompatible with local policy fail rather than broaden access.

Capabilities authorize behavior only after local consent. Advertising `http` does not authorize arbitrary local destinations; payment support does not authorize spending. Reconfiguration has a monotonically advancing revision and acknowledged selection before the newly enabled behavior starts. A withdrawal should close affected operations without changing unrelated permissions.

## Compatibility and privacy

Use a new negotiated envelope for this profile. Preserve old `_svc` parsing; legacy implicit services are not consent to new capabilities. Move large descriptions off rendezvous and expose only the minimal advertisement needed to connect. Capability fingerprints may correlate devices even when keys differ.

## Decisions, open questions and conformance

Decided (2026-09-25): the capability record has its own Pkarr key, one more read per chat at pairing and on change, so a text never loses room in the mailbox packet to capabilities; `name` belongs in it, so a chat that never goes live still shows a name. Test a record over budget, a record whose `rev` goes backwards, a record signed by an unpinned key, and a `pair-offer` that contradicts the record.

Choose identifier registry, exact version rules, canonical offer/selection encoding, revision persistence and cancellation behavior. Test overlapping/disjoint versions, malformed limits, unknown required/optional fields, concurrent updates and policy rejection. Both implementations must agree on the same exact enabled set. Existing permissive version parsing is not proof of this negotiation.

## References

[Services](../../packages/core/src/services.ts), [session frames](../../packages/core/src/frames.ts), [transport selection](100-transports.md).

## Revision log

- 0.3 (2026-09-25): the optional trailing `choice`; the record is published again when a native descriptor changes, and a record just read replaces the relay the reader knew. Apps from before ignore the element, as trailing elements are ignored.
- 0.2 (2026-09-25): capabilities on two layers; the layer-0 capability record (sketch), with `dht-text/1`, `hold/1`, minimal native descriptors and the shared name.
- 0.1 (2026-09-20): initial review draft.
