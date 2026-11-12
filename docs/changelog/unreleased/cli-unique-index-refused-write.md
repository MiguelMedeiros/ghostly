---
section: Fixed / CLI
---
- A write that a unique index refuses, in a store the CLI keeps in `rows.db`, no longer makes every later write to that store fail until the daemon restarts. Ghostly's own messages and file states have no unique index; a restored backup that declared one could reach it.
