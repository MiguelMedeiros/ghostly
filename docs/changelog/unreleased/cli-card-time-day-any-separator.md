---
section: Fixed / CLI
---
- `--resets`, `--next` and `--also …@<time>` also refuse a day the month does not have when the date's numbers are written with dots, spaces or commas, such as `2026.11.31` or `11 31 2026`, with a usage error (exit 2) that says how many days the month has. Before, the card showed the first day of the next month without a word.
