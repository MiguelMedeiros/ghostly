---
section: Fixed / CLI
---
- `ghostly profile backup` and `profile restore` given a typo of the passphrase flag (`--pasphrase=…`) now say the passphrase comes from `--passphrase-file` or `GHOSTLY_BACKUP_PASSPHRASE`, never the command line. Before, they suggested `--passphrase`, the one form refused there.
