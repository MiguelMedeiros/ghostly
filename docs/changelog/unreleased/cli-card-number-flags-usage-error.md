---
section: Fixed / CLI
---
- `ghostly task send` and `task update` with `--pr-number` below 1, `--additions`, `--deletions` or `--files` below 0, a number that is not whole, or `--steps` past 1000000000, and `ghostly usage send` with `--limit` below 1, `--used` below 0 or not whole, or `--used` past `--limit`, are now a usage error (exit 2) that names the flag, before the profile opens. Before, they failed with exit 1 in the card's field names ("Status card: pr.number is a whole number from 1"), and only after the chat was found.
