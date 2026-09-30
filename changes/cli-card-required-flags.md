---
section: Fixed / CLI
---
- `ghostly task send` without `--title`, and `ghostly routine send` without `--name` or `--schedule`, fail as a usage error (exit 2) that names the missing flag, instead of exit 1 with "Status card: title is text".
