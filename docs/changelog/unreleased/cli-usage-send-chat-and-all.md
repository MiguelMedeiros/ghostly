---
section: Fixed / CLI
---
- `usage send` with both a chat and `--all` is a usage error (exit 2) before the profile opens, as giving neither is. Before, it opened the profile and failed with exit 1.
