---
section: Fixed / CLI
---
- `ghostly daemon status` says `"starting": true` with the daemon's pid while the profile's daemon is still starting. Before, it said `"running": false`, as if no daemon ran, while the daemon already held the profile.
