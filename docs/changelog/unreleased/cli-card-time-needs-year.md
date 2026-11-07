---
section: Fixed / CLI
---
- `--next`, `--resets` and `--also …@<time>` refuse a date with no year (`Dec 25 10:00`, `Nov 8`, `11/20`), a negative number (`-5`) and milliseconds before 2000 (`2026`, `20261120`) with a usage error (exit 2) that lists the date forms they take. Before, the card was sent dated 2001 or January 1970.
