---
section: Fixed / CLI
---
- `--resets`, `--next` and `--also …@<time>` refuse a day the month does not have, such as `2026-04-31` or `Feb 29 2026`, with a usage error (exit 2) that says how many days the month has. Before, the card showed the first days of the next month without a word.
