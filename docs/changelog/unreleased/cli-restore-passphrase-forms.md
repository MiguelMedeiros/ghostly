---
section: Fixed / CLI
---
- `ghostly profile restore` opens a backup whose passphrase was read with a second line break, a carriage return, a byte order mark or as UTF-16 from a passphrase file, given the same passphrase typed or in `GHOSTLY_BACKUP_PASSPHRASE`, and the other way round (`GHOSTLY_BACKUP_PASSPHRASE="$(cat file)"` with a CRLF file). Such backups were "Wrong passphrase" unless opened with the very same file.
