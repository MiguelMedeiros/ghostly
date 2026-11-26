---
section: Fixed / CLI
---
- `ghostly profile backup --out` onto a FAT or exFAT USB stick (or a network share without hard links) writes the backup. It failed with "Not allowed to write or read" and made none. A file already at that name is still never written over.
