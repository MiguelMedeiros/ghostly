# WISP 501 — Paired Files

| Field | Value |
|---|---|
| Candidate number | 501; editorial family allocation |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-22 |
| Document kind | Profile |
| Dependencies | [500](500-files.md) |
| Implementation | Negotiated paired data links; WebRTC and supported native adapters. |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Concrete framing

Both peers negotiate `files/2`. `pf-start` announces ID, sanitized metadata and exact byte length. `pf-chunk` carries offset plus base64url data; stop-and-wait credits allow one 16 KiB chunk in flight per sender. `pf-end` binds final offset and SHA-256 digest. `pf-ack` identifies phase and offset; `pf-cancel` identifies the sender/receiver side.

The receiver MUST validate offsets, exact size and digest, then finish durable `sink.close` before the final acknowledgement. A duplicate already stored file can acknowledge its stored digest without storing/executing a second copy. Reject mismatched digests, replayed IDs with different content and unsupported capability frames. Names are display suggestions, not paths; MIME is untrusted.

## Limits and scope

The common contract's 100 MiB file bound, three concurrent incoming files, 500 MiB per-peer stored quota and 30-second idle timeout apply. Cancellation releases partial resources. This implementation retries whole files; it does not advertise resumable ranges, offline download or group distribution. No DHT bulk fallback.

[PairedFiles](../../packages/core/src/pairedFiles.ts), [shared limits](../../packages/core/src/frames.ts), [paired capability evidence](PAIRED-CAPABILITIES.md). Validate corrupted/end-missing transfer, disk failure before receipt, cancel and reconnect independently of the transport adapter.
