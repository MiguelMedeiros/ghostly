---
section: Fixed / CLI
---
- `ghostly profile backup` says on stderr when its passphrase has more than one line (a `--passphrase-file` or stdin with notes after the first line, as `pass show` gives): every line is the passphrase, so the first line alone would not open the backup.
