# WISP 8xx: Contact Links

| Field | Value |
|---|---|
| Number assignment | 8xx; planned, number to be defined |
| Status | Draft |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [01](01-ghost-core.md), [02](02-peer-keys.md), [06](06-devices.md), [800](800-invite-join.md), [801](801-invitation-profiles.md), [403](403-dht-text.md) |
| Implementation | Not built; planned for 1.4 in the web app, the extension, Desktop and the CLI |
| Summary | One link a person can post anywhere, naming nobody: whoever opens it sends a request, and a chat starts only when the owner accepts it. |
| Availability | Planned |
| Notes | One link per profile at a time. Requests wait on the DHT while the owner is away, for as long as the requester's app keeps them up, at most seven days. |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Purpose

An invite of [801](801-invitation-profiles.md) is for one person: whoever opens it first is the contact. The only link many people can open is a community group's ([903](903-group-community.md)), where everyone sees each other. A person who wants strangers to be able to reach them, from a website, a profile page or a business card, without putting their name or any key of theirs there, had nothing.

A **contact link** is that link. It names no person: no profile name, no participation key, no DID, nothing that ties it to the owner's chats or other links. Anyone may open it, many times. Opening it sends the owner a **request**: a short first message and the requester's name. The owner sees requests apart from chats and accepts one (an ordinary chat of [400](400-chat.md) starts) or declines it (nothing is said back). Nothing reaches the owner's chat list before an accept, and the requester learns nothing about the owner before it.

[800](800-invite-join.md) leaves public ingress open: "do not turn the DHT into an unbounded shared inbox", and "public invites need a deliberate abuse policy". This document is both, for 1:1 contact.

## Options weighed

Where does a request wait while the owner is away, and who pays for it?

