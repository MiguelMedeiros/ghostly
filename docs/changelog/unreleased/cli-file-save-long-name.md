---
section: For developers / CLI
---
- `ghostly file save --dir` saves a file whose name is over 255 bytes (86 Chinese characters or 64 emoji are enough, and the contact picks the name) under a shortened name that keeps its extension; before, it failed every time with `engine` and Node's `ENAMETOOLONG`. A `--path` that long is a `bad_request` saying so.
