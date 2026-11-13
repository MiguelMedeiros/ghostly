---
section: Fixed / CLI
---
- `ghostly profile backup` and `ghostly profile restore` given a passphrase on the command line (`--passphrase <secret>` or `--passphrase=<secret>`) now say it comes from `--passphrase-file` or `GHOSTLY_BACKUP_PASSPHRASE`, never the command line. Before, backup answered "Too many arguments" or "--passphrase takes no value", and restore "Unknown option --passphrase".
