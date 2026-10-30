---
section: Fixed / CLI
---
- Two processes started at the same moment on one profile (two `daemon --detach`, or a daemon and a command) can no longer both hold it. The profile's lock file was empty for a moment while it was written, and another process took an empty or vanished lock for nobody's and removed it. The lock now appears with the pid already in it, an empty lock younger than a second counts as busy, and a stale lock is removed only when it is still the one judged stale.
