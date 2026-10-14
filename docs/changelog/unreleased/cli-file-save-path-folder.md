---
section: Fixed / CLI
---
- `ghostly file save --path <a folder>` says "<folder> is a folder: name a file, or use dir (--dir <folder>)" (`bad_request`), with or without `--force`, instead of asking for a `--force` that then failed. An empty `--path` or `--dir` is a usage error instead of the current folder.
