---
section: Fixed / CLI
---
- `ghostly file save --path downloads/` (and the socket's `file.save`) with a path that ends in a separator is refused as a folder: name a file, or use `--dir`. Before, when that folder was not there, the file was written under the folder's name with exit 0, and the next save into it failed "is a file, not a folder".
