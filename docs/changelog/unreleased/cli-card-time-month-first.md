---
section: Fixed / CLI
---
- `--resets`, `--next` and `--also …@<time>` also refuse a day the month does not have when the date is written month first (`4/31/2026`, `2/29/27`) or with the month's name between dashes, slashes or dots (`31-Apr-2026`, `Apr/31/2026`). Before, those still showed the first days of the next month.
