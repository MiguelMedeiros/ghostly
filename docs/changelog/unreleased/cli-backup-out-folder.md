---
section: Fixed / CLI
---
- `ghostly profile backup --out` given a folder now says it names a folder and shows a file name to use in it. Before, `--out backups/` with no `backups` folder wrote the backup as a file named `backups`, and a folder that was there was answered "exists: choose another name", as if a file were in the way.
