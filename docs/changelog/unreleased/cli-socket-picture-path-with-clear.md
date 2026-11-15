---
section: Fixed / CLI
---
- Over the socket API, `group.picture` and `profile.picture` with both `path` and `clear` are now refused (`clear removes the picture: not with path`), as `ghostly group picture` and `ghostly profile picture` refuse a `<jpeg>` with `--clear`. Before, `clear` won: a script that sent both removed the picture it meant to set, with no error.
