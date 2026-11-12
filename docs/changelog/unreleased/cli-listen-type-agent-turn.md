---
section: Fixed / CLI
---
- `ghostly listen --type agent.turn` (or `--type agent`) is now a usage error that names `--turns`. Turns come only from `--turns`, which can't be given with `--type`, so the listener printed nothing, ever, and said nothing about it.
