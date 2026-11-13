---
section: Fixed / CLI
---
- A one-shot that only reads the profile (`ghostly status`, `chat history`, `group list` and the other reads) with no daemon running no longer reads every group's whole history first, only each group's newest message. With 50,000 messages in one group, `ghostly status` now takes 0.44 s and 139 MB instead of 0.73 s and 226 MB, and `group list` 0.32 s instead of 0.77 s.
