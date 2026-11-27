---
section: Fixed / CLI
---
- `ghostly profile backup` to a drive with no hard links (a FAT or exFAT USB stick) no longer reports a backup cut short as written when the drive fills as it is copied under its name: it writes the rest, or fails with `unavailable` ("No room left for" the backup) and leaves no file.
