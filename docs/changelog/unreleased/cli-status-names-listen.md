---
section: Fixed / CLI
---
- `ghostly daemon status` (and `status`) now say `listen: true` when the profile is run by a `ghostly listen` that found no daemon, as `daemon stop` and `daemon restart` already do. Before, it looked like a plain daemon: a `daemon --detach` refused with "A daemon already runs" (a listen started at the same moment took the profile first) gave no hint that the next `daemon restart` would end the bot's listen.
