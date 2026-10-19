---
section: For developers / CLI
---
- `task send|update`, `routine send|update` and `usage send` refuse a wrong `--status` or `--state`, a text flag over the card's limit or blank (`--title`, `--step`, `--branch`, `--tag`, `--item`'s text, `--link`'s label, `--name`, `--schedule`, `--cron`, `--label`, `--account`, `--window`, `--also`'s window), a `--link` that is not an https link, a fifth `--link`, a fourth `--also` and a tag given twice as a usage error (exit 2) that names the flag and its limit. Before, each reached the card's own check: exit 1, `bad_request`, in the card's field words ("Status card: title is at most 120 characters") with the whole card in its details. A card given by `--json` keeps the card's words.
