---
section: Fixed / CLI
---
- `events --since` and `listen --since` no longer start with an `events.gap` when the events right after the cursor were of a message deleted, a chat removed or a group left: those leave the journal on purpose, and nothing was dropped. `events.gap` now comes only when the journal no longer holds events it kept, past 10,000 events or 16 MiB, and says only those.
