---
section: Fixed / CLI
---
- `ghostly daemon --detach --timeout <s>` now gives up at the time asked. It waited for one 200 ms poll before its first check, so a short timeout took about 200 ms whatever its value, and on a fast machine the daemon came up within that poll and the command said "started" rather than "still starting". It now checks at once and never waits past the deadline; `daemon stop --timeout` no longer overshoots its deadline by up to 100 ms either, and a daemon that could not be spawned at all (no process or file slots left) is reported as such instead of crashing the command.
