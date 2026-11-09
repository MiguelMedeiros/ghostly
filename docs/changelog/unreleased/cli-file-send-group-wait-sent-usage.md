---
section: Fixed / CLI
---
- `ghostly file send <group> <path> --wait sent` is now a usage error (exit 2), as `--wait delivered` is, and says why: in a group each member's app fetches the file itself, so there is nothing to wait for. Before, it failed with exit 1 and "wait must be one of none", and the help did not say that a group takes no `--wait sent`.
