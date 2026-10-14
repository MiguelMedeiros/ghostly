---
section: Fixed / CLI
---
- `ghostly profile restore` of a folder says the path is a folder and asks for a file, instead of Node's "EISDIR: illegal operation on a directory, read", and `ghostly profile backup --out` into a folder that does not exist names that folder, not a temporary file you never typed.