| | Where a request waits | Bound on the owner | Works for | Weakness |
|---|---|---|---|---|
| **(a) Under the requester's own Pkarr key, rung in through a few shared knock slots** (chosen) | The requester's own record, republished by its app | A fixed number of reads per poll, a cap per hour and a cap on what waits | Everyone; no setup | Anyone holding the link can overwrite the knock slots; a requester whose knock is wiped knocks again |
| (b) The owner online only, as a group entry link ([902](902-group-mesh.md#entry-link-group-entry1)) | Nowhere: the owner's app answers live | The owner's sessions | Owners whose app is open | A request to an owner who is away is lost; the requester has to try again |
| (c) The owner's own S3 storage, slots handed out as presigned writes ([404](404-store-and-forward.md)) | The owner's bucket | The owner pays the storage | Owners with storage set up | Most people have none; a presigned write is per object, so the slots still run out and still need a door |
| (d) A server that takes requests (a sidecar) | The server | The server's operator | Everyone | A service to run, trust and pay for; it sees who asks whom |

(a) needs nothing from either side, and what the owner spends does not grow with the number of people who hold the link: a request lives under a key only its requester can sign for, so nobody can overwrite it, and the owner learns where to look through a small, bounded set of shared records. The shared records can be wiped by anyone with the link, which is the same nuisance [902](902-group-mesh.md#entry-link-group-entry1) accepts for its knocks: it delays a request, it never lets anyone in. (b) fails the person who posted the link and then went to sleep. (c) and (d) can be added later as other ingresses behind the same link record; nothing below rules them out.

## The link

A contact link is a `ghostly1…` code of [801](801-invitation-profiles.md#exact-layout) with **version 3**, so every version-3 code starts `ghostly1r` (version 2 is a device's code, [06](06-devices.md)):

| Part | Value |
|---|---|
| Human-readable part, separator | `ghostly`, `1` |
| First data symbol | `r` (version 3) |
| Payload | **32 bytes**: the link key, an Ed25519 public key made for this link and for nothing else |
| Checksum | Six symbols, bech32m |

Version 3 has exactly one payload length; any other is damaged, as for version 1. A code is **67 characters**, under bech32's own 90, and its link form is `https://ghostly.tools/#ghostly1r…`, read and kept out of logs and referrers exactly as an invite's ([801](801-invitation-profiles.md#exact-layout)). In capitals it fits a QR code's alphanumeric mode.

An app from before this document reads version 3 as "This invite was made by a newer Ghostly. Update to join." ([801](801-invitation-profiles.md#reading-an-invite); the reader in `invite.ts` answers so for every version above 2) and stores nothing, which is right. An app that implements this document reads version 3 as a contact link and never as an invite or a device's code: rule 2 of 801's table gains the rows "Version 2: a device's code (06)" and "Version 3, a 32-byte payload: a contact link (8xx)", and versions 4 to 31 keep the "Update" answer. The link key's seed stays on the owner's device; nothing in the link lets anyone sign for it.

**A link opened in the app** is not an act of the person's, as for an invite (801): the app shows the request form with the field empty and sends nothing until the person taps Send. A link the app knows as its own profile's says "This is your contact link" and offers nothing else.

## Keys

For a link key *L* (32 bytes) and a requester's **asker key** *K*:

- `derive(label) = HKDF-SHA256(ikm = L, salt = utf8("ghostly-contact/1"), info = utf8(label), 32)`.
- The **knock slots**: four Pkarr identities, slot *i* (0 to 3) = `identityFromSeed(derive("knock seed " + i))`; the knock seal key = `derive("knock key")`. Every holder of the link derives all of them.
- The **asker key** *K* is an Ed25519 key the requester's app makes the first time this profile opens this link, and keeps for as long as it keeps the link: one per profile and link, never reused for another link, never its participation key or any key of another chat. The owner tells requesters apart by it, so a declined requester cannot come back through the same link by asking again (a new profile can; see [Abuse](#abuse)).
- The **request seal key**: `HKDF-SHA256(ikm = X25519(K, L), salt = utf8("ghostly-contact/1 request"), info = L || K, 32)`, the Ed25519 keys taken to X25519 as in [403](403-dht-text.md). Only the requester and the owner can derive it, and only the holder of *K* can seal under it in a way the owner reads as *K*'s.

## Records

All three are ordinary Pkarr packets ([01](01-ghost-core.md)), at most 1,000 bytes, TTL 300 s, signed by the key they live under.

### The link record (under *L*, the owner's)

One TXT record `_cl` holding the JSON array `[1, state, bits, seen]`, not sealed: everyone with the link may read it, and it says nothing about the owner.

- `state`: `"open"`, `"busy"` (the owner takes no new request now) or `"off"` (the link was turned off, for good).
- `bits`: the stamp's difficulty this link asks for, 16 to 24 ([Stamp](#stamp)).
- `seen`: at most 32 entries, each the first 9 bytes of `SHA-256(utf8("ghostly-contact/1 seen") || L || K)` in base64url (12 characters), for the requests the owner's app took in the last seven days, newest first. A requester that finds its own entry knows its request arrived and stops knocking. A request declined stays listed like any other: `seen` says "arrived", never what the owner did with it.

The owner's app publishes it when the link is made, at every change, and every hour while the app runs. With no link record (an owner away for hours: the DHT forgets) a requester knocks all the same, at the default difficulty; its request waits for the owner.

### A knock slot (under slot *i*, everyone's)

One TXT record `_knock`: `base64url(nonce(24) || XChaCha20-Poly1305(knock key, nonce, JSON(knocks), aad = L))`. `knocks` is at most **6** entries `[K, day, stamp]`: the asker key in z-base-32, the UTC day number (`floor(unix ms / 86,400,000)`) the stamp was made for, and the stamp. Six full entries make a packet of 733 bytes; the link record with 32 `seen` entries, 577. A requester knocks in slot `SHA-256(L || K)[0] mod 4`, so the 24 places are spread over four keys and a writer has to wipe all four to wipe them all.

### The request (under *K*, the requester's)

One TXT record `_req`: `base64url(nonce(24) || XChaCha20-Poly1305(request seal key, nonce, plaintext, aad = utf8("ghostly-contact/1 request")))`, where `plaintext = JSON([1, invite, name, text, issued, expires])` followed by spaces up to the largest length whose packet fits 992 bytes, so every request is the same size whatever it says ([403](403-dht-text.md#what-a-mailbox-shows-revision-07)).

- `invite`: a version-1 `ghostly1p…` code of [801](801-invitation-profiles.md#exact-layout), made by the requester's app for this request alone. Accepting is joining it.
- `name`: the requester's name, at most 48 UTF-16 units, not blank. It is what the owner sees until the chat starts; the photo and anything else come with the chat.
- `text`: the first message, 1 to 200 UTF-8 bytes. The requester's app measures the whole packet before sending and says "Shorten the message" when it does not fit; nothing is cut. (Measured with the core's packet encoder: the plaintext may reach 640 bytes; the array without name and text takes 260, so a 48-unit name of three-byte characters and a 200-byte text fit with 36 bytes to spare for JSON escapes.)
- `issued`, `expires`: milliseconds; `expires` at most seven days after `issued`.

An owner's app refuses a request whole when it does not open, the packet is not signed by *K*, the JSON does not hold, the invite does not read as version 1 or names a key the owner already knows as one of its own, the name or text breaks a bound, or `expires` is past.

## Stamp

A stamp is a whole number from 0 to 2<sup>32</sup> − 1 such that `SHA-256(utf8("ghostly-contact/1 stamp") || L || K || u32be(day) || u32be(stamp))` starts with at least `bits` zero bits. It costs the requester about 2<sup>bits</sup> hashes once per day and link, and the owner one hash to check: at the default 18 bits, well under a second on a laptop and about a second on a slow phone. An owner's app takes a stamp for today or yesterday by its own clock (two clocks around midnight disagree), and with at least the `bits` its link record says now; a requester whose stamp falls short of a raised `bits` makes a new one.

The stamp does not stop a determined flood: a machine makes a few thousand a day. What it does is make the owner's fixed hourly reads ([Limits](#limits)) cost a flooder work for each one, and keep a crude script from filling the slots for free. An owner under a flood raises `bits` (the app does it by itself, see below); 24 bits is about a minute on a slow phone, and the most a link asks.

## Lifecycle

**Making a link.** The owner's app makes a fresh link key, stores its seed in the profile, publishes the link record (`open`, 18 bits, `seen` empty) and shows the link and its QR. One link per profile at a time: making a new one turns the old one off.

**Turning it off.** The app publishes `off` under the old key, keeps its seed only to republish `off` once a day while the app runs for 30 days, and reads its slots no more. A requester that finds `off` says "This contact link was turned off." and stops. After the 30 days the record fades; a requester then knocks into slots nobody reads, which costs only itself.

**Asking.** The requester's app:

1. Reads the link record. `off`: stop, as above. `busy`: "They are not taking requests right now. Try again later.", and nothing is sent; the app looks again in an hour while the request form is kept.
2. Makes its asker key if it has none for this link, its invite (as for any invite, [801](801-invitation-profiles.md)), and a stamp at the record's `bits` (18 with no record).
3. Publishes its request under *K*, and republishes it every hour while the app runs, until it is seen or expires.
4. Knocks: reads its slot, keeps the other entries made today or yesterday (at most five, the newest), adds its own, publishes, and reads the slot back a second later (twice at most; a relay may still answer with the record from before). Then it reads its slot and the link record every 30 s for ten minutes and every ten minutes after, knocking again whenever its entry is gone, until its `seen` entry shows in the link record.
5. Seen: it stops knocking and republishing. Its own chat list shows the request as a chat waiting for an answer, under the name the requester gave the link (by default "Contact link"), with the text it sent. Its invite waits like any invite nobody joined yet ([403](403-dht-text.md#first-contact)).
6. Seven days after `issued` with no answer, the request ends: "No answer". The invite is dropped, and the asker key is kept, so asking again goes to the same place in the owner's list.

**Taking requests.** The owner's app reads the four slots every 60 s while the app is in front, every five minutes in the background, and every 15 s for ten minutes after the link was shown or copied. For each entry with a good stamp whose asker key is not already waiting, accepted or declined, within the [limits](#limits), it reads that key's `_req` once, checks it, stores it in **Requests** and adds its `seen` entry. A key whose `_req` was missing or refused is read again at most once an hour.

**Accept.** The app joins the request's invite exactly as if it had been pasted in Join ([801](801-invitation-profiles.md)): first contact on the DHT and a stream in parallel ([403](403-dht-text.md#first-contact)). The chat appears in the chat list with the requester's name and first message, and from there it is an ordinary chat. The requester's waiting chat becomes the same chat when the owner's first envelope arrives. The owner is identified to the requester only now, by what any chat shows.

**Decline.** The app deletes the request's name and text, keeps the asker key as declined for this link, and says nothing: no envelope, no record, no change in `seen`. Later knocks from that key are skipped without a read. Block does the same in 1.4. A request whose `expires` passed while it waited is dropped the same way, and its Accept is greyed meanwhile ("This request expired").

## Limits

| Bound | Value | Past it |
|---|---|---|
| Requests waiting in Requests | 32 | The link record goes `busy`; new knocks are counted, not read |
| New requests taken per hour | 12 | The rest stay in the slots and are taken in a later hour, if their askers keep them there |
| Reads of one asker key's `_req` | Once per hour | Skipped |
| Knock slots read per poll | 4 | Never more, whatever the slots hold |
| Entries per slot | 6, made today or yesterday | Oldest dropped by the next writer |
| Request lifetime | 7 days | "No answer" for the requester, dropped for the owner |
| Name, text | 48 UTF-16 units, 200 UTF-8 bytes | Refused before sending |
| Stamp difficulty | 16 to 24 bits, 18 by default | — |

An owner's app goes `busy` by itself at 32 waiting and back to `open` below 24. It raises `bits` by 2 (up to 24) for a day when a day brought more than 60 knocks with good stamps that it could not take, and steps back by 2 a day after. The owner sees how many people tried while the link was busy ("12 more tried to reach you"), never their names or texts, which were never read.

What an owner spends is bounded whatever happens: four slot reads per poll, at most 12 request reads an hour plus one retry per pending key an hour, and one link record an hour. This fits inside the relay budget of [403](403-dht-text.md#poll-pace) beside the owner's chats.

## Abuse

- **A flood of requests.** Bounded on the owner's side by the table above, paid for with stamps on the requester's. What the owner sees is a count, not the flood.
- **Wiping the slots.** Anyone with the link can overwrite a slot, as with [902](902-group-mesh.md#entry-link-group-entry1)'s knocks. A wiped knock is written again by its requester's app; the request itself, under *K*, cannot be touched. A sustained wipe of all four slots delays requests while it lasts; it never admits anyone or reveals anything.
- **Asking again after a decline.** Skipped for the same asker key, for as long as the link lives. A requester who makes a new profile gets a new asker key and is a new requester: a link anyone can open cannot tell people apart beyond the key they bring. The owner's way out is a new link.
- **Someone else's request.** A request is under *K* and sealed with a key only *K*'s holder and the owner derive, so no one can put words in another requester's request. The name is what the requester typed, unverified, and the Requests screen says so.
- **Tying the link to the owner.** The link key appears in no other record of the owner's; the link record and the slots hold no name, key or address of the owner's. Relays see the IP address of whoever publishes and reads, as for every Pkarr record.
- **What a requester learns.** `open`, `busy` or `off`, and whether its own request arrived. Nothing about the owner, and nothing about other requesters beyond the asker keys in its slot (which name nobody).
- **What the owner learns before accepting.** The name and text the requester chose, and an asker key that ties to nothing else. Accepting reveals both sides to each other as any chat does.

## Devices and backups

The link key's seed is part of the profile: profile backups ([05](05-backups.md)) carry it and its declined keys. In 1.4 only the device that made the link reads its slots and takes requests; another device of the same profile ([06](06-devices.md)) shows the link but not its requests. Moving that role between devices is an open decision.

## Compatibility

Additive. An app from before refuses the link with "Update to join" and creates nothing; its chats are untouched, and a chat started by an accept is an ordinary chat that any app of revision 0.2 of [400](400-chat.md) carries. No capability is negotiated: the requester's invite is version 1, which every current app joins. The `ghostly.tools` page reads version 3 and hands it to the app as it does an invite, with "Opening the request" in place of "Opening the chat".

## Conformance

Unit: the codec both ways with a vector, each refusal (wrong length, non-zero padding, version 3 read by a reader from before as "Update"), the stamp at and below `bits` and for today, yesterday and two days ago, the knock merge (others kept, stale dropped, six at most, own entry last), the request seal (opens only with the right *K* and *L*, packet at most 992 bytes, every refusal), the link record (`seen` entry, `busy`, `off`), and the limits (the 13th request in an hour waits, the 33rd goes `busy`, a declined key is not read again). End to end: open the link, send a request, accept, and the chat carries text both ways; open, send, decline, and the requester sees "Delivered" and nothing else for seven days; the owner offline while a request is sent, then back, and the request is there; the link turned off, then opened, says so.

**Test vector** (a codec vector only: the bytes `00 01 … 1f` in place of a key, as in 801's). Version 3, 67 characters:

```text
ghostly1rqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s0her5u
```

## Open decisions

- Several links per profile, a link that ends on a date, a link per group: out of 1.4.
- A request's richer card (a photo, the requester's DID of [310](310-did-dht.md) when it chooses to show it) does not fit the packet with the invite; it could go in a second record under *K*.
- Taking requests on more than one device of a profile.
- A storage or sidecar ingress ((c) and (d) above) behind the same link record, for owners who want requests to wait longer than their requesters' apps keep them up.
- The number.

## References

[Invite encoding](../../packages/core/src/invite.ts), [group entry knocks](../../packages/core/src/groupEntry.ts), [DHT delivery](../DHT-DELIVERY.md).

## Revision log

One file per change in [changes/8xx-contact-links/](changes/8xx-contact-links/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
