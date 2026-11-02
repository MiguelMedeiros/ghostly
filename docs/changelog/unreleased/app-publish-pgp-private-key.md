---
section: Fixed / CLI
---
- `ghostly app publish` now refuses an app folder that holds an OpenPGP private key (`BEGIN PGP PRIVATE KEY BLOCK`, as `gpg --export-secret-keys --armor` writes). Before, such a key went into the published app, open to anyone who downloaded it.
