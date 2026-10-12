---
section: Fixed / CLI
---
- `ghostly group join <word>` with something that is no link to a group answers `bad_request` (exit 1, "This is not a link to a group") as `ghostly invite join` does for a word that is no invite, instead of an engine error.
