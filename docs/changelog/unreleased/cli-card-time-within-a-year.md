---
section: Fixed / CLI
---
- `--resets`, `--next` and `--also …@<time>` refuse a time more than a year ahead with a usage error (exit 2) that names the flag and the last time it takes. Before, the command failed with `bad_request` (exit 1) and named the card's field in milliseconds.
