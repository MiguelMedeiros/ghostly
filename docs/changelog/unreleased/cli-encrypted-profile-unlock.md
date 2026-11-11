---
section: For users / CLI
release: 1.12
---
- An encrypted profile asks for its passphrase before the CLI opens it: the daemon takes it from `--passphrase-file` (a file, or `/dev/fd/<n>`), any command from `GHOSTLY_PROFILE_PASSPHRASE` or a prompt on a terminal, and with none of them it stops with a usage error before anything starts. `ghostly profile passphrase` changes it. A profile that is not encrypted works as before.
