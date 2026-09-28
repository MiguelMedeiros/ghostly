# WISP 501: Chat Files

| Field | Value |
|---|---|
| Candidate number | 501; editorial family allocation |
| Status | Draft |
| Revision | 0.4.3 |
| Updated | 2026-09-27 |
| Document kind | Profile |
| Dependencies | [500](500-files.md) |
| Implementation | Every chat session: `files/3` (any size, consent, resume) and `files/2` for older apps; WebRTC and supported native adapters |
| Summary | How files travel in every chat: negotiated, chunk by chunk, with integrity checks. |
| Availability | Available |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Place in the one chat (revision 0.2)

Formerly "Paired Files". This is how files travel in every chat of [400](400-chat.md) while it is `live`. The wire (`files/2`, `pf-*` frames) is unchanged. While the chat is `on-dht` or `dht-chosen`, files are held ([4xx](4xx-store-and-forward.md)) or wait in the outbox for layer 1 ([500](500-files.md#files-in-the-one-chat-revision-02)); a `files/2` transfer cut by a drop to the DHT fails and is retried whole when layer 1 is back, under its original ID; a `files/3` transfer resumes from what was stored (below).

## files/3: files of any size (revision 0.3)

`files/3` is a session capability ([03](03-capabilities.md)): each side lists it in its `paired-capabilities` frame, and it is on while both do. Without it, `files/2` below applies unchanged, with its 100 MiB limit; an app that speaks both uses `files/3` with a contact that lists it and `files/2` with one that does not.

### Frames

All are JSON on the authenticated session, at most one 16 KiB chunk each. `id` is the sender's (`[A-Za-z0-9_-]{8,64}`); a receiver stores the file under an id of its own.

| Frame | From | Meaning |
|---|---|---|
| `pf-offer {id, name, mime, size, ts, voice?, video?, r?, fw?, paused?}` | sender | This file, whole; `r` when it answers a message ([401](401-paired-chat.md#replies)), `fw` when it was forwarded (its hop count, [401](401-paired-chat.md#forwards)). Repeated on every session until the transfer ends; `paused` while the sender paused it |
| `pf-accept {id, offset}` | receiver | Send from `offset` (0, or where the stored part ends) |
| `pf-wait {id, why}` | receiver | Not now: `consent` (its person has not decided), `paused`, `busy` (other files arrive first) |
| `pf-data {id, offset, data}` | sender | base64url bytes at `offset`, at most 16 KiB |
| `pf-got {id, offset}` | receiver | Every byte before `offset` is stored (cumulative) |
| `pf-sum {id, size, digest}` | sender | Every byte confirmed; SHA-256 of the file, base64url |
| `pf-done {id}` | receiver | Stored and checked |
| `pf-refuse {id, why, room?}` | receiver | `declined`, `cancelled`, `no-room` (with the bytes it can take), `too-many`, `damaged`, `expired`, `invalid` |
| `pf-abort {id}` | sender | Cancelled |
| `pf-room {max}` | either | Bytes this side can take for files now (free disk, or the browser's storage quota) |

### Rules

- **Consent.** A receiver takes a file of at most 25 MiB by itself while what it took that way from this contact (and still keeps) stays within 500 MiB; anything else waits for its person, who sees the name, the size and its own free space. A file larger than that space is refused with `no-room`. At most 16 offers per contact wait for an answer; the 17th is refused with `too-many`. An offer nobody answers ends after seven days (`expired`), and the same offer sent again afterwards is refused with `expired`, never taken: nothing was agreed. A file that was taken (by the person or within those limits) and failed here (damaged, not stored) is taken again from the start when offered again. Consent given while the sender is away holds: the next offer is accepted.
- **Flow.** A sender keeps at most 1 MiB sent and not confirmed. A receiver confirms at least every 128 KiB and whenever it has stored all it received. At most 3 files arrive from one contact at once; accepted ones beyond wait with `busy` and are accepted in turn.
- **Resume.** Every answer is idempotent, so the sender only follows the last one: an `accept` moves it to that offset, backwards too. A receiver that sees data past what it has (a chunk lost in a transport switch) answers with an `accept` at what it has, once per gap. A sender that hears nothing for 30 s while something is outstanding offers again; a receiver that gets no data for 30 s on a file under way says `accept` again at what it has, so a sender that never offers again (an older app, a stuck one) is still put back in step. A receiver makes what it stored durable every 8 MiB and records that point; after a restart it truncates the file there and accepts from it.
- **Stuck transfers (0.3.2, no wire change).** An unfinished transfer that has not moved for 60 s, or not since the app started, and is not waiting for a person (an answer, a pause) offers its person **Send again** (sender: the offer goes again now, under its id) or **Ask again** (receiver: `accept` at what it has). Either goes on from the bytes the receiver holds, and the chat keeps one message on each side. With no live session the action waits for the next one, and the app tries to connect. A failed transfer keeps its own **Retry**.
- **Backpressure.** A sender puts a data frame on the session only when the session has room: channels with a small send budget (the native and Iroh ones refuse frames past 120 KiB queued) give files a quarter of it, so pings and messages still fit. Sending again into a full channel at once never let it drain, and froze the app (0.3.2).
- **Video description (0.4.1).** A `video/*` file's offer (and a `files/2` `pf-start`, and a held file's meta in [4xx](4xx-store-and-forward.md)) may carry `video {duration, width, height, poster?}`: milliseconds, pixels as it plays, and a JPEG of an early frame in base64url, at most 12 KiB, so the receiver shows a picture and a length before a byte has arrived (and before its person accepts a large one). Optional and advisory: an app that does not know it ignores it, and a malformed one is dropped without refusing the file (a bad poster alone drops only the poster). The receiver may make its own poster from the first frame once the file is in. Received video of a playable type (MP4, WebM, QuickTime, Ogg, M4V) is handed to a player with its type; anything else stays opaque bytes.
- **Integrity.** The receiver computes the SHA-256 of what it stored (read back, not what passed through memory) and compares it with `pf-sum`. A mismatch deletes the file and is refused with `damaged`; the sender may offer it again under the same id, and the receiver takes it from the start without asking again.
- **Pause and cancel.** The sender pauses by offering with `paused` and resumes by offering without it; the receiver pauses with `pf-wait` `paused` and resumes with `pf-accept`. Either side cancels: the sender with `pf-abort`, the receiver with `pf-refuse` `cancelled`; the receiver removes what it stored.
- **Offered again after a stop (0.4.2, no wire change).** A transfer its sender stopped with `pf-abort` (a read failure, for example) is taken again from the start when the sender offers it again under the same id. One the receiver's person cancelled stays refused with `cancelled`. An older receiver refuses both, as before.
- **Forwarded files (0.4.3).** A file forwarded from another chat ([400](400-chat.md#forwards)) is offered like any file, from the bytes on the forwarder's device, with `fw` (and `pf-start` carries it for `files/2`). The receiver's consent rules apply as they do to any file. A receiver drops a `fw` that is not a whole number from 1 to 255 and takes the file.
- **Storage.** Received bytes go to storage as they arrive and are read back in ranges, so no file is held whole in memory (browsers: the origin-private file system, IndexedDB pieces where it is missing; Desktop: files in the app's data folder). There is no size limit but the receiver's space and safe integers (2^53 - 1 bytes).

Implemented in [`chatFiles.ts`](../../packages/core/src/chatFiles.ts) (protocol) and [`fileDesk.ts`](../../packages/browser/src/engine/fileDesk.ts) (the app's records, storage and messages).

## files/2 framing

Both peers negotiate `files/2`. `pf-start` announces ID, sanitized metadata and exact byte length (and `r` when the file answers a message, [401](401-paired-chat.md#replies)). `pf-chunk` carries offset plus base64url data; stop-and-wait credits allow one 16 KiB chunk in flight per sender. `pf-end` binds final offset and SHA-256 digest. `pf-ack` identifies phase and offset; `pf-cancel` identifies the sender/receiver side.

The receiver MUST validate offsets, exact size and digest, then finish durable `sink.close` before the final acknowledgement. A duplicate already stored file can acknowledge its stored digest without storing/executing a second copy. Reject mismatched digests, replayed IDs with different content and unsupported capability frames. Names are display suggestions, not paths; MIME is untrusted.

## Limits and scope

For `files/2`: the common contract's 100 MiB file bound, three concurrent incoming files, 500 MiB per-peer stored quota and 30-second idle timeout apply. Cancellation releases partial resources. `files/2` retries whole files; `files/3` resumes (above). Neither offers offline download or group distribution. No DHT bulk fallback.

[PairedFiles](../../packages/core/src/pairedFiles.ts), [shared limits](../../packages/core/src/frames.ts), [paired capability evidence](PAIRED-CAPABILITIES.md). Validate corrupted/end-missing transfer, disk failure before receipt, cancel and reconnect independently of the transport adapter.

## Revision log

- 0.4.3 (2026-09-27): forwarded files carry `fw` on `pf-offer` and `pf-start`.
- 0.4.2 (2026-09-27): a transfer its sender stopped (`pf-abort`) is taken again from the start when offered again; one the receiver cancelled stays refused (#352).
- 0.4.1 (2026-09-27): optional `video` description on an offer (length, size, poster); no change for apps that ignore it.
- 0.4 (2026-09-27): `r` on `pf-offer` and `pf-start`: a file that answers a message. A reply that does not check out is dropped; the file is taken all the same. Older apps ignore it.
- 0.3.2 (2026-09-27): stuck transfers (no move for 60 s) offer Send again and Ask again; a receiver with no data for 30 s accepts again by itself; a sender writes only while the session has room (#348). No wire change.
- 0.3.1 (2026-09-26): an offer that expired unanswered is refused when offered again, never taken without consent.
- 0.3 (2026-09-25): `files/3`: offer and consent, advertised room, 1 MiB window, resume from the stored offset after a drop, a switch or a restart, SHA-256 checked on what was stored, pause and cancel from either side. `files/2` kept for older apps.
- 0.2 (2026-09-25): renamed Chat Files; place in the one chat; behaviour on a drop to the DHT.
- 0.1 (2026-09-22): paired files profile.
