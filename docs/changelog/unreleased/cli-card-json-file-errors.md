---
section: Fixed / CLI
---
- `--json <file>` of `ghostly task send`, `routine send` and `usage send` (and their updates) with a file that is not there now answers `not_found` (exit 3, "No such file or folder: <path>"), with a folder `bad_request` ("<path> is a folder: name a file"), and `--json ""` is refused as naming no file. Before, a usage error with Node's own text (a folder's named no path), and `""` read the current folder.
