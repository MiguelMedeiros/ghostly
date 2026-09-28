# WISP 502: Compatibility File Frames

| Field | Value |
|---|---|
| Candidate number | 502; editorial family allocation |
| Status | Draft |
| Document kind | Profile |
| Dependencies | [500](500-files.md) |
| Disposition | Retained for compatibility chats ([402](402-legacy-chat.md)) only; never negotiated in a new chat |
| Implementation | Compatibility chats' live data links; both peers online. |
| Summary | File frames of chats with Ghostly 0.4 contacts, so they can still send and receive files. |
| Availability | Available |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Disposition (revision 0.2)

Formerly "Legacy File Frames". Retained, not withdrawn: a compatibility chat ([402](402-legacy-chat.md)) with a contact on Ghostly 0.4 still sends and receives files this way over its legacy WebRTC link. A new chat uses [501](501-paired-files.md) only. The number and file name stay.

## Concrete framing

A `file` control frame announces file ID, stream ID, name, size, MIME and timestamp. Binary kind-3 chunks carry content and END marks completion. Enforce announced length, 100 MiB per file, three incoming files per peer, 500 MiB received storage per peer and 30-second idle timeout. Unknown/duplicate stream IDs and excess/truncated bodies are errors.

Cancellation/reset, name sanitization, MIME distrust and per-peer storage limits remain local safety requirements. Content is not automatically executed. The legacy completion event does not provide the authenticated digest plus final durable-storage acknowledgement of [501](501-paired-files.md). Do not display those stronger guarantees for this profile.

## Compatibility and evidence

Use [frames](../../packages/core/src/frames.ts), [FileTransfers](../../packages/core/src/files.ts) and [file tests](../../packages/core/test/files.test.ts). This profile has no resume, offline download, group multicast or DHT payload mode. Check disconnect cleanup and exact length before marking the local transfer complete.

## Revision log

One file per change in [changes/502-legacy-files/](changes/502-legacy-files/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
