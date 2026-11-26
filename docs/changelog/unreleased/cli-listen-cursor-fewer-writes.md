---
section: Fixed / CLI
---
- `ghostly listen --cursor` no longer writes its cursor file for every event it drops (a busy group not on `--group`, a contact's app frames) or again for a number it already holds: past dropped events it writes at most every 100 ms, and at once when it stops. Each write was a file renamed over the last, about 0.2 ms and a disk block per event.
