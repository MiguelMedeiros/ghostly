---
section: Fixed / CLI
---
- `ghostly -p` and `ghostly --home` with no value say `--profile needs a value` (or `--home`), a usage error (exit 2) as `ghostly send -p` says, instead of printing the whole help with exit 0.
