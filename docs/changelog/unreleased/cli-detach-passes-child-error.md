---
section: Fixed / CLI
---
- `daemon --detach` and `daemon restart` whose daemon refused to start (a mistyped `GHOSTLY_PKARR_RELAYS`, `GHOSTLY_IROH_RELAYS` or `GHOSTLY_HYPERDHT_BOOTSTRAP`) answered `engine` "The daemon did not start; see daemon.log", exit 1. They now answer with the daemon's own error, as the same command in the foreground does (`usage`, exit 2, naming the variable and the value), with the log's path in `details.log`.
