---
section: Fixed / Everywhere
---
- CLI: a `ghostly listen` attached to a running daemon whose output or hooks fall behind catches up without making the daemon read its event journal again for every 1,000 events. It closed its connection at each pause and the daemon replayed and sent the whole rest of the backlog again each time: 5 journal reads and about 15,000 events sent for a 5,000-event backlog, each one stalling the daemon. It now stops reading the connection while it waits and goes on from what the daemon already sent, so the journal is read once.
