---
section: Fixed / CLI
release: 1.5
---
- `ghostly x401 credential add <file>` with a file that is not there now answers `not_found` (exit 3, "No such file or folder: <path>"), and with a folder `bad_request` ("<path> is a folder: name a file"), as every other file the CLI reads. Before, both were a usage error with Node's own text.
