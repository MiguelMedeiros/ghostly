---
section: Fixed / Wallets
---
- A BDK wallet's Review payment, Refresh or balance no longer fails with "Could not sync from Esplora" when the server stumbles for a moment, as electrs does for its newest blocks right after a new one: the wallet reads the chain again after 1 s, then 2 s, before saying it failed.
