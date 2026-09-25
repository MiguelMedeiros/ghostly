# WISP 4xx: Store-and-Forward for an Away Contact

| Field | Value |
|---|---|
| Number assignment | 4xx; planned, number to be defined |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-24 |
| Document kind | Profile |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [400](400-chat.md), [401](401-paired-chat.md), [403](403-dht-text.md), [1000](1000-storage.md), [1002](1002-s3-storage.md), [200](200-payments.md) |
| Implementation | Experimental: `hold/1` in web, extension and desktop clients; exercised against a local S3-compatible server |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md).

## Purpose

Today a message for a contact who is away reaches them only as short text through bounded DHT records ([403](403-dht-text.md)); a picture or a payment request waits until both are online ([401](401-paired-chat.md)). This profile lets what is sent meanwhile be **held** (text, a small file, a payment request) and delivered when the contact is back, with bounds that are stated rather than implied. Nothing here replaces the paired session or the DHT text path; a chat that does not turn it on behaves exactly as before.

## Options weighed

| | Where held items live | Who pays and controls quota | Renewal while the reader is away | Setup |
|---|---|---|---|---|
| **(a) The sender's own storage** (chosen) | The sender's S3-compatible space ([1002](1002-s3-storage.md)) or a self-hosted endpoint | The sender: abuse of the reader's resources is impossible; the reader only ever downloads what it accepts, within declared limits | The sender re-signs read addresses whenever it is online; the reader needs nothing from anyone while away | The sender's bucket must allow reads from the contact's client (CORS `GET`, any origin is fine for presigned reads) |
| (b) A mailbox the contact designates (their own storage) | The reader's space | The reader, who must pre-issue write slots (presigned `PUT`s) to each sender on a live session | Slots expire seven days after the reader was last online: the one who is away is the one who cannot renew | The reader's bucket must allow writes from every contact's client origin |
| (c) Larger DHT records only | Relays and the DHT | Nobody; relays already rate-limit and evict | Records are replaced by every publish and retained at the relay's discretion | None, but a picture does not fit in 1,000 bytes and never will |

(a) keeps the reader's exposure bounded and the reader's setup at zero, needs no server of Ghostly's, and its honest bound is the one people expect: *a held item can be picked up until seven days after the sender was last online*. (b) inverts who must be online to keep things alive. (c) preserves nothing but text and turns relays into a message store, which [403](403-dht-text.md) and the roadmap explicitly avoid.

## Consent: `hold/1`

A device offers `hold/1` in its paired offer ([401](401-paired-chat.md)) when the person turned **Hold messages** on for that chat. The same switch means both things: this device picks up what the contact held for it, and holds items for the contact when it can. Once the session is ready, each side also says `{"t":"paired-hold","on":<bool>,"top":<n>}` on the authenticated session (`top`: the highest sequence it has held for the other side), so a change takes effect without a new handshake; an older app drops the frame (it carries no id) and keeps the handshake offer. A device holds for a contact only when the contact's latest word allows it; a legacy peer never says so, so nothing is held for it and nothing is fetched from it. Consent is per chat and per direction of speech, never global.

A device holds items only while the paired session is closed and the chat is not in DHT-only mode; on an open session everything travels as in [401](401-paired-chat.md). Ecash (a bearer token) is never held: a payment *request* is. Ark, Bark, USDT and on-chain requests need live targets and are not held either.

## Keys

