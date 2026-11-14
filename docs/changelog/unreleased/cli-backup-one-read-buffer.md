---
section: Fixed / CLI
---
- `ghostly profile backup` reads every file of the profile into one 1 MiB buffer instead of a new one for each file: a profile with 50,000 small files took 25-38 s and about 460 MB of memory, most of it zero-filling and freeing a buffer per file. The backup file and what it restores are the same.
