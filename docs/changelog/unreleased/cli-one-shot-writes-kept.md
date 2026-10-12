---
section: Fixed / CLI
---
- Without a daemon, `ghostly chat remove <chat> --yes` on a profile's only chat really removes it: it answered `{"removed":…}` and the chat, its keys and its whole history were still there for the next command. The same for `service add` on a profile with no chat, and for `chat rename`, `message delete` and the `service` commands while the relays cannot be reached: what a command answers is on disk before it leaves.
