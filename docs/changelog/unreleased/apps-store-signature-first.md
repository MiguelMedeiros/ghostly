---
section: For developers / Apps
---
- A store index's own signature is checked before the signatures of the revocations it carries, so an index nobody signed costs its reader one signature check, not up to 4097. Only an index with two faults reads differently: a revocation that does not verify in an index whose own signature does not verify is now `bad-signature` (it was `bad-revocation`). `readAppStoreSteps` reads an index in steps for a reader that shares its thread, and takes the revocations already checked (WISP 1200, Stores).
