---
section: Fixed / CLI
---
- `ghostly profile backup` no longer fails when the daemon removes one of the profile's files while the backup runs (a deleted or disappearing message's file, a group's files). It failed with Node's bare `ENOENT: no such file or directory`. The removed file is now left out, as one the profile no longer has, and the backup is made. A file that changes size while it is copied still stops the backup.
