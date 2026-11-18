---
section: Fixed / CLI
---
- A daemon no longer stalls on writes that come in while it folds its store (the hourly fold, a purge, a backup): each of them was synced to the disk on its own, one by one, with the daemon held. They now share one sync in the background, as other writes do. 800 messages stored behind a fold held the daemon up to 350 ms at a time; now about 10 ms.
