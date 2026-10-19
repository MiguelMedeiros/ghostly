---
section: Fixed / CLI
---
- `ghostly task send`/`update`, `routine send`/`update` and `usage send` answer a wrong `--status` or `--state`, or a `--title`, `--step`, `--branch`, `--tag`, `--item`, `--link`, `--name`, `--schedule`, `--cron`, `--run` summary, `--label`, `--account`, `--window` or `--also` that is blank, too long or given too many times, as a usage error (exit 2) that names the flag and says what it takes (`--title takes at most 120 characters, not 130`), as their other flags do. Before, it was `bad_request` (exit 1) in the card's own words, with the whole card in its details. A card given with `--json` is still checked in the card's words.
