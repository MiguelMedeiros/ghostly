---
section: Fixed / CLI
---
- `ghostly listen` following a daemon, with a cursor past the profile's last event (a profile restored from a backup, a journal reset), no longer misses what the daemon journals while it restarts before the first new event (its `daemon.started`, a message that came in meanwhile): it goes on after the daemon's last event, as a listen with no cursor does, rather than waiting at the cursor's number.
