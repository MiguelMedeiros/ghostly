---
section: For developers / Tests
---
- The regtest suites no longer time out waiting for LND to sync on a shared stack nobody mined on for a while: `ensureMiner` mines one block when the chain's tip is over an hour old.
