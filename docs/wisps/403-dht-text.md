# WISP 403 — Bounded DHT Text

| Field | Value |
|---|---|
| Candidate number | 403; editorial family allocation |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-22 |
| Document kind | Profile |
| Dependencies | [400](400-chat.md) |
| Implementation | Modern DHT-only and explicitly permitted fallback paths; native DHT versus browser relays differ. |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Wire binding and limits

This profile is a small-record delivery path, not an adapter pretending that the DHT is a live byte stream. It uses separate directional Pkarr mailboxes and the `_dm`/`_dmk` envelope described in [DHT delivery](../DHT-DELIVERY.md). The envelope binds sender participation, intended recipient, sequence, times, delivery mode, message ID and receipt. Known participation keys must not be silently replaced.

Only text is admitted: at most 256 UTF-8 bytes, and complete encrypted/authenticated DNS packets must fit 1,000 bytes. Escaping/receipts can lower the usable text budget. Refuse oversized content intact; do not fragment or truncate. Keep one outstanding message per direction, a five-minute lifetime and at most eight bounded publication attempts. Save original expiry/sequence/attempt state before publishing. A mode switch cannot reset the budget.

Persist received content before advancing replay state or acknowledging its stable ID. Publishing is not delivery confirmation. Expiry stops acceptance/retransmission; it does not erase caches, screenshots or recipient history. This construction has no forward-secrecy guarantee.

## Runtime and conformance

DHT-only avoids stream discovery/dialing. Stream fallback requires an authenticated contact advertising support and must not bypass a security rejection. Native uses Pkarr; browser/extension use HTTP relays. Financial envelopes, files, calls and service bodies never enter this path; Cashu bearer tokens are refused as text. See [implementation](../../packages/core/src/dhtDelivery.ts). Check exact packet budgets, restart/expiry, pin substitution, rejected publication, duplicate receipts and cross-path message deduplication.
