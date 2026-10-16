---
section: Fixed / CLI
---
- `ghostly app publish --out ""`, `app revoke --bundle ""` and `store sign --out ""` (an unset variable in a script) are a usage error, "A path given as \"\" names no file", instead of naming the current folder.
