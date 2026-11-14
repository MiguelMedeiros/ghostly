---
section: Fixed / CLI
---
- Ctrl-C on `ghostly profile backup` sent through a running daemon now stops the backup in the daemon too: it said it had stopped, but the daemon went on and later wrote the whole backup file (unencrypted with `--no-passphrase`). The half-written file and the store's copy are removed, and no backup appears at `--out`.
