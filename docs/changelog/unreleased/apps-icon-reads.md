---
section: For developers / Apps
release: 1.2
---
- Behind the apps flag: app icons on the Apps page, in a chat's app cards and in the composer's Apps no longer read the whole app bundle (up to 16 MiB) back and check it again each time they show. Each installed bundle is read and checked once, icons drawn at the same time share that read, and every icon after that comes from memory. With five apps installed, opening the Apps page three times read 11 bundles. Now it reads 5.
