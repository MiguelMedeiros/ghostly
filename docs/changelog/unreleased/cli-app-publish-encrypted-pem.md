---
section: Fixed / CLI
---
- `ghostly app publish` now refuses an app folder that holds an encrypted private key in the older PEM form (`BEGIN RSA PRIVATE KEY` or `BEGIN EC PRIVATE KEY` with a `Proc-Type: 4,ENCRYPTED` line, as `openssl genrsa -aes256` writes). Before, such a key went into the published app, open to anyone who downloaded it to guess its passphrase.
