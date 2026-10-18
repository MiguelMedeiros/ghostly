---
section: Fixed / CLI
---
- `ghostly file save --dir <folder>` (or `--path <folder>/<name>`) with a folder that is not there names the folder (`No such file or folder: <folder>`), and a path that is a file says `<path> is a file, not a folder`. Before, it said `No such file or folder: <folder>/<name>`, as if the received file were gone.
