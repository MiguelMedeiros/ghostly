---
section: Fixed / CLI
---
- `ghostly listen --cursor <file>` following a daemon, with a cursor past the profile's last event, no longer skips the events the daemon journals as it restarts (its start, messages that waited for it) when the restart comes before any new event did.
