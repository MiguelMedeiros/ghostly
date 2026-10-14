---
section: Fixed / CLI
---
- `ghostly daemon --detach --timeout <s>` (and `daemon restart`) shorter than the daemon's start no longer says "The daemon did not start" while the daemon it started keeps running: it says the daemon is still starting, with its process id (exit 4). A `--timeout` of 0 or less on `daemon`, `daemon stop` and `daemon restart` is a usage error.
