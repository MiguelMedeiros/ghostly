---
section: Fixed / CLI
---
- `profile backup --out` into a folder it may not write names the file you asked for, not a temporary `.partial-…` file that never exists, and an output name of 227 to 255 bytes, which the file system takes, is no longer refused as too long. A longer one is refused before the backup is written.
