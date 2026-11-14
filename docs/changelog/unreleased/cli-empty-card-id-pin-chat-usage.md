---
section: Fixed / CLI
---
- `ghostly task send`, `routine send` and `usage send` with an empty `--id` (an unset variable, `--id "$ID"`), `ghostly pin <chat> ""` and `ghostly payment list --chat ""` are a usage error (exit 2) before the profile opens. Before, `task send --id ""` made a new id and posted a second card where a script meant to update its own, and the other two failed late as `bad_request` (exit 1), a one-shot going online first.
