---
section: Fixed / CLI
---
- Without a daemon, `ghostly edit`, `react`, `pin`, `file send`, `task send`/`update`, `routine send` and `usage send` on a chat nobody joined yet answer at once that it goes once they join, instead of waiting 30 s (a file 300 s) and failing with a timeout. With `--wait`, the timeout says it goes once the contact joins, not with the next command.
