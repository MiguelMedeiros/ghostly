---
section: For developers / Relays
---
- `RelayTransport` coalesces concurrent reads for the same Pkarr relay and budget lane into `POST <relay>/batch` (up to 64 keys per request, counting as one HTTP round-trip against the relay budget) while keeping per-key Ed25519 verification and timestamp freshness checks. Relays that answer `404`, `405` or `501` are cached as single-GET only for an hour and fall back to `GET /<key>` with no circuit-breaker penalty.
