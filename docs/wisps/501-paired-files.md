# WISP 501: Chat Files

| Field | Value |
|---|---|
| Candidate number | 501; editorial family allocation |
| Status | Draft |
| Document kind | Profile |
| Dependencies | [500](500-files.md) |
| Implementation | Every chat session: `files/3` (any size, consent, resume), `files/4` (its bytes as binary messages, on WebRTC sessions) and `files/2` for older apps; WebRTC and supported native adapters |
| Summary | How files travel in every chat: negotiated, chunk by chunk, with integrity checks. |
| Availability | Available |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Place in the one chat (revision 0.2)

Formerly "Paired Files". This is how files travel in every chat of [400](400-chat.md) while it is `live`. The wire (`files/2`, `pf-*` frames) is unchanged. While the chat is `on-dht` or `dht-chosen`, files are held ([404](404-store-and-forward.md)) or wait in the outbox for layer 1 ([500](500-files.md#files-in-the-one-chat-revision-02)), their offer said ahead on the floor to a contact that takes it there ([403](403-dht-text.md#files-revision-2026-10-03)); a `files/2` transfer cut by a drop to the DHT fails and is retried whole when layer 1 is back, under its original ID; a `files/3` transfer resumes from what was stored (below).

## files/3: files of any size (revision 0.3)

`files/3` is a session capability ([03](03-capabilities.md)): each side lists it in its `paired-capabilities` frame, and it is on while both do. Without it, `files/2` below applies unchanged, with its 100 MiB limit; an app that speaks both uses `files/3` with a contact that lists it and `files/2` with one that does not.

### Frames

All are JSON on the authenticated session, at most one 16 KiB chunk each. `id` is the sender's (`[A-Za-z0-9_-]{8,64}`); a receiver stores the file under an id of its own.

| Frame | From | Meaning |
|---|---|---|
| `pf-offer {id, name, mime, size, ts, voice?, video?, image?, r?, fw?, paused?}` | sender | This file, whole; `r` when it answers a message ([401](401-paired-chat.md#replies)), `fw` when it was forwarded (its hop count, [401](401-paired-chat.md#forwards)). Repeated on every session until the transfer ends; `paused` while the sender paused it |
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

- **Consent.** A receiver takes a file of at most 25 MiB by itself while what it took that way from this contact (and still keeps) stays within 500 MiB; anything else waits for its person, who sees the name, the size and its own free space. A file larger than that space is refused with `no-room`. At most 16 offers per contact wait for an answer; the 17th is refused with `too-many`. An offer nobody answers ends after seven days (`expired`), and the same offer sent again afterwards is refused with `expired`, never taken: nothing was agreed. A file that was taken (by the person or within those limits) and failed here (damaged, not stored) is taken again from the start when offered again; one that was taken within those limits, not by the person, is decided again first, as a new offer would be (so it waits for its person past the limits, and past the free space it is refused). A new offer under the id of a message the chat already holds is refused with `invalid`. Consent given while the sender is away holds: the next offer is accepted.
- **Flow.** A sender keeps at most 1 MiB sent and not confirmed. A receiver confirms at least every 128 KiB and whenever it has stored all it received. At most 3 files arrive from one contact at once; accepted ones beyond wait with `busy` and are accepted in turn.
- **Resume.** Every answer is idempotent, so the sender only follows the last one: an `accept` moves it to that offset, backwards too. A receiver that sees data past what it has (a chunk lost in a transport switch) answers with an `accept` at what it has, once per gap. A sender that hears nothing for 30 s while something is outstanding offers again; a receiver that gets no data for 30 s on a file under way says `accept` again at what it has, so a sender that never offers again (an older app, a stuck one) is still put back in step. A receiver makes what it stored durable every 8 MiB and records that point; after a restart it truncates the file there and accepts from it. What a sender sends again is bounded (revision 2026-10-09): it counts every byte of data it sent for the file, and once that passes three times the file's size and 256 MiB it ends the transfer with `pf-abort`. An app that keeps a budget for what it sends (group files, [503](503-group-files.md#serving-limits)) may end it sooner.
- **Stuck transfers (0.3.2, no wire change).** An unfinished transfer that has not moved for 60 s, or not since the app started, and is not waiting for a person (an answer, a pause) offers its person **Send again** (sender: the offer goes again now, under its id) or **Ask again** (receiver: `accept` at what it has). Either goes on from the bytes the receiver holds, and the chat keeps one message on each side. With no live session the action waits for the next one, and the app tries to connect. A failed transfer keeps its own **Retry**.
- **Backpressure.** A sender puts a data frame on the session only when the session has room: channels with a small send budget (the native and Iroh ones refuse frames past 120 KiB queued) give files a quarter of it, so pings and messages still fit. Sending again into a full channel at once never let it drain, and froze the app (0.3.2).
- **Voice description.** A voice message is a file whose offer (and a `files/2` `pf-start`, and a held file's meta in [404](404-store-and-forward.md)) carries `voice {duration, peaks}`: its length in milliseconds (at most 15 minutes, a receiver allowing 5 s more) and its loudness as 1 to 128 whole numbers from 0 to 255 in playing order (the app draws 64), measured while recording so no receiver decodes audio to draw it. It counts only on a type a player may be handed as it is (`audio/` webm, ogg, opus, mp4, mpeg, mp3, aac, x-m4a, wav, x-wav, wave, flac, x-flac; `PLAYABLE_AUDIO` in `packages/core/src/voice.ts`); anything else, or a malformed one, means the file is shown as a file, never refused. A file of such a type sent without `voice` is shown with a player too (#379). The headless CLI measures `peaks` from the file it sends (#353).
- **Video description (0.4.1).** A `video/*` file's offer (and a `files/2` `pf-start`, and a held file's meta in [404](404-store-and-forward.md)) may carry `video {duration, width, height, poster?}`: milliseconds, pixels as it plays, and a JPEG of an early frame in base64url, at most 12 KiB, so the receiver shows a picture and a length before a byte has arrived (and before its person accepts a large one). A receiver takes it only on a `video/*` type, a length from 1 ms to 10 hours and a width and height from 1 to 16,384 pixels, and a poster only when its bytes start as a JPEG does (`FF D8 FF`; `VIDEO_LIMITS` in `packages/core/src/video.ts`). Optional and advisory: an app that does not know it ignores it, and a malformed one is dropped without refusing the file (a bad poster alone drops only the poster). The receiver may make its own poster from the first frame once the file is in. Received video of a playable type (MP4, WebM, QuickTime, Ogg, M4V) is handed to a player with its type; anything else stays opaque bytes.
- **Picture size (0.4.4).** An `image/*` file's offer (and a `files/2` `pf-start`, and a held file's meta in [404](404-store-and-forward.md)) may carry `image {width, height}`: whole pixels from 1 to 65535, as the picture is shown (a JPEG's EXIF orientation applied), so the receiver lays out the picture's box before a byte has arrived and the chat does not move when it loads. The sender reads it from the file's first 256 KiB (the PNG, GIF and WebP headers, a JPEG's frame header) without decoding the picture, and sends none when they do not say. Optional and advisory: an app that does not know it ignores it, a malformed one is dropped without refusing the file, and a receiver shows a picture that loads as another shape as it loaded. A receiver without one may read the size from the bytes once they are in.
- **Integrity.** The receiver computes the SHA-256 of what it stored (read back, not what passed through memory) and compares it with `pf-sum`. A mismatch deletes the file and is refused with `damaged`; the sender may offer it again under the same id, and the receiver takes it from the start without asking again.
- **Pause and cancel.** The sender pauses by offering with `paused` and resumes by offering without it; the receiver pauses with `pf-wait` `paused` and resumes with `pf-accept`. A sender's pause holds whatever the receiver answers: a `pf-wait` (its person still deciding) leaves it paused, and a `pf-accept` while it is paused is answered with the paused offer again. Either side cancels: the sender with `pf-abort`, the receiver with `pf-refuse` `cancelled`; the receiver removes what it stored.
- **Offered again after a stop (0.4.2, no wire change).** A transfer its sender stopped with `pf-abort` (a read failure, for example) is taken again from the start when the sender offers it again under the same id. One the receiver's person cancelled stays refused with `cancelled`. An older receiver refuses both, as before.
- **Forwarded files (0.4.3).** A file forwarded from another chat ([400](400-chat.md#forwards)) is offered like any file, from the bytes on the forwarder's device, with `fw` (and `pf-start` carries it for `files/2`). The receiver's consent rules apply as they do to any file. A receiver drops a `fw` that is not a whole number from 1 to 255 and takes the file.
- **Said on the DHT floor first (revision 2026-10-03).** A file that waited for the live session while the contact was away may have had its offer said on the floor ([403](403-dht-text.md#files-revision-2026-10-03)): the receiver then holds its message, waiting, under that wire id. The `pf-offer` that comes under that id is not refused for it: it takes that message over, in its place, and what the offer says is what the file is. A `pf-abort` for such an id, with no offer before it, ends that message as cancelled by the sender: the sender says it for a file deleted on its side before it went live.
- **Waiting for the contact's capabilities.** `files/3` is agreed in `paired-capabilities`, which a session that just opened has not heard yet. A sender with files queued while not live waits for them a little (the app: up to 4 s) before it decides the contact takes no files and fails the file with that reason (#385).
- **Storage.** Received bytes go to storage as they arrive and are read back in ranges, so no file is held whole in memory (browsers: the origin-private file system, IndexedDB pieces where it is missing; Desktop: files in the app's data folder). There is no size limit but the receiver's space and safe integers (2^53 - 1 bytes).

Implemented in [`chatFiles.ts`](../../packages/core/src/chatFiles.ts) (protocol) and [`fileDesk.ts`](../../packages/browser/src/engine/fileDesk.ts) (the app's records, storage and messages).

## files/4: a file's bytes as bytes (revision 2026-10-12)

`files/3` writes a file's bytes as base64url text inside a JSON frame, so with a 22-character id a 16 KiB chunk is a 21,920-byte frame and a 200 MiB file is 267.6 MiB of frames: a third more than the file, on every transport, relayed ones included. `files/4` sends the same chunk as one binary message of the session ([100](100-transports.md#text-and-binary-messages-revision-2026-10-12)): 16,416 bytes, 200.4 MiB for that file, 0.2% more than it. Nothing else changes: every other frame, every rule and every limit above is `files/3`'s.

- **Agreed like `files/3`.** `files/4` is a session capability of its own in `paired-capabilities`. An app that lists it lists `files/3` too, and it is on only while both sides list both on the current session. An app lists it only on a session whose adapter carries binary messages at its end: a WebRTC session does, a HyperDHT session does where [103](103-hyperdht.md#frames-revision-2026-10-12) says so; an Iroh session does not yet ([102](102-iroh.md)), so files there stay on base64, as they do with any app that does not list `files/4`.
- **The data message.** One binary message, at most 16,458 bytes:

  | Bytes | Field | Value |
  |---|---|---|
  | 1 | kind | `0x04` |
  | 1 | id length | 8 to 64 |
  | id length | `id` | The sender's id for the file, in ASCII (`[A-Za-z0-9_-]`) |
  | 8 | `offset` | Unsigned, big endian; at most 2^53 - 1 |
  | 1 to 16,384 | data | The file's bytes from `offset`, as they are |

  It means what `pf-data {id, offset, data}` means, and every rule that names a data frame (flow, confirming, resume, what is sent again and its bound, backpressure) counts it the same way, by its bytes of data.
- **Sender.** For each chunk, a sender sends the binary message when `files/4` is on for the open session at that moment, and the `pf-data` frame otherwise. A transfer under way follows the session: after a transport switch or a reconnection it goes on in whichever form the new session agreed, from the offset the receiver accepts.
- **Receiver.** An app that lists `files/4` takes a file's data in either form, at any time, for the same transfer. A binary message that is malformed (shorter than its header and one byte, another kind, an id length or an id outside the above, an offset past 2^53 - 1, more than 16,384 bytes of data), that names no transfer under way, or that comes while `files/4` is not on, is dropped as a malformed frame is: it ends neither the transfer nor the session, and the resume rules bring the bytes again.
- **Not covered.** `files/2`, held files ([404](404-store-and-forward.md)) and a file's offer said on the DHT floor are unchanged. A group's file session ([503](503-group-files.md)) stays on `files/3` frames until 503 says otherwise.

## files/2 framing

Both peers negotiate `files/2`. `pf-start` announces ID, sanitized metadata and exact byte length (and `r` when the file answers a message, [401](401-paired-chat.md#replies)). `pf-chunk` carries offset plus base64url data; stop-and-wait credits allow one 16 KiB chunk in flight per sender. `pf-end` binds final offset and SHA-256 digest. `pf-ack` identifies phase and offset; `pf-cancel` identifies the sender/receiver side.

The receiver MUST validate offsets, exact size and digest, then finish durable `sink.close` before the final acknowledgement. A duplicate already stored file can acknowledge its stored digest without storing/executing a second copy. Reject mismatched digests, replayed IDs with different content and unsupported capability frames. Names are display suggestions, not paths; MIME is untrusted.

## Limits and scope

For `files/2`: the common contract's 100 MiB file bound, three concurrent incoming files, 500 MiB per-peer stored quota and 30-second idle timeout apply. Cancellation releases partial resources. `files/2` retries whole files; `files/3` resumes (above). Neither offers offline download or group distribution. No DHT bulk fallback.

[PairedFiles](../../packages/core/src/pairedFiles.ts), [shared limits](../../packages/core/src/frames.ts), [paired capability evidence](PAIRED-CAPABILITIES.md). Validate corrupted/end-missing transfer, disk failure before receipt, cancel and reconnect independently of the transport adapter.

## Revision log

One file per change in [changes/501-paired-files/](changes/501-paired-files/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