For a link with rendezvous keys *A* (mine) and *B* (the contact's), invite secret *s* and pinned participation keys *P<sub>me</sub>*, *P<sub>peer</sub>*:

- `context = JSON(["ghostly-hold/1", sort([A, B])])`, `derive(label) = HKDF-SHA256(ikm = s, salt = context, info = label, 32)`.
- Pointer identity: `identityFromSeed(derive("pointer:" + A))`; the contact's pointer address is `identityFromSeed(derive("pointer:" + B)).pubKey`. One Pkarr key per direction, distinct from the [403](403-dht-text.md) mailboxes and from presence.
- Seal key: `HKDF-SHA256(ikm = X25519(P_me, P_peer), salt = derive("envelope"), info = "ghostly-hold-envelope/1", 32)`. Both sides derive the same key; the bundle header says which direction it is.

Holding needs a pinned contact. This construction has no forward secrecy or post-compromise security, like [403](403-dht-text.md).

## Bundle

One held item is one object: `"GHLD" || 0x01 || nonce(24) || XSalsa20-Poly1305(sealKey, nonce, u32be(len(header)) || header || body)`.

`header = JSON([fields, signature])`, `fields = [1, from, to, author, recipient, mailbox, seq, id, ts, kind, meta, digest, expires]`, `signature = base64url(Ed25519(P_me, utf8(JSON(["ghostly-hold-bundle", fields]))))`. `from`/`to` are the rendezvous keys as the sender sees the link; `author`/`recipient` the participation keys; `mailbox` a random 22-character folder chosen once per link; `seq` a per-sender counter starting at 1; `id` the wire id of the message (`[A-Za-z0-9_-]{8,64}`); `ts` the message's timestamp; `digest` base64url SHA-256 of the body; `expires` when the sender drops it.

| `kind` | `body` | `meta` | Limit |
|---|---|---|---|
| `text` | UTF-8 text | None | 16 KiB |
| `file` | the bytes | `{ "name", "size", "mime" }`, `size` = body length | 8 MiB per bundle |
| `pay-req` | JSON of the [`pay-req`](../PROTOCOL.md#63-payments) frame without `t` | None | 64 KiB; Cashu and Lightning endpoints only |
| `manifest` | empty | `{ "entries": [[seq, id, kind, bytes, url, expires], …] }` | 64 KiB, at most 64 entries, sequences strictly increasing |

A receiver refuses a bundle whole, never partially, when: authentication fails; the header is malformed; `from`/`to`/`recipient` are not this link and this device; `author` is not the pinned contact; the signature fails; the digest does not match; `ts` is more than a minute in the future; `expires ≤ ts` or `expires` is more than one lifetime past now; `mailbox` differs from the manifest's; or the kind's limits are exceeded. A refused item is counted and skipped; its sequence is still passed, so a bad object cannot stall the mailbox.

## Storage layout ([1000](1000-storage.md))

Objects live under `<space>/hold/<mailbox>/`: items as `<seq, 8 digits>-<random 8>.ghostly-held`, the manifest as `manifest.ghostly-held`, media type `application/vnd.ghostly.held`. Names carry no key, name or device detail. The manifest is itself a sealed bundle listing every item the sender still holds, each with a **presigned read URL** (SigV4 query string, `host` the only signed header, `UNSIGNED-PAYLOAD`, at most seven days). The sender's credentials never leave the sender; a URL reads exactly one object until it expires.

## Pointer

Under its pointer identity the sender publishes one record, `_hold` = `secretbox(sealKey, JSON([body, signature]))`, `body = [1, rev, issued, expires, manifestUrl | null, top, ack, count, bytes]`, `signature` over `JSON(["ghostly-hold-pointer", from, to, body])`, TTL at most a day. `rev` increases with every publish; `expires` is the manifest URL's; `top` the highest sequence held; `ack` the highest sequence received from the contact; `count`/`bytes` what is held. The packet MUST fit 1,000 bytes; a storage address too long for that is refused at setup.

The record carries both roles: each side reads the other's pointer to learn what to fetch (`top`, `manifestUrl`) and what was received of its own (`ack`). A reader refuses a pointer under the wrong key, not decryptable, not signed by the pinned contact, dated in the future, or with a `rev` lower than one already seen.

## Lifecycle

**Holding.** The sender chooses the sequence and object name and saves them durably *before* uploading, so a retry after a crash reuses both. It uploads the bundle, rewrites the manifest with fresh URLs for everything held, publishes its pointer, and only then marks the message `held`. Any failure marks it `failed` with the reason; retry reuses the sequence. Per contact: at most 64 items and 64 MiB outstanding, 8 MiB per item, seven days each. Beyond that the send is refused before anything is chosen or stored.

**Picking up.** At start, when the chat is opened or the app comes back, when the contact's `paired-hold` names a higher `top`, and every 30 seconds while something is outstanding either way (every five minutes otherwise), a device reads the contact's pointer once. If `top` exceeds what it has and the manifest URL is live, it fetches the manifest, then each newer item in sequence order, never reading past the size the manifest declared. Each item is stored (message, file or payment request, deduplicated by its id) **before** the sequence advances, then the device publishes its own pointer with the new `ack`.

**Acknowledgement and cleanup.** Reading `ack` on the contact's pointer marks items `delivered`, removes their objects and rewrites the manifest. Items past `expires` are dropped and their messages marked failed ("held for seven days without being picked up"); the manifest and read URLs are re-signed every four days while anything is held and the device is online; the pointer is republished hourly in case a relay forgot it.

**States.** `sending` → `held` → `delivered`, or `failed` with the reason and an explicit retry. `held` means the item is in the sender's storage and pointed at; it says nothing about whether the contact will ever read it. `delivered` is the contact's word, signed.

## What this does and does not promise

- Storage and relays see ciphertext, object sizes, the number of items, and when they move. The sender's storage provider also sees the reader's address and the time it comes back; someone self-hosting their storage learns when their contact returns. This is the same class of exposure as relay polling, and it is stated in the setting.
- A held item can be picked up until seven days after the sender was last online, because only the sender can re-sign its read addresses. A sender offline for a week strands what it held until it is back.
- A Lightning invoice inside a held request may expire before it is read; the request's Cashu endpoint does not.
- Ordering is per sender by sequence; nothing is promised across the two directions or across held and live delivery. Ids deduplicate an item that arrives both ways.
- No retention or availability beyond the person's own storage provider's. A bucket that loses objects loses held items; the sender's row still says `held` until it learns otherwise (a fetch that fails is reported, not silently skipped).
- Not a group feature ([900](900-group-sessions.md) has its own catch-up); not sync between one person's devices.

## Compatibility

Additive. A chat without `hold/1` on both sides never uploads, fetches, publishes or reads a pointer. The `_dm` mailboxes and budgets of [403](403-dht-text.md) are untouched; when both hold and DHT text would apply, hold wins for that send. The [1002](1002-s3-storage.md) adapter gains `presign` and a second folder; the local-file adapter ([1001](1001-local-storage.md)) cannot hold (no addresses to hand out) and the setting says so.

## Conformance

Unit: bundle sealing/opening with every refusal (`packages/core/test/storeForward.test.ts`), the pointer fitting a packet and refusing forgeries, manifest limits, `hold/1` negotiation with and without an older peer, the presigned URL against AWS's published example (`packages/browser/test/backupStorage.test.ts`), and two engines over an in-memory bucket and relay (`packages/browser/test/hold.test.ts`): order across text, file and request, a tampered item refused and counted, quota refusals, retry after a failed upload, expiry. End to end (`e2e/web/store-forward.spec.ts`, against a local MinIO): one peer closes its page, the other sends text, a picture and a request, the first returns and gets all three in order with `held` → `delivered` on the sender; a tampered object is refused; a peer without the switch is unaffected.

## Open decisions

A WebDAV or Blossom adapter with the same `presign` contract; whether a reader should be able to require hold from a contact by policy; showing the reader's storage cost before accepting a large picture; the number.
