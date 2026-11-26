---
section: Fixed / CLI
---
- A daemon holds at most 64 MiB of event replays that their clients have not read, across all connections. Before, each `events.subscribe` from the start that did not read kept a whole copy of the events journal in the daemon's memory (30 of them: 1.3 GB, and replies slowed to nearly 2 s). Past the bound, a new replay closes the oldest connection that still has unread replay data. Like `ghostly listen`, a client reconnects from the last event it received.
