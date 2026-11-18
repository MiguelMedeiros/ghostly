---
section: Fixed / Apps
---
- `ghostly app unserve` of the last served app, and `ghostly app served` after it, now answer `restart: true` while the daemon still offers apps to contacts: the daemon reads the list when it starts, so it goes on offering apps until `ghostly daemon restart`, and the answer said nothing of it.
