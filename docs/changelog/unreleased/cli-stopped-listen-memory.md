---
section: Fixed / Everywhere
---
- CLI: a `ghostly listen` paused with Ctrl+Z, or any client of the daemon's socket that stops reading, no longer makes the daemon keep every later event in memory until it reads again. Past 8 MiB unread the daemon ends that connection, and `listen` picks up again after the last event it took.
