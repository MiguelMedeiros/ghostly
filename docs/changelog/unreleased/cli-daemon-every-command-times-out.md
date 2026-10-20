---
section: Fixed / CLI
---
- On a daemon that has stopped answering, every other command (`send`, `react`, `typing`, `invite create`, `chat rename`, `group create`, `settings set` and the like) now gives up after 15 seconds too, with code `timeout` (exit 4) and the way out (`ghostly daemon restart`), and is not sent then, so the daemon does not act on it later when it wakes. Once the daemon answers, a long-running send still takes as long as it needs, as do a subscription (`listen`) and `identity add`.
