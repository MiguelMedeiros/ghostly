---
section: Fixed / Everywhere
---
- A file you send that is paused (by you or your contact) or cut off mid-way no longer holds memory for the part read ahead to send next. Each one kept 1 MiB until it ended, so 32 files paused mid-way held 32 MiB of the app's or the CLI daemon's memory.
