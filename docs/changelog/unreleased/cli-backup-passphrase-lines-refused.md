---
section: Fixed / CLI
release: 1.14
---
- `ghostly profile backup` refuses a passphrase with more than one line (a `--passphrase-file` or stdin with notes after the first line, as `pass show` gives, or `GHOSTLY_BACKUP_PASSPHRASE`) and says how many lines it has, as it already refused an extra line break at the end: the first line alone would not open the backup. It warned on stderr before.
