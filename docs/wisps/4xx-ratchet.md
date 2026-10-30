# WISP 4xx: Forward Secrecy for a Chat's Stored Paths

| Field | Value |
|---|---|
| Number assignment | 4xx; planned, number to be defined (407 reserved) |
| Status | Draft |
| Editors | Ghostly contributors; maintainer review pending |
| Document kind | Profile |
| Dependencies | [400](400-chat.md), [401](401-paired-chat.md), [403](403-dht-text.md), [404](404-store-and-forward.md), [03](03-capabilities.md), [05](05-backups.md), [06](06-devices.md) |
| Implementation | `ratchet/1` in the web app, the extension, Desktop and the CLI: the ratchet with these test vectors (`packages/core/src/ratchet.ts`), the DHT floor (`dhtDelivery.ts`), held items (`storeForward.ts`, `engine/hold.ts`); state kept out of backups and handoffs. Unit tests; the Tech Info row and end-to-end tests follow |
| Summary | What a chat sends while the contact is away, over the DHT or held, is sealed with keys used once: a key stolen later cannot open it. |
| Availability | Available |
| Notes | 1:1 chats, when both apps have it; groups are not covered. A live connection already agrees fresh keys every time. |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Purpose

A 1:1 chat ([400](400-chat.md)) carries what it sends on three paths. Two of them seal everything with one key per chat that never changes: someone who records those packets today and steals a participation key later opens all of them ([SECURITY-REVIEW](../SECURITY-REVIEW.md) S16; [403](403-dht-text.md) and [404](404-store-and-forward.md) say they have no forward secrecy). This profile, `ratchet/1`, gives those two paths keys used once, from a double ratchet in the manner of [Signal's](https://signal.org/docs/specifications/doubleratchet/): an X25519 step each time the turn passes between the two sides, and a one-way chain of keys between steps. A key deleted after use cannot be computed again from anything the device keeps.

## What has fresh keys today

| Path | Sealed today with | Forward secret today | With `ratchet/1` |
|---|---|---|---|
| The live session ([401](401-paired-chat.md)) | The transport: WebRTC DTLS, QUIC TLS 1.3 for Iroh, Noise for HyperDHT. Each connection agrees an ephemeral key, and the signed transcript binds the participation keys to that connection | Yes, per connection | Unchanged |
| The DHT floor after the pin ([403](403-dht-text.md)) | `sealedKey`: HKDF of X25519 of the two participation keys, salted with the invite's envelope key | No | Ratcheted, lane `floor` |
| Held items ([404](404-store-and-forward.md)) | `sealKey`: HKDF of the same agreement, salted with the hold context | No | Item bundles ratcheted, lane `hold`; the manifest and pointer stay as today |
| First contact, before the pin ([403](403-dht-text.md#first-contact)) | The invite's envelope key | No | Unchanged: there is no pinned key to start from |

A session frame never goes through this profile: what a recorded live connection holds is already out of reach of a stolen participation key, and a second layer would cost every frame for no gain against that thief. The participation key still authenticates everything: it signs the live transcript, every floor envelope's body and every held item's header, as before.

## Negotiation and upgrade

An app that implements this profile lists `ratchet/1` in its layer-0 capability record ([03](03-capabilities.md#layer-0-capability-record)), beside `dht-text/1`. It is not in `pair-offer`: the live session does not carry it, and the offer's lists are full for older apps.

- **Sending.** A side seals a floor envelope or a held item with the ratchet when this side has opened a ratcheted item from the contact (a lane is `heard`, below), or when the contact is pinned, its newest readable record lists `ratchet/1`, and it has shown that it pinned this side too (an envelope of its sealed to this side was read, or a live session was had). Otherwise it seals as today. The last condition matters at first contact: a joiner pins its inviter from the invite, and a first envelope sealed with the ratchet would reach an inviter that cannot open it and so never pins the joiner.
- **Upgrade of a chat that exists.** Nothing is migrated and no invite is needed: the first item sealed after both records list `ratchet/1` starts a session ([Sessions](#sessions)). Messages already in the chat stay as they were stored; what was recorded before the upgrade stays as open to a later key thief as it was.
- **An older contact.** A contact whose record lacks `ratchet/1`, or that has no readable record, gets plain envelopes and bundles, exactly as today, and never a ratcheted one it could not read.

## Keys

All sizes in bytes. `HKDF` is HKDF-SHA256, `HMAC` is HMAC-SHA256, `"…"` is the UTF-8 of that text, `||` is concatenation. `P_self`, `P_peer` are the participation keys (Ed25519, 32 bytes; their z-base-32 text where a string is said); `x(P)` is the X25519 form of an Ed25519 key (the Montgomery form of the public key, the clamped SHA-512 scalar of the seed), as the floor already uses.

- **Roles.** The side whose `P` is smaller, compared as 32 unsigned bytes, is the **first** side; the other is the **second**. Both know the order without a message.
- **Salt.** `salt = HKDF(ikm = invite secret, salt = JSON(["ghostly-ratchet/1", sort([A, B]), sort([P_self, P_peer])]), info = "ghostly-ratchet/1 salt", 32)`, with `A`, `B` the chat's rendezvous keys and the participation keys as z-base-32 text, each pair sorted as strings, `JSON` as `JSON.stringify` writes it.
- **Root of a session.** `RK0 = HKDF(ikm = X25519(x(P_self), x(P_peer)), salt, info = "ghostly-ratchet/1 root" || sid, 32)`, where `sid` is the session's 8-byte id. Every label starts with `ghostly-ratchet/1`, so no key here equals one the floor, holding or the groups derive.
- **A step.** `step(RK, dh) = HKDF(ikm = dh, salt = RK, info = "ghostly-ratchet/1 step", 64)`: the first 32 bytes are the next root key, the last 32 a chain key `CK`.
- **Two lanes per step.** From one `CK`: `floor = HMAC(CK, "ghostly-ratchet/1 lane floor")` and `hold = HMAC(CK, "ghostly-ratchet/1 lane hold")`. Each lane counts its own messages from 0, so a lane where most messages are never read (the floor) does not leave gaps in the other.
- **A chain.** Message `n` of a lane: `MK = HMAC(CK_n, 0x01)`, then `CK_{n+1} = HMAC(CK_n, 0x02)`, and `CK_n` is forgotten.
- **A message.** `HKDF(ikm = MK, salt = 32 zero bytes, info = "ghostly-ratchet/1 message", 56)`: a 32-byte key and a 24-byte nonce for XChaCha20-Poly1305. The nonce is never sent. A key is used once, so its nonce is too ([Saving state](#saving-state)).
- **Starting.** The first side picks a random X25519 secret `D1` and at once steps: `(RK1, CK) = step(RK0, X25519(D1, x(P_peer)))`, sending lanes from `CK`; it reads the second side's first messages on lanes from `CK0 = HMAC(RK0, "ghostly-ratchet/1 initial")`, under `x(P_peer)`. The second side sends on lanes from `CK0`, naming `x(P_self)` as its key, until the first side's first message comes; that message names `D1`'s public key, and the second side steps as Signal's does: `step(RK0, X25519(x(P_self), D1))` to read, a new secret of its own, and `step` again to send. So either side may speak first.

## Wire

A sealed item is `header (50) || ciphertext`, the ciphertext being XChaCha20-Poly1305 of the plaintext with its 16-byte tag, 66 bytes more than the plaintext in all.

| Bytes | Field |
|---|---|
| 1 | Version, `0x01` |
| 1 | Lane: `0x01` floor, `0x02` hold |
| 8 | `sid`, the session |
| 32 | The sender's current ratchet public key (X25519) |
| 4 | `pnHold`: how many held items the sender's previous sending chain used, big-endian (the floor needs no such count: its previous chain is dropped whole) |
| 4 | `n`: this message's number on its lane's current chain, big-endian |

Associated data: `"ghostly-ratchet/1" || lane byte || P_sender || P_recipient || header`, the participation keys as 32 raw bytes. A message sealed by one side cannot be opened as the other's, nor moved to the other lane or to another chat.

## Receiving

A receiver works on a copy of its state and keeps the copy only if the item opens and passes its path's own checks:

1. Read the header. A version other than 1, or a lane other than the path's, is refused.
2. Find the session by `sid`: the current one, one of the others ([Sessions](#sessions)), or none (a session the contact started: step 7).
3. A hold item: if a key was kept for (`sid`, ratchet key, `n`), open with it and drop the key.
4. If the ratchet key differs from the contact's one the session knows: check the bounds first (`n` and the hold keys to keep up to `pnHold`, [Bounds](#bounds)), then X25519 with this side's ratchet secret (or `x(P_self)` before its first step); a key that gives no secret (a low-order point) refuses the item. Keep the keys left of the contact's previous hold chain up to `pnHold`, step to read, pick a new secret, and step to send. The previous floor chain is dropped whole.
5. On the lane's chain, an `n` below the next expected, or past the bound, is refused (on the floor it was read or replaced; a held one was kept in step 3). Step forward to `n`; a hold lane keeps each key stepped over, a floor lane does not.
6. Open. If the tag fails, the copy is thrown away: nothing moved.
7. An unknown `sid`, not retired: start that session as this side's role would, then steps 4 to 6. On success, which session wins is said in [Sessions](#sessions).

## Bounds

| Bound | Value | Why |
|---|---|---|
| Floor messages a reader steps over at once | 4,096 | A mailbox shows only its newest envelope, and an envelope goes about every four minutes: eleven days without the turn passing |
| Held items a reader steps over at once | 512 | At most 64 items are held per contact at a time ([404](404-store-and-forward.md#lifecycle)) |
| Hold keys kept | 512 per chat, the oldest dropped first | |
| A kept key, and a session only received on | Dropped 8 days after last use | A held item lives seven days |
| Retired session ids | The last 16 | A reader does not try to open what its path refuses anyway ([Sessions](#sessions)) |
| Sessions only opened with | 2 | |
| A session that lost is followed after | 10 minutes with no floor envelope in the current one | Longer than a keep-alive's four minutes |

Floor keys stepped over are never kept: an envelope that was replaced unread is gone from the DHT, and a key kept for it would only help a thief who recorded it.

A sender never seals past a reader's bound: when its current chain on a lane reaches it (4,096 floor envelopes or 512 held items without the turn passing, as when the contact has been away for long), it starts a new session for its next item, and keeps the old one among its others ([Sessions](#sessions)). Otherwise a reader back after the bound would refuse every envelope, never step, and so never make the sender step either. What goes on the new session is on its first chains, protected by the participation keys alone until the turn passes ([Security](#security)).

## Sessions

A side holds per chat the **current** session, which it seals with, and at most two **others**, which it only opens with (past two, the one used least lately is retired).

- **Start.** With no current session, the first item sealed starts one with a random `sid`.
- **Order.** Each session keeps the highest floor sequence ([403](403-dht-text.md)) of an envelope of the contact's opened under it. That sequence is signed by the contact inside the envelope, and survives the contact's restores (a restored app's counters are raised past what it used, [06](06-devices.md#raised-counters)), so it orders the contact's sessions whatever the clocks say. Which session wins is decided once the envelope is opened and its sequence read.
- **Both start at once.** Each side opens the other's first item under a session it did not know. While no floor envelope of the contact's opened in this side's current session, the session whose `sid` is larger (as 8 unsigned bytes) wins on both sides; the one that lost is kept among the others to open what came under it, and never wins later.
- **The contact starts anew.** A floor envelope under an unknown `sid` whose sequence is higher than any the contact put out in this side's current session means the contact lost its state (a restore, a move to another device) or reached a bound. Its session becomes current, and the old one stays among the others, for what the contact sent before and is still on its way (held items).
- **From before both settled.** A floor envelope under an unknown `sid` whose sequence is not higher (an envelope still in the contact's mailbox, or a relay's older copy) is opened and kept among the others as a session that lost.
- **A contact that lost its state as both settled.** A session that lost becomes current when floor envelopes under it keep rising in sequence while the current session has opened no floor envelope for 10 minutes: two sessions that started at once settle within one keep-alive (about four minutes), so only a contact that restored in those seconds goes on speaking in a session that lost.
- **A late held item.** A held item under an unknown `sid` while a floor envelope of the contact's opened in the current session is opened, and its session forgotten: held items carry no floor sequence, and one can come days late.
- **Retired.** A session dropped (replaced, expired) has its `sid` retired, and an item under a retired `sid` is refused.

Replays are refused by the paths, not by the ratchet: a floor envelope must carry a newer sequence than the last taken ([403](403-dht-text.md)) and a held item a sequence not taken ([404](404-store-and-forward.md)) before its state is kept, so a replayed envelope never moves the ratchet or switches a session. The retired list (16 ids, lost with the state) only spares a reader opening what the path would refuse anyway.

## Saving state

- **One lock per chat.** Every change to a chat's ratchet state, on either lane, is made under one lock, held from reading the state to saving the next one. Two changes made from the same state, a seal and an open for instance, would save one over the other, roll the sending chain back, and seal the next item with a key and nonce already used.
- **Seal, save, send.** The state returned by sealing MUST be saved before the sealed bytes leave the device: a crash after sending and before saving would seal the next item with the same key and nonce.
- **Open, store, save.** An item is opened on the state as it is, with nothing saved, and its content stored with no lock held (storing may seal or open on the other lane). Then, under the lock, it is opened again on the state as it is by then, and that state saved; if it no longer opens (the same item taken meanwhile), nothing moves. A crash before the save opens the same item again.
- **Measuring.** Asking whether an item fits a packet MUST NOT use a key: the length is the plaintext's plus 66.

## The DHT floor

- **Record.** After the pin, a ratcheted envelope's sealed bytes go in a `_dr` record, base64, in place of `_dm`; the plaintext is the same `JSON([body, signature])`, padded as today. The `_dmk` hint is unchanged. A packet carries one of `_dm` or `_dr`, never both. First-contact envelopes, before the pin, stay `_dm` under the invite's key.
- **Room.** The seal is 26 bytes longer than today's (66 against nonce and tag, 40), so the padding target is 26 bytes lower, about 35 characters of base64. Every packet of a mailbox still has one size. A text near 256 bytes with many escaped characters may no longer fit; as today, the reply's id and the hop count go first, and a text that still does not fit is held or waits for the live session.
- **Reading the same envelope again.** A reader reads more often than the contact publishes, and a key once used is gone, so a reader remembers a digest of the last `_dr` it took and reads it as already taken, without opening it.
- **Every envelope is a message.** A keep-alive, a receipt or a mode change takes the next floor key like a text, so one look at a mailbox still does not tell them apart ([403](403-dht-text.md#what-a-mailbox-shows-revision-07)).

## Held items

- **Bundle.** A ratcheted item is `"GHLD" || 0x02 || sealed`, the plaintext being the version-1 bundle's own plaintext (`u32be(len(header)) || header || body`), with the same signed header. An app before this profile refuses version 2 as "from a newer Ghostly", and is never sent one.
- **What stays as today.** The manifest (a bundle of kind `manifest`, rewritten every time the sender re-signs its addresses) and the `_hold` pointer keep `sealKey`. They say which items are held, their sizes, sequences and read addresses, not what the items hold. A manifest of version 1 is always read.
- **Order.** The sender seals, saves the state, uploads, then rewrites the manifest: a retry after a crash seals the item again with a new key.
- **A contact that started anew.** Items the contact had not picked up were sealed in a session it no longer has. The sender SHOULD seal them again in the new session (same sequence and id) when it reads an item of that session, so they are not lost.

## Downgrade

Once a ratcheted item from the contact opened on a lane, that lane is `heard`, for good:

- the reader refuses a plain floor envelope (`_dm` after the pin) or a plain held item (a version-1 bundle other than the manifest) from the contact;
- the sender seals only with the ratchet, whatever the contact's record says later. A record that drops `ratchet/1` after that (an older app installed again) does not bring plain sealing back: floor texts and held items wait for the live session, which still carries everything, and the app says why.

Before a lane is heard, the contact's own signed record decides, as for any capability.

## Several devices, backups and restore

Ratchet state is state of one device. It MUST NOT be in a profile backup ([05](05-backups.md)), MUST NOT be derived from the seed, and MUST NOT travel in a handoff to another device ([06](06-devices.md)); an app restored from a backup or taking a profile over starts a new session with each contact on its first item.

Plainly: **what was sent over the DHT or held cannot be opened again from the seed**, by anyone, the owner included. What a restore brings back of a chat is the history the backup holds, already opened. Items held for this side before a restore and not picked up are lost unless the sender seals them again ([Held items](#held-items)). A floor text in flight is sent again by the outbox under its stable id, in the new session.

## Security

What it gives:

- **Forward secrecy per message** on both lanes, once the turn has passed both ways in a session: a floor envelope or held item, once opened and its key dropped, cannot be opened again with anything the device keeps, nor with a participation key stolen later.
- **Recovery after a compromise:** someone who copied a device's ratchet state and stays passive reads what comes until the turn passes twice; each step mixes a new X25519 secret they do not have.

What it does not give:

- **The first chains of a session.** The first side's first chain needs only the second side's participation key (and the invite secret, which both devices keep); the second side's chain from the root needs either participation key. Both last until the turn has passed both ways, which is exactly when the contact is away, and they come back with every new session (an upgrade, a restore, a bound reached). What goes on them has today's protection, no more. A signed X25519 prekey that rotates, in the capability record, would close this ([Open decisions](#open-decisions)).
- **A thief of a participation key now**, not later, can start a session of its own and impersonate that side, as it could before. The ratchet makes stolen keys useless for the past, not for the future.
- **Kept keys.** Hold keys kept for items not opened yet open those items, if stolen with the device.
- **Metadata.** Headers are not encrypted: a reader of the mailbox learns the session id, when the turn passed (the ratchet key changes) and roughly how many envelopes went (`n`). The mailbox's other leaks are those of [403](403-dht-text.md#what-a-mailbox-shows-revision-07). Messages at rest on the device are as protected as the device's storage (S18).
- **Groups** (mesh and community) keep their own epochs ([900](900-group-sessions.md)).

Implementation notes: the tag is checked in constant time (`@noble/ciphers`); nothing branches on a secret before it is checked. Every bound is checked before any X25519 or chain step, so an item that does not open costs a few X25519 operations (more under an unknown `sid`, which starts a session to try) and at most the chain steps of the bounds above.

## Tech Info

A chat's Tech Info SHOULD show one row, **Forward secrecy**: *On* once the turn has passed both ways in the session this side seals with (it stepped on a ratchet key of the contact's with a ratchet secret of its own); *Off* otherwise, with the reason behind its ⓘ: the contact's app does not support it yet (its record lacks `ratchet/1`), or it starts once both sides have written. A live connection is forward secret either way, which the ⓘ says.

## Test vectors

From `packages/core/test/ratchet.test.ts`, every byte in hex. The participation seeds are 32 bytes of `0x01` and of `0x02`; the rendezvous seeds 32 bytes of `0x03` and `0x04`; the invite secret 32 bytes of `0x05`. Random bytes come from SHA-256 of `"<side>:<i>"` (`i` counting from 0 per side), cut to the length asked: the first side's session id is the first 8 bytes of SHA-256(`"first:0"`), its first ratchet secret SHA-256(`"first:1"`); the second side's first secret SHA-256(`"second:0"`).

| Name | Value |
|---|---|
| First side's participation key | `orhzqdiexwmi6iidktucgud63ufa5nwtsuzdxe176a8izd6jsqky` |
| Second side's participation key | `tkrq8zmwb8a3m9k15csu3q17qmfgqnp9dskbrg9uq1rydpyxp7qy` |
| Rendezvous keys | `7ir1ttte48bcp4zjychjyscicrwi1j34mtt91ptsafdbjmr8g9eo`, `3kj4afafdba8diu5oxd96dz6orrqt5nfgbmi473go6ju8s64z36y` |
| `RK0` for `sid = abd1938e708c91f3` | `f410f63e47a1197cfa2f4ae0961b25a79fdf5d38c60b2bff7aad2b898d0708e3` |
| First to second, floor, `"hello"` | `0101abd1938e708c91f3ade5ec0474e27723700d837ac3ac14d08ca0cd1d6dc9d98cc6fe6a610069367e00000000000000007fb640351c34e105b2989b58044fd25f1dfbba9988` |
| Second to first, floor, `"hi"` | `0101abd1938e708c91f33d63ca075dcd63457fb9512a7df8c00c0f16f8fd65aadc011211dcbfd31e251f00000000000000009927adc92e1f54d7484543e9210d6e7e896f` |
| First to second, hold, `"held"` (after one step each) | `0102abd1938e708c91f3fe4fb690c33193e0a541b8854cdbd57820511be7a331ea87f1f663328852a54400000000000000004f6a11c22fbbb97156cfa23385a933089064b4bb` |

## Conformance

Unit: the vectors; both sides speaking first; on only once the turn passed both ways, and a first chain opened from a participation key alone (the limit said above); a key used once (an item opened twice is refused); a changed header, ciphertext or tag, a reflected item, the wrong lane and a low-order ratchet key refused, without throwing; the floor stepping over replaced envelopes and never back, and a number past its bound refused before any step; a sender reaching a bound starting a new session the contact reads; held items in any order, from a chain the contact left, each once; every bound on kept keys; both sides starting at once settling on one session, with late held items of the losing one; a side that lost its state starting anew, and a replayed retired session refused. Engine: one lock per chat over both lanes; an older contact keeps plain envelopes and bundles; a lane heard refuses plain items; a re-read envelope is not opened twice; state saved before a publish or upload; measuring a packet takes no key. End to end: two apps upgrade; an app without it falls back; held items opened out of order.

## Open decisions

- Encrypting the header (Signal's header encryption) would hide the session and the turn from a mailbox reader, at 40 more bytes of the floor's packet.
- Ratcheting the manifest and pointer as well: each rewrite would take a key, and a reader that misses some would step over them like floor envelopes.
- Whether a chat should refuse to send plain once both apps can, even before the first item came back (today the contact's own record decides).
- A signed X25519 prekey in the capability record, rotated and its old secrets deleted after eight days, that each session would start against in the manner of X3DH, so the first chains no longer open with a participation key alone.

## Revision log

One file per change in [changes/4xx-ratchet/](changes/4xx-ratchet/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
