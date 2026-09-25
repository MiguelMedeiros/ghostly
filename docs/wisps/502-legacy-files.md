# WISP 502: Compatibility File Frames

| Field | Value |
|---|---|
| Candidate number | 502; editorial family allocation |
| Status | Draft |
| Revision | 0.2 |
| Updated | 2026-09-25 |
| Document kind | Profile |
| Dependencies | [500](500-files.md) |
| Disposition | Retained for compatibility chats ([402](402-legacy-chat.md)) only; never negotiated in a new chat |
| Implementation | Legacy live data links; both peers online. |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Disposition (revision 0.2)

Formerly "Legacy File Frames". Retained, not withdrawn: a compatibility chat ([402](402-legacy-chat.md)) with a contact on Ghostly 0.4 still sends and receives files this way over its legacy WebRTC link. A new chat uses [501](501-paired-files.md) only. The number and file name stay.

## Concrete framing

A `file` control frame announces file ID, stream ID, name, size, MIME and timestamp. Binary kind-3 chunks carry content and END marks completion. Enforce announced length, 100 MiB per file, three incoming files per peer,500MiBreceived storage per peer and 30-second idle timeout. Unknown/duplicate stream IDs and excess/truncated bodies are errors.

Cancellation/reset, name sanitization, MIME distrust and per-peer storage limits remain local safety requirements. Content is not automatically executed. The legacy completion event does not provide the authenticated digest plus final durable-storage acknowledgement of [501](501-paired-files.md). Do not display those stronger guarantees for this profile.

## Compatibility and evidence

Use [frames](../../packages/core/src/frames.ts), [FileTransfers](../../packages/core/src/files.ts) and [file tests](../../packages/core/test/files.test.ts). This profile has no resume, offline download, group multicast or DHT payload mode. Check disconnect cleanup and exact length before marking the local transfer complete.

## Revision log

- 0.2 (2026-09-25): renamed Compatibility File Frames; retained for compatibility chats only.
- 0.1 (2026-09-22): legacy file frames profile.
