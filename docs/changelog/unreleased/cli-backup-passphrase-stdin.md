---
section: Fixed / CLI
---
- `ghostly profile backup` and `ghostly profile restore` with `--passphrase-file -` now read the passphrase from stdin, as every other secret the CLI takes does, so it can come from a password manager without touching the disk or the environment. Before, it looked for a file named `-` and answered "No such file or folder". A terminal on stdin is refused, so the passphrase is never shown as it is typed.
