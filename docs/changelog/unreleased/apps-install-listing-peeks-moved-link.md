---
section: Fixed / Apps
---
- Installing from a store no longer downloads a whole app (up to 16 MiB) from a repository link that moved on to a version the store does not list: that link's first few KiB are read first, as the update check does, so Try again while the store's pinned copy is unreachable costs a few KiB, not the whole app each time.
