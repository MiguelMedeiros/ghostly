---
section: For users / CLI
---
- `ghostly profile backup` writes large profiles a piece at a time, and the file appears only once it is whole. `--no-passphrase` makes a backup that is not encrypted, only when asked for by name. `profile restore` needs no passphrase for such a file and says how the file was protected.
