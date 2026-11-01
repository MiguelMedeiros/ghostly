---
section: Fixed / Identities
---
- Ghostly checks your contacts' identity proofs for a revocation every 12 hours, and that schedule now carries over
  when you reload or reopen the app. Before, every start looked up each of those proofs again a minute in, which used
  the relays' share for background reads that profiles and DIDs also need.
