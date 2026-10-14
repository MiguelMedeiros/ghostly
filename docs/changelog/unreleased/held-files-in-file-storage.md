---
section: Fixed / CLI
---
- A file sent to a CLI profile while it was away (held storage) is kept as a file in the profile's folder, like every other file, not in its store: 24 held pictures of 4 MiB made the store 100 MB, held in the daemon's memory and read back at every start and command. Files that already arrived this way stay where they are.
