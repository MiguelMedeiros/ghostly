---
section: Fixed / CLI
---
- `ghostly profile restore … --use` now says the restored profile became the current one (`"current": true`), as `profile create --use` does. Before, its answer had no `current`, so a script could not tell whether `--use` took effect without running `profile list`.
