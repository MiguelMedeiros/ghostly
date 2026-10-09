---
section: For developers / Apps
release: 1.2
---
- Behind the apps flag: an app's storage calls, file reads and chat messages no longer read every store's whole index from the database each time to check for removals and revocations. The engine keeps what that check needs in memory and reads it again only after a store is added, removed or refreshed.
