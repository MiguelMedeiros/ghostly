---
section: Security / Identities
---
- Identities: a DID proof (did:key, did:jwk, did:web, did:dht) no longer verifies with an Ed25519 key of small order, which no secret key goes with: such a key "signed" any statement with one constant signature, so a contact could show a verified DID nobody holds. Ed25519 signatures are now checked as RFC 8032 writes it.
