---
section: Fixed / CLI
---
- `ghostly profile create --name` and `ghostly profile set --name` refuse a name over 64 characters (counted as the engine counts: once cleaned, emoji as one, a line break as a space) or with nothing that shows as a usage error (exit 2) that names `--name` and the length given, as the other commands refuse a bad option value. Before, the engine refused it (`bad_request`, exit 1) as "name must be up to 64 characters on one line", naming neither the option nor the length, though a line break in `--name` is taken as a space.
