---
section: Fixed / CLI
---
- `ghostly invite join … --label <name>` run without a daemon, when the inviter is offline, now suggests `ghostly chat wait <chat> --until paired` with the chat's id when another chat already has that label. Before, joining a second time with the same label (a new invite after one that never paired) suggested `ghostly chat wait <name> --until paired`, which answered that the name names more than one chat.
