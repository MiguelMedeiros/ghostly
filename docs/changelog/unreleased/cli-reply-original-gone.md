---
section: Fixed / CLI
---
- `ghostly chat history` and `group history` no longer say a reply's original is found, with its text, once that original is gone (deleted on this device, or deleted for everyone by its author): the reply's `replyTo` reads `found: false, deleted: true` with an empty `snippet`, as the apps show "Original message deleted".
