# WISP 503: Group Files

| Field | Value |
|---|---|
| Candidate number | 503; editorial family allocation (500-599, Files) |
| Status | Draft |
| Document kind | Profile |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [500](500-files.md), [501](501-paired-files.md), [900](900-group-sessions.md), [902](902-group-mesh.md), [903](903-group-community.md) |
| Implementation | Not built. This revision is the design that the engine, CLI, UI and e2e increments of release 1.2 implement, one pull request each |
| Summary | Send a file or a voice message to a group: everyone sees it at once, and each member's app fetches the bytes from whoever has them. |
| Availability | Planned |
| Notes | Not in the app yet. Private groups and communities alike; a file of up to 100 MiB, a voice message up to 15 minutes. Apps from before show a line saying a file was sent and that it needs an update. |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Purpose

A group carries text, edits, reactions, pins and payment notes ([902](902-group-mesh.md), [903](903-group-community.md)); until this profile it refused files ("Groups take no files yet"). [500](500-files.md) already says how a group file must travel: not as file chunks flooded through the group, but as **bounded, authenticated metadata over the group's channel**, with the bytes **negotiated pairwise with willing peers**, never on the DHT. This profile makes that concrete with what already ships:

1. **The announcement is a group message.** The author sends a `group-msg` whose sealed body describes the file: name, type, size, SHA-256, and the voice, video or picture description of [501](501-paired-files.md). It has an id, a place in the history, replies, reactions, edits of its caption, catch-up and hubs exactly as a text has, and its author's signature binds the digest.
2. **The bytes go pairwise, over `files/3`.** A member that wants the file asks a member that holds it, and that member sends it over a paired session between the two of them with the frames and rules of [501 § files/3](501-paired-files.md#files3-files-of-any-size-revision-03): resume, backpressure, integrity, storage as it arrives. The receiver checks what it stored against the **author's** digest, not the sender's word.
3. **Anyone who holds it may serve it.** The author is the first holder; every member that stored the file becomes one and says so. A member that was away gets the file from whoever is there, as it gets the messages it missed (902 § Catch-up).

So the cost of a file is paid by whoever wants it, from whoever has it: an author's app sends a 20 MiB video once or twice, not once per member, and nobody's app downloads what its person never opens past the automatic limits below.

## The announcement

### Private groups (902)

The file is described in a sealed box of its own beside the text, as a status card is (902 § Status cards):

```
{ "t": "group-msg", …, "sig", "m"?, "r"?, "f"?, "sc"?, "fl"?: { "n": <nonce>, "c": <box> }, "o"?, "xs" }
```

The box holds the description as JSON, sealed with XChaCha20-Poly1305 under the message's epoch key, with a nonce of its own and `["ghostly-group/1 file", g, e, s, n, ts]` as associated data:

```
{ "name", "mime", "size", "d": <SHA-256 of the file, base64url>, "voice"?, "video"?, "image"? }
```

`fl` is outside `sig`, which older apps check as before, and inside `xs`, after `sc` and before `o`, only when present: `[…, "sc", sc.n, sc.c, "fl", fl.n, fl.c, "o"?…]`. A member handing the frame on keeps the box only with the author's `xs`, as the other boxes; a copy handed on without it is provisional (902 § Catch-up) and shows the text until a whole copy completes it. A file is announced only with `xs`.

The text is the fallback older apps show: the caption when there is one, otherwise a line made by the author's app ("📎 report.pdf (2.4 MB): update Ghostly to get files in groups", "🎤 Voice message (0:42): update Ghostly to hear it"), at most 16 KiB like any text. An app of this profile shows the caption, or nothing, under the file.

### Communities (903)

The ciphertext of a community `group-msg` opens to `{ "text", "fl", "nick"? }`: the same description as a field beside the text, sealed and signed with the frame as everything in it is. Apps from before read `text` and ignore `fl` (they ignore unknown fields of the payload, as they do mentions and replies), so the fallback line shows; hubs relay it unchanged.

### Rules for both

- **What is checked.** `name` is a display suggestion of 1 to 255 characters after the cleaning of [501](501-paired-files.md) (never a path); `mime` is untrusted and at most 255 characters; `size` a whole number from 1 to 100 MiB (104,857,600 bytes); `d` 43 base64url characters. `voice`, `video` and `image` are read exactly as in 501: a malformed one is dropped and the file shown as a file. A box that does not open, or a description that does not hold, is no file: the text shows.
- **Edits.** An edit changes the caption only (902 § Edits, 903 § Edits); the file is the one the first frame announced, and an edit body carrying `fl` is dropped.
- **Forwards.** A file forwarded into a group (400 § Forwards) is a new announcement by the forwarder, with the forwarder's own copy as its first holder and `f` as for a forwarded text. A file forwarded out of a group is a new 1:1 file (501) from the bytes on the forwarder's device; a file not downloaded yet is not offered for forwarding.
- **Frames said again** (902 § Catch-up, 2026-10-04) carry `fl` sealed again for the new header; the file and its digest stay the first frame's.
- **Pace.** A member's app sends at most 8 file announcements a minute per group. A receiver takes at most 30 announcements from one member in 10 minutes per group; past that it shows them as the fallback text, unfetched.

## Getting the bytes

### Who holds what

A member that stored a file, the digest checked, is a **holder** of it until it deletes it. It says so to the group, so others know whom to ask:

- **Private groups:** `{ "t": "group-have", "g", "ids": [<message id>, …] }` on each of its edges that is up, with at most 32 ids, when it stored something new (batched, at most every 10 seconds) and to an edge that just opened (its 32 newest). It is believed from the member the edge is pinned to, only while that member is in the roster; a hub does not pass it on.
- **Communities:** an application frame, `{ "x": { "t": "group-have", "ids": [ … ] } }`, sent to everyone like a reaction, at most every 60 seconds per member, 32 ids per frame. Its signer is the holder.

Each member remembers, per file, up to 8 holders it was told of, newest first; the author is always one while it is in the roster. A holder that is no longer in the roster is forgotten.

### Asking

A member that wants a file sends, to one holder at a time:

```
{ "t": "group-want", "g", "id": <message id> }
```

over a **file session** with that holder (below). The holder answers with a `pf-offer` for the file (501), whose `id` is its own transfer id and which carries `gm: <message id>`, and the transfer runs as any `files/3` transfer: the asker accepts from the offset it stored, the holder sends, the asker checks the SHA-256 of what it stored against the announcement's `d` and answers `pf-done`, or refuses with `damaged` and asks another holder. A holder that cannot serve now answers `{ "t": "group-want-no", "g", "id", "why": "gone" | "busy" | "refused" }`: `gone` (it deleted the file), `busy` (it serves enough already; ask again in a minute or ask someone else), `refused` (the asker could not read that message: below).

A holder serves only a member that could read the announcement: in the roster now, and a member of the message's epoch (a member let in later never saw the message and cannot name it). Anything else is `refused`. A `pf-offer` with `gm` that answers no `group-want` of the receiver's is refused with `invalid`, so no member can push a file into another's storage.

Who is asked first: the author while its edge or session is up, then holders whose edge is up, then holders whose app is likely online (hubs, members heard in the last minute), then any holder. A member asks one holder at a time per file, and moves to the next after `group-want-no`, a refused transfer, or 30 seconds without an offer.

### The file session

- **Private groups, full mesh (up to 16 members):** the edge between the two members, which is up anyway, carries `files/3` (above) as a 1:1 chat's session does.
- **Private groups on hubs, and communities:** two members rarely keep an edge between them. The file goes over that pair's edge, opened for the transfer: its rendezvous identities and key derive from the two member keys and the group id exactly as a mesh edge's do (902 § Keys and epochs; a community derives it the same way from its id), pinned in advance to the two member keys, so nothing new is trusted. It opens when a want is to go to a holder the member has no edge with, carries only the file frames of this profile (and the session's own), and closes 60 seconds after its last transfer ends. A member keeps at most two such sessions opening at once, and at most four open, all groups together; they count toward the app's budget of connections and native listeners (902 § Hubs, Budget; § Transports). Hubs do not carry file bytes: a 50 MiB file relayed by a hub to forty members would cost the hub 2 GB.

The frames of [501 § files/3](501-paired-files.md#frames) are unchanged on a file session; `pf-offer` gains `gm`, the group message it serves, which a 1:1 chat never carries. `pf-room` says the asker's space as in a chat.

### Automatic and asked downloads

- **Voice messages** (a file with `voice`) are fetched as soon as they are announced, up to 15 minutes of audio, so they play at a tap, as in a chat.
- **Other files** of at most **8 MiB** are fetched by themselves while what this device took that way from the group (and still keeps) stays within **256 MiB**. Larger ones, or past that total, show their name, size, picture size or video poster and a **Download**; the person decides, and the device's free space is checked first. A device may turn automatic downloads of a group off, or lower the limit; nothing about that is sent.
- A file the person deletes on its device is no longer served from there (`gone` to the next asker) and can be downloaded again while some holder keeps it.

### Serving limits

A holder serves at most **3 transfers at once**, all groups together, and at most one per asking member; more are `busy`. It serves at most **1 GiB a day** of group files to others (its person can raise it, or turn serving off: then it answers `busy` and is no holder in its `group-have`). The author always serves its own files, within the same limits, so an announcement never depends on someone else being generous.

## What apps from before see

- **A private group:** an app that did not announce version 6 in `paired-groups` drops `fl` (it is outside `sig`, and it ignores fields it does not know), so it shows the fallback text: "📎 report.pdf (2.4 MB): update Ghostly to get files in groups". It never receives `group-have` or `group-want` (they flow only where both sides announced 6), and never offers to serve. When it hands the frame on in a catch-up it keeps only the fields of a message frame it knows (902 § Catch-up), so the copy arrives without `fl`, its `xs` no longer verifies, and a member on a new app takes it as provisional: the fallback text shows until a whole copy (from the author, or from a member on a new app) brings the file.
- **A community:** an app from before reads `text` and ignores `fl`, and relays the frame unchanged as a hub. An `x` frame `group-have` is one it drops.
- **The CLI:** `ghostly file send <group> <path> [--voice]` announces and serves; incoming group files land in the daemon's files folder as 1:1 files do, under the same automatic limits.

Version 6 of `paired-groups` says an app takes group files: it announces files, answers wants and takes `group-have`. An app sends `fl` to any group; the fallback is what makes that safe.

## Bounds

100 MiB per file; 16 KiB of caption or fallback text; 8 announcements a minute per group sent, 30 per member per 10 minutes taken; voice up to 15 minutes; automatic downloads up to 8 MiB per file and 256 MiB per group kept; 8 holders remembered per file; `group-have` of 32 ids, at most every 10 seconds on an edge (private) or every 60 seconds (community); one want at a time per file, moved on after 30 seconds; 3 transfers served at once, one per asker, 1 GiB a day; two file sessions opening and four open at once, closed 60 seconds after their last transfer. The `files/3` bounds of 501 (1 MiB unconfirmed, 3 incoming at once per member, the 30-second resume) apply on each file session.

## Security and privacy

- **Integrity is the author's.** The digest is inside the author's signature (`xs` in a private group, the frame's own signature in a community), so a holder can withhold a file but never serve another one: the receiver checks what it stored, read back, against `d`, and deletes a mismatch.
- **Who can fetch is who could read.** A holder serves only members of the announcement's epoch still in the roster. A removed member cannot ask (no file session derives for someone out of the roster, and a holder refuses it); a member let in later never sees the announcement. Bytes already downloaded stay with whoever has them: removal changes keys, not the past (902 § Security and privacy).
- **What travels where.** Bytes go only over paired sessions between two members (WebRTC, Iroh or HyperDHT; 100), encrypted by the session, never through hubs and never on the DHT. A file session's rendezvous records are an edge's: relays see Pkarr keys and signaling, not the group id or the members.
- **What members learn.** Every member sees the announcement (name, type, size); holders learn who asked them for which file and when; a `group-have` tells the group which members keep which files. A community's `group-have` reaches every member.
- **Storage abuse.** No file is written without a want of the receiver's own; automatic downloads are bounded per file and per group; MIME labels are untrusted, names are never paths, nothing is executed (500).
- **Denial of service.** A member can announce files it then never serves; the rate limits bound the noise, and the person sees "Nobody has this file right now". A holder can stall a transfer; the asker moves on after 30 seconds.

## Open decisions

A member deleting a file for everyone (an author's "unsend" that holders honour); files larger than 100 MiB in groups; several holders serving ranges of one file at once (multi-source); a hub that keeps files for members who are away longer than any holder stays online (a negotiated store, 404); thumbnails generated by the receiver before the bytes arrive for pictures without `image`; private groups past 16 members sharing one file session among several wants.

## Conformance

To be written with the implementation: a file and a voice message reaching every member of a group of three (web and CLI), with the author's app closed once a second member holds it; a member away during the announcement getting it later from a member who is not the author; a holder serving a damaged file and the receiver refusing it and fetching from another; a removed member refused, and a member let in later never seeing it; an app without version 6 showing the fallback text; automatic limits and the asked download; serving limits (`busy`).

## References

[Files contract](500-files.md), [chat files](501-paired-files.md), [group contract](900-group-sessions.md), [group mesh](902-group-mesh.md), [group community](903-group-community.md), [store-and-forward](404-store-and-forward.md).

## Revision log

One file per change in [changes/503-group-files/](changes/503-group-files/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
