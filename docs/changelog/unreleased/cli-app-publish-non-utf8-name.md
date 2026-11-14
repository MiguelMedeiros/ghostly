---
section: Fixed / CLI
---
- `ghostly app publish` with a file or folder in the app whose name is not UTF-8 now refuses it as a bad path (`bad-path`, exit 1), as it refuses `my file.js`, instead of a false `not_found` (exit 3) for a name with `�` in it that no file has.
