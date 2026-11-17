---
section: Fixed / CLI
---
- A daemon no longer stops for a fraction of a second when its store folds its journal into a fresh snapshot (about once an hour on a profile with chats). The snapshot is written a page at a time and synced off the daemon's thread, so commands, relays and calls go on while it is written: the longest stop on a profile with 100,000 recent messages went from 218 ms to 28 ms, and from 835 ms to 84 ms at 300,000.
