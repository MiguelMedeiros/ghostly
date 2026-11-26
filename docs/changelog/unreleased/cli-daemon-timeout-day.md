---
section: Fixed / CLI
---
- `ghostly daemon stop`, `daemon restart`, `daemon status` and `daemon --detach` refuse a `--timeout` past a day (86400 seconds) as a usage error. A value past about 24.8 days fired at once: `daemon stop --timeout 3000000` sent a running daemon SIGTERM within a millisecond, saying it had not answered in 3000000 s.
