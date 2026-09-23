# WISP 402 — Legacy Timestamp Chat

| Field | Value |
|---|---|
| Candidate number | 402; editorial family allocation |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-22 |
| Document kind | Profile |
| Dependencies | [400](400-chat.md) |
| Implementation | Existing legacy 1:1 clients. |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Wire binding

Legacy live text is `{t:"m",ts,m}` on the data channel. Offline small-record text uses encrypted `_msgs` batches with timestamp acknowledgements. `LinkSession.sendMessage` limits input to 500 UTF-8 bytes; record packing can truncate a single message to 400 characters or omit older content to fit its total budget. The 500-byte input limit is therefore not a delivery guarantee. Live sender and parser bounds differ; callers must respect the tighter applicable bound.

Deduplication/high-water marks use timestamps, not collision-free sender message IDs. Handing buffered text to a live stream can clear the local buffer and emit an acknowledgement event; this MUST NOT be presented as remote durable storage or reading.

## Compatibility and limitations

Keep legacy parsing separate from [paired chat 401](401-paired-chat.md) and [modern DHT text 403](403-dht-text.md). This profile makes no group fanout, durable mailbox or global single-use invite guarantee. [LinkSession](../../packages/core/src/link.ts), [frames](../../packages/core/src/frames.ts), [record packing](../../packages/core/src/records.ts) and [implemented protocol](../PROTOCOL.md) define the concrete encoding. Test equal timestamps, packing limits and duplicate delivery across paths.
