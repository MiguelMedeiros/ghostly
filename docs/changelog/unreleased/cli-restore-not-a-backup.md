---
section: Fixed / CLI
---
- `ghostly profile restore` on a file that is no Ghostly backup (a wrong file, an empty download) says "This is not a Ghostly backup" at once, with or without a passphrase, instead of asking for one. A backup that is encrypted and given no passphrase now names restore's own options, not backup's `--no-passphrase`.
