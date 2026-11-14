---
section: Fixed / CLI
---
- `ghostly profile backup` refuses a passphrase that starts or ends with a space, a tab, a carriage return, a second line break or a byte order mark, or holds a NUL (a passphrase file saved as UTF-16), and names it. Only one line break at the end of `--passphrase-file` (or stdin) is left out: such a backup opened with the same file, but the same passphrase typed, pasted or set in `GHOSTLY_BACKUP_PASSPHRASE` was "Wrong passphrase". The help of `--passphrase-file` now states the rule.
