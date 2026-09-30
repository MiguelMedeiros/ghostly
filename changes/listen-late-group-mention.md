---
section: Fixed / Groups
---
- `ghostly listen` now reports a group mention that arrives after the message itself, as `group.mentioned` (and an agent turn with `--turns`). This happens when the message first came through another member without its mentions. Before, the bot never heard it was mentioned. It is reported once, also across restarts.
