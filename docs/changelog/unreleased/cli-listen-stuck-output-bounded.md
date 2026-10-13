---
section: Fixed / CLI
---
- `ghostly listen` whose output nobody reads (a consumer that hung), or whose `--exec` or `--webhook` falls behind, no longer keeps every event it cannot pass on in memory: it grew by about 2 KB per event without a limit. It now stops taking events about a thousand events ahead and goes on from the last one once its output or hook catches up. Meanwhile the daemon's event journal keeps them, as for a listener that was not running, and `events.gap` says if any are dropped.
