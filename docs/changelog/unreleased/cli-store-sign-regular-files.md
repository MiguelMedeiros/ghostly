---
section: Fixed / Apps
---
- `ghostly store sign` no longer hangs on an index, or a `ghostly-store.json` or `ghostly-store.sig` already in its output folder, that is a FIFO or a link to a device: it refuses it unread (`<path> is not a file`), as `app publish` and `app verify` already did, and reads at most a store index's 16 MiB.
