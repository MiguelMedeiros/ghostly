---
section: For developers / Apps
release: 1.2
---
- Behind the apps flag: an app whose icon was shown no longer keeps its whole bundle (up to 16 MiB) in memory. The icon kept for the Apps page, chat cards and the composer's Apps was a view of the bundle's bytes, which held all of them. With ten apps of 8 MiB, drawing their icons kept 80 MiB. Now it keeps 16 MiB, the two bundles of the cache.
