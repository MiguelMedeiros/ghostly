---
section: Fixed / CLI
---
- A `ghostly daemon` started in the foreground, as a service manager (systemd, launchd) starts it, now waits for a command that holds the profile for a moment, such as a bot's `send` during the restart, up to its `--timeout` (60 s). Before, it stopped at once with `busy` and the profile had no daemon. `daemon --detach` and `daemon restart` already waited.
