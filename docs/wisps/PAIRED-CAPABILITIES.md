# Files and sats in the chat session

`paired-chat/1` now negotiates `files/2` and `payments/1` in its authenticated offer. Both endpoints must advertise support. Old text-only endpoints still pair and chat; new actions stay unavailable with them. External proofs and identities remain outside this change. Calls (`calls/1`) and hosted HTTP (`services/1`) came later, announced after the handshake in a `paired-capabilities` frame ([401](401-paired-chat.md#calls-and-shared-apps)), since the offer's 16 entries are full for apps before 0.5. Pair confirmation, pins, bootstrap and transport preferences are unchanged.

## Files

`pf-start` announces a bounded file ID, sanitized name/type, size and timestamp. `pf-chunk` carries base64url bytes plus the exact byte offset. A sender waits for `pf-ack` after each chunk before reading/sending the next. `pf-end` carries the incremental SHA-256 digest; the receiver acknowledges it only after matching size/digest and committing its IndexedDB transaction. Frames are text on all three transports, including native channels that accept only text.

Limits: 100 MiB/file, 16 KiB/chunk, 3 concurrent incoming/outgoing transfers, 500 MiB stored incoming bytes per peer, 30-second inactivity timeout. Stop-and-wait limits queued sender payload to one chunk per transfer. Browser receipt storage still accumulates a bounded complete file in memory before storing its Blob. This is not a disk-streaming implementation or a claim of fast large-file transfer on high-latency networks.

Outbound transfer state survives restart: interrupted sends are failed, never falsely shown as delivered. “Retry sending” uses the stored bytes, original ID and timestamp. A receiver with the same persisted metadata/digest verifies the replay and repeats its receipt without creating a second message or Blob. Retry restarts the full file, not a byte-range resume. Disconnect, timeout, refusal, corruption and storage failure fail the transfer. Failed incoming files retain a message but no downloadable bytes.

## Payments

The existing validated `pay`, `pay-req` and `pay-res` frames now dispatch inside an authenticated session only after mutual `payments/1` negotiation. Capability admission precedes token creation or invoice requests. Tokens never go through the DHT or renderer views. Existing accepted-mint, fee, invoice amount and reclaim rules remain.

Concurrent payment of one request is coalesced. Concurrent delivery of one payment ID is serialized and credited once. Received proofs, wallet transaction and incoming payment record commit atomically. Reconnection retries the same pending outgoing token and ID; it never creates another spend. Persisted incoming records answer repeated receipts without redeeming again. Failed reclaim remains manually accessible. As before, there is no automatic byte/transaction recovery from a process dying inside an external mint operation before the mint's response reaches the wallet.

## Validation

- Core: paired-session compatibility and authentication, legacy files, new file chunks/integrity, delayed and failed storage, retry/replay, refusal/size limits, empty files.
- Browser: payment admission without spending, simultaneous pay request, duplicate redemption, reclaim/Lightning regression, outbox/pins/Ghostly-only persistence. IndexedDB regression explicitly aborts a transaction after its put request succeeds: no success receipt is allowed.
- Real native integration: Iroh QUIC and HyperDHT Noise, 128 KiB+7 file integrity, payment/request/receipt frames, migration, pins and chat receipts. Payment payloads here are fixtures; this test does not validate a mint.
- Web/extension E2E use fresh isolated browser profiles, local rendezvous, real WebRTC and an explicit localhost CDK mint with fake Lightning. No personal funds or production wallets are used. CDK independently auto-pays a request invoice, so its extra test deposit is distinguished from ecash duplication by wallet history.

The native desktop build uses the same core/engine; native GUI wallet transactions with a real mint were not exercised. Only Ghostly WISP Test is rebuilt, with user history and preferences preserved. The other endpoint must also run this version before its negotiated buttons become available.
