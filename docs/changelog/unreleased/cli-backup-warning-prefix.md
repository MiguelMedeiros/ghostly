---
section: Fixed / CLI
---
- `ghostly profile backup --no-passphrase` now starts its "Not encrypted" warning with `ghostly: `, like every other note the CLI writes on stderr, so a log reader can tell it from other output. The JSON answer on stdout is unchanged.
